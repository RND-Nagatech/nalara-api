FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node assets/report-fonts ./assets/report-fonts
COPY --chown=node:node assets/nalara_avatar_assets ./assets/nalara_avatar_assets
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 3100
CMD ["node", "dist/main.js"]
