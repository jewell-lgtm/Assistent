FROM node:22-alpine
RUN apk add --no-cache git ripgrep && npm install -g pnpm@10.20.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
RUN pnpm install --frozen-lockfile --filter @assistant/server
COPY server server
ENV NODE_ENV=production
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
EXPOSE 8080
CMD ["pnpm", "--filter", "@assistant/server", "start"]
