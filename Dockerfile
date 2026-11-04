# syntax=docker/dockerfile:1
FROM node:22-bookworm AS build
WORKDIR /app
COPY center-contract/ center-contract/
COPY center-web/ center-web/
RUN npm ci --prefix center-web && npm run --prefix center-web build
COPY center-server/ center-server/
COPY host-core/ host-core/
# The six @earendil-works deps are file:../build/pi-main/<tgz> built from the
# pinned upstream SHA (scripts/pi-main.json); .dockerignore excludes build/,
# so generate them inside the builder before installing either manifest.
COPY scripts/pi-main.json scripts/pi-main.json
COPY scripts/prepare-pi-main.mjs scripts/prepare-pi-main.mjs
RUN node scripts/prepare-pi-main.mjs
RUN npm ci --prefix center-server --omit=dev
RUN npm ci --prefix host-core --omit=dev

FROM node:22-bookworm
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/center-contract/ ./center-contract/
COPY --from=build --chown=node:node /app/center-server/ ./center-server/
COPY --from=build --chown=node:node /app/center-web/ ./center-web/
COPY --from=build --chown=node:node /app/host-core/ ./host-core/
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node licenses/ ./licenses/
COPY --chown=node:node plugins/ ./plugins/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8443 8790
CMD ["node", "center-server/cli.js"]
