FROM node:24.21.0-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@10.33.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY --chown=node:node . .

FROM base AS build
RUN pnpm build
RUN pnpm agent:bundle

FROM node:24.21.0-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /app/evidence/disputes ./evidence/disputes
# The record check reads the synthetic claims register at run start; .dockerignore keeps the development cases out.
COPY --from=build --chown=node:node /app/evidence/registers ./evidence/registers
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM base AS worker
ENV NODE_ENV=production
USER node
CMD ["pnpm", "db:migrate"]

FROM node:24.21.0-bookworm-slim AS live-worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/dist/live-worker.mjs ./live-worker.mjs
# The photo examiner re-reads pinned photo files from the dispute folders; .dockerignore keeps every expected/ folder out.
COPY --from=build --chown=node:node /app/evidence/disputes ./evidence/disputes
# Outside lookups (AD-14): the worker makes every outside call, so it holds the OneMap saved copy that answers once the live token is refused.
COPY --from=build --chown=node:node /app/evidence/registers/onemap-places.json ./evidence/registers/onemap-places.json
USER node
CMD ["node", "live-worker.mjs"]

FROM node:24.21.0-bookworm-slim AS model-gateway
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/dist/model-gateway.mjs ./model-gateway.mjs
USER node
EXPOSE 8787
CMD ["node", "model-gateway.mjs"]
