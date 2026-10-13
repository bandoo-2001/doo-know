FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts ./
COPY server ./server
COPY shared ./shared
COPY web ./web
RUN npm run build && npm prune --omit=dev
FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3010
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3010
CMD ["node","dist/server/server/main.js"]
