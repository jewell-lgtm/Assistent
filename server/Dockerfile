FROM node:22-alpine AS pruner
RUN npm install -g pnpm@10.20.0 turbo@2
WORKDIR /app
COPY . .
RUN turbo prune @assistant/server --docker

FROM node:22-alpine
RUN apk add --no-cache git ripgrep && npm install -g pnpm@10.20.0
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
COPY scripts/gen-userspace.mjs scripts/
COPY scripts/bootstrap-userspace.mjs scripts/
COPY scripts/uscheck scripts/uscheck
# live userspace is hostPath-mounted at /repo in the pod — bridge it into the
# image path the generated registry imports (../../userspace). Dangling at
# build time (gen then emits empty registries → fresh clone still boots);
# regenerated at boot so the pod sees whatever Pi has written to /repo/userspace.
RUN ln -s /repo/userspace ./userspace && node scripts/gen-userspace.mjs
ENV NODE_ENV=production
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
# userspace has no node_modules of its own; its files load through the
# ./userspace symlink so Node's default realpath-based resolution walks up
# from /repo (no deps there) instead of /app (hoisted deps) — preserve the
# symlink path so upward node_modules lookup finds /app/node_modules.
ENV NODE_OPTIONS=--preserve-symlinks
EXPOSE 8080
CMD ["sh", "-c", "node scripts/bootstrap-userspace.mjs && node scripts/gen-userspace.mjs && exec pnpm --filter @assistant/server start"]
