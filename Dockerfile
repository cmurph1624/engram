# Engram MCP server on Node 22.
# TypeScript, so this builds in-image: npm ci (with dev deps) -> tsc -> prune.
FROM node:22-slim

WORKDIR /app

# Full install: tsc/tsx are devDependencies and the build needs them. --include=dev
# is explicit because the base image sets NODE_ENV=production, which would
# otherwise make npm ci skip them and fail the build at `tsc: not found`.
COPY package*.json ./
RUN npm ci --include=dev

COPY . .

# `npm run build` runs tsc AND copies src/migrations -> dist/migrations, which
# migrate() reads on boot. Then drop the toolchain from the image.
RUN npm run build && npm prune --omit=dev

# config.json is gitignored and bind-mounted at runtime (it holds auth_token and
# the db password), so it is deliberately NOT baked into the image.
EXPOSE 3456
CMD ["node", "dist/server.js"]
