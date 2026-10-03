FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /opt/passhub
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime
ENV NODE_ENV=production
WORKDIR /opt/passhub
COPY --from=build --chown=node:node /opt/passhub/package.json /opt/passhub/package-lock.json ./
COPY --from=build --chown=node:node /opt/passhub/node_modules ./node_modules
COPY --from=build --chown=node:node /opt/passhub/dist ./dist
USER node
CMD ["node", "dist/src/deployment/production-main.js"]
