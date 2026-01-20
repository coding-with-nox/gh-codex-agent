# syntax=docker/dockerfile:1
FROM oven/bun:1.1.38

# Tools: git, openssh-client, ca-certificates (per https), python3 per alcuni toolchain, jq per debug
RUN apt-get update && apt-get install -y --no-install-recommends \
  git openssh-client ca-certificates python3 jq \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dipendenze
COPY package.json bun.lockb* /app/
RUN bun install --frozen-lockfile || bun install

# Codice
COPY src /app/src

ENV NODE_ENV=production
ENV WORKDIR=/work
ENV POLL_INTERVAL_SECONDS=60
ENV ISSUE_LABEL=agent
ENV OPENAI_MODEL=gpt-5-codex

# Sicurezza minima: non serve root per operare su /work,
# ma qui lasciamo default; se vuoi, puoi aggiungere un user non-root.
CMD ["bun", "run", "src/main.ts"]