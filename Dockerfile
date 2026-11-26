FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@9.15.5
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/database-readiness/package.json ./packages/database-readiness/package.json
COPY packages/enterprise-ai/package.json ./packages/enterprise-ai/package.json
COPY packages/object-storage/package.json ./packages/object-storage/package.json
COPY packages/resume-intelligence/package.json ./packages/resume-intelligence/package.json
COPY packages/runtime-lifecycle/package.json ./packages/runtime-lifecycle/package.json
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
COPY web ./web
COPY scripts/runtime-origin-check.mjs scripts/serve-web-production.mjs ./scripts/
RUN pnpm --filter @smartrecruit-pro/contracts build && pnpm --filter @smartrecruit-pro/object-storage build && pnpm --filter @smartrecruit-pro/resume-intelligence build && pnpm --filter @smartrecruit-pro/enterprise-ai build && pnpm --filter @smartrecruit-pro/api build:production && pnpm --filter @smartrecruit-pro/worker build:production && pnpm --dir web build
RUN node --input-type=module -e "import { verifyReleaseOriginPolicy } from './scripts/runtime-origin-check.mjs'; console.log(JSON.stringify(await verifyReleaseOriginPolicy(process.cwd())))"

FROM node:22-bookworm-slim AS backend
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/* && install -d -o node -g node /var/lib/smartrecruit/objects
WORKDIR /app
COPY --from=build /app /app
COPY db/migrations ./db/migrations
COPY scripts/migrate-postgres.mjs ./scripts/migrate-postgres.mjs
COPY scripts/runtime-config.mjs scripts/container-backend.mjs ./scripts/
ENV NODE_ENV=production SMARTRECRUIT_MANAGED_ENV=1
USER node
EXPOSE 3100 4001
CMD ["node", "--import", "./scripts/container-backend.mjs", "apps/api/dist/src/index.js"]

FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY --from=build /app/web/dist ./web/dist
COPY scripts/serve-web-production.mjs ./scripts/serve-web-production.mjs
ENV NODE_ENV=production WEB_HOST=0.0.0.0 WEB_PORT=5174 WEB_API_TARGET=http://api:3100
USER node
EXPOSE 5174
CMD ["node", "scripts/serve-web-production.mjs"]
