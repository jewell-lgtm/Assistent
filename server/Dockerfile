FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --workspace @assistant/server
COPY server server
ENV NODE_ENV=production
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
EXPOSE 8080
CMD ["npx", "tsx", "server/src/main.ts"]
