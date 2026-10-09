# Skeleton agent image. Secrets are NOT baked in: RETO_KEY is injected at
# runtime by docker-compose (env_file: .env), and .env is in .dockerignore.
FROM node:22-slim

ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Enable pnpm via corepack (as root: writes shims to /usr/local/bin)
RUN corepack enable \
    && mkdir -p /app/logs \
    && chown -R node:node /app

WORKDIR /app

# Install and run as the same unprivileged user. pnpm checks dependencies
# before `pnpm exec` (verifyDepsBeforeRun); installing as root and running as
# "node" makes it see a different store and try to rebuild node_modules.
USER node

# Pre-download the exact pnpm version pinned in package.json
COPY --chown=node:node package.json ./
RUN corepack install

# Dependencies first (cached layer). pnpm-workspace.yaml holds `allowBuilds`
# so esbuild's postinstall runs (tsx needs it).
COPY --chown=node:node pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Source code
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src

CMD ["pnpm", "exec", "tsx", "src/index.ts"]
