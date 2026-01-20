import { Octokit } from "@octokit/rest";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";
import { z } from "zod";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const Env = z.object({
  // OpenAI
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default("gpt-5-codex"),

  // GitHub target
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPO: z.string().min(1),

  // GitHub App auth
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_INSTALLATION_ID: z.string().min(1),
  // Private key PEM: puoi passarlo come base64 in env oppure montare un file e settare GITHUB_PRIVATE_KEY_PATH
  GITHUB_PRIVATE_KEY_BASE64: z.string().optional(),
  GITHUB_PRIVATE_KEY_PATH: z.string().optional(),

  // Issue selection
  ISSUE_LABEL: z.string().default("agent"),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),

  // Git
  DEFAULT_BASE_BRANCH: z.string().default("main"),

  // Workspace
  WORKDIR: z.string().default("/work"),

  // Optional: repo clone URL (https). Se non specificato costruisce da owner/repo
  REPO_CLONE_URL: z.string().optional()
});

type ToolCall =
  | { name: "read_file"; args: { file: string } }
  | { name: "write_file"; args: { file: string; content: string } }
  | { name: "list_files"; args: { dir: string } }
  | { name: "run"; args: { cmd: string; cwd?: string } };

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function getPrivateKeyPem(env: z.infer<typeof Env>): string {
  if (env.GITHUB_PRIVATE_KEY_PATH) {
    return fs.readFileSync(env.GITHUB_PRIVATE_KEY_PATH, "utf8");
  }
  if (env.GITHUB_PRIVATE_KEY_BASE64) {
    return Buffer.from(env.GITHUB_PRIVATE_KEY_BASE64, "base64").toString("utf8");
  }
  die("Missing GitHub App private key. Provide GITHUB_PRIVATE_KEY_PATH or GITHUB_PRIVATE_KEY_BASE64.");
}

async function getInstallationOctokit(env: z.infer<typeof Env>): Promise<Octokit> {
  const pem = getPrivateKeyPem(env);

  // JWT for GitHub App (RS256) :contentReference[oaicite:2]{index=2}
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { iat: now - 30, exp: now + 9 * 60, iss: env.GITHUB_APP_ID },
    pem,
    { algorithm: "RS256" }
  );

  // Exchange for installation access token :contentReference[oaicite:3]{index=3}
  const appOctokit = new Octokit({ auth: token });
  const { data } = await appOctokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    { installation_id: Number(env.GITHUB_INSTALLATION_ID) }
  );

  return new Octokit({ auth: data.token });
}

function safeRun(cmd: string, cwd: string): { ok: boolean; stdout: string; stderr: string; code: number } {
  // Guard rails molto basilari (puoi irrigidire quanto vuoi)
  const forbidden = [
    "rm -rf /", "mkfs", "dd if=", ":(){", "shutdown", "reboot", "chmod -R 777 /"
  ];
  if (forbidden.some(f => cmd.includes(f))) {
    return { ok: false, stdout: "", stderr: `Forbidden command pattern: ${cmd}`, code: 126 };
  }
  const p = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return { ok: p.status === 0, stdout: p.stdout ?? "", stderr: p.stderr ?? "", code: p.status ?? 1 };
}

function detectStack(repoDir: string) {
  const has = (p: string) => fs.existsSync(path.join(repoDir, p));
  const isBun = has("bun.lockb");
  const isNode = has("package.json");
  const isPython = has("pyproject.toml") || has("requirements.txt");
  const isDotnet = fs.readdirSync(repoDir).some(f => f.endsWith(".sln")) || fs.readdirSync(repoDir).some(f => f.endsWith(".csproj"));

  // default test/build commands (heuristics)
  const commands: string[] = [];
  if (isBun) commands.push("bun install", "bun test || true", "bun run build || true");
  else if (isNode) commands.push("npm ci || npm install", "npm test || true", "npm run build || true");
  if (isPython) commands.push("python3 -m pip install -r requirements.txt || true", "pytest -q || true");
  if (isDotnet) commands.push("dotnet test || true", "dotnet build || true");

  return { isBun, isNode, isPython, isDotnet, commands };
}

async function openaiLoop(env: z.infer<typeof Env>, repoDir: string, issue: { number: number; title: string; body: string }) {
  const tools = [
    {
      type: "function",
      name: "list_files",
      description: "List files and folders in a directory (non-recursive).",
      parameters: {
        type: "object",
        properties: { dir: { type: "string" } },
        required: ["dir"]
      }
    },
    {
      type: "function",
      name: "read_file",
      description: "Read a UTF-8 text file from the repo.",
      parameters: {
        type: "object",
        properties: { file: { type: "string" } },
        required: ["file"]
      }
    },
    {
      type: "function",
      name: "write_file",
      description: "Write a UTF-8 text file into the repo (overwrite).",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string" },
          content: { type: "string" }
        },
        required: ["file", "content"]
      }
    },
    {
      type: "function",
      name: "run",
      description: "Run a shell command inside the repo directory. Use for tests, formatting, building, etc.",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          cwd: { type: "string" }
        },
        required: ["cmd"]
      }
    }
  ];

  const stack = detectStack(repoDir);

  const system = `
You are a senior software engineering agent.
Goal: implement the GitHub Issue in the checked-out repository.

Rules:
- Prefer minimal, correct changes.
- Before changing code, inspect the repo structure.
- Use the provided tools to read/write files and run tests.
- Always run relevant tests/build commands (best effort).
- Produce a concise PR description at the end (title + bullet summary + test evidence).
- If requirements are unclear, make a reasonable assumption and document it in PR notes.
`.trim();

  const user = `
Issue #${issue.number}: ${issue.title}

${issue.body ?? ""}

Repo stack hints:
- bun: ${stack.isBun}
- node: ${stack.isNode}
- python: ${stack.isPython}
- dotnet: ${stack.isDotnet}

Suggested commands (best-effort):
${stack.commands.map(c => `- ${c}`).join("\n")}
`.trim();

  // Responses API loop with tool calling :contentReference[oaicite:4]{index=4}
  let messages: any[] = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  for (let step = 0; step < 30; step++) {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        input: messages,
        tools,
        // puoi aumentare reasoning_effort se vuoi più “thinking”
        reasoning: { effort: "medium" }
      })
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`OpenAI error: ${resp.status} ${txt}`);
    }

    const data: any = await resp.json();

    // Estraggo tool calls (formato può variare per SDK; qui gestiamo output generico)
    const output = data.output ?? [];
    const toolCalls = output
      .filter((o: any) => o.type === "function_call")
      .map((o: any) => ({ name: o.name, args: o.arguments }));

    const finalText = output
      .filter((o: any) => o.type === "message")
      .flatMap((o: any) => o.content ?? [])
      .filter((c: any) => c.type === "output_text")
      .map((c: any) => c.text)
      .join("\n");

    if (toolCalls.length === 0) {
      // Done
      return { finalText };
    }

    // execute tool calls
    for (const tc of toolCalls) {
      let result: any = null;

      if (tc.name === "list_files") {
        const dir = String(tc.args.dir ?? ".");
        const abs = path.join(repoDir, dir);
        const items = fs.readdirSync(abs, { withFileTypes: true }).map(d => ({
          name: d.name,
          type: d.isDirectory() ? "dir" : "file"
        }));
        result = { dir, items };
      }

      if (tc.name === "read_file") {
        const file = String(tc.args.file);
        const abs = path.join(repoDir, file);
        result = { file, content: fs.readFileSync(abs, "utf8") };
      }

      if (tc.name === "write_file") {
        const file = String(tc.args.file);
        const content = String(tc.args.content ?? "");
        const abs = path.join(repoDir, file);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
        result = { file, bytes: Buffer.byteLength(content, "utf8") };
      }

      if (tc.name === "run") {
        const cmd = String(tc.args.cmd);
        const r = safeRun(cmd, repoDir);
        result = { cmd, ok: r.ok, code: r.code, stdout: r.stdout.slice(0, 12000), stderr: r.stderr.slice(0, 12000) };
      }

      messages.push({
        role: "tool",
        name: tc.name,
        content: JSON.stringify(result)
      });
    }

    // also attach any assistant text (if present)
    if (finalText.trim()) {
      messages.push({ role: "assistant", content: finalText });
    }
  }

  throw new Error("OpenAI loop exceeded max steps.");
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
}

async function main() {
  const env = Env.parse(process.env);
  const octokit = await getInstallationOctokit(env);

  const cloneUrl = env.REPO_CLONE_URL ?? `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}.git`;
  const workRoot = env.WORKDIR;
  fs.mkdirSync(workRoot, { recursive: true });

  console.log(`Agent started. Watching ${env.GITHUB_OWNER}/${env.GITHUB_REPO} label=${env.ISSUE_LABEL}`);

  while (true) {
    // Pick oldest open issue with label (simple strategy)
    const issues = await octokit.issues.listForRepo({
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      state: "open",
      labels: env.ISSUE_LABEL,
      per_page: 10,
      sort: "created",
      direction: "asc"
    });

    const issue = issues.data.find(i => !i.pull_request);
    if (!issue) {
      console.log("No matching issues. Sleeping...");
      await new Promise(r => setTimeout(r, env.POLL_INTERVAL_SECONDS * 1000));
      continue;
    }

    const issueNumber = issue.number;
    const issueTitle = issue.title ?? `issue-${issueNumber}`;
    const issueBody = issue.body ?? "";

    const repoDir = path.join(workRoot, `${env.GITHUB_REPO}-${issueNumber}`);
    fs.rmSync(repoDir, { recursive: true, force: true });

    console.log(`Working on issue #${issueNumber}: ${issueTitle}`);

    // clone
    const r1 = safeRun(`git clone ${cloneUrl} ${repoDir}`, workRoot);
    if (!r1.ok) die(`git clone failed: ${r1.stderr}`);

    // base branch
    safeRun(`git checkout ${env.DEFAULT_BASE_BRANCH}`, repoDir);

    const branch = `agent/issue-${issueNumber}-${slug(issueTitle)}`;
    safeRun(`git checkout -b ${branch}`, repoDir);

    // Run agent loop (edit files + tests)
    const { finalText } = await openaiLoop(env, repoDir, { number: issueNumber, title: issueTitle, body: issueBody });

    // git status
    const st = safeRun("git status --porcelain", repoDir);
    if (!st.stdout.trim()) {
      console.log("No changes produced. Commenting on issue and skipping.");
      await octokit.issues.createComment({
        owner: env.GITHUB_OWNER,
        repo: env.GITHUB_REPO,
        issue_number: issueNumber,
        body: `I couldn't produce any changes for this issue.\n\nModel notes:\n${finalText}`.slice(0, 65000)
      });
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    safeRun(`git add -A`, repoDir);
    safeRun(`git commit -m "Fix: #${issueNumber} ${issueTitle.replace(/"/g, '\\"')}"`, repoDir);

    // push (GitHub App installation token must have contents:write)
    const push = safeRun(`git push -u origin ${branch}`, repoDir);
    if (!push.ok) die(`git push failed: ${push.stderr}`);

    // open PR :contentReference[oaicite:5]{index=5}
    const pr = await octokit.pulls.create({
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      title: `#${issueNumber} ${issueTitle}`,
      head: branch,
      base: env.DEFAULT_BASE_BRANCH,
      body: `${finalText}\n\nCloses #${issueNumber}`.slice(0, 65000)
    });

    // comment + remove label (optional)
    await octokit.issues.createComment({
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      issue_number: issueNumber,
      body: `Opened PR: ${pr.data.html_url}\n\n${finalText}`.slice(0, 65000)
    });

    console.log(`PR opened: ${pr.data.html_url}`);
    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
