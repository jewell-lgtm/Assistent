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
ENV NODE_ENV=production
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
EXPOSE 8080
CMD ["pnpm", "--filter", "@assistant/server", "start"]
