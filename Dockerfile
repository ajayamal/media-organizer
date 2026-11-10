FROM node:22-bookworm-slim AS web-build
WORKDIR /build/web
COPY web/package*.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS server-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /build/server
COPY server/package*.json ./
RUN npm install --no-audit --no-fund
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3100 MEDIA_ROOT=/media DATA_DIR=/app/data
WORKDIR /app
COPY --from=server-build /build/server/package*.json ./
COPY --from=server-build /build/server/node_modules ./node_modules
COPY --from=server-build /build/server/dist ./dist
COPY --from=web-build /build/web/dist ./public
RUN mkdir -p /app/data /media && chown -R node:node /app
USER node
EXPOSE 3100
CMD ["node","dist/index.js"]
