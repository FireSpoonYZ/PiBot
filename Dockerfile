# syntax=docker/dockerfile:1
FROM node:26.13.0-bookworm AS build
WORKDIR /app
COPY center-contract/ center-contract/
COPY center-web/ center-web/
RUN npm ci --prefix center-web && npm run --prefix center-web build
COPY center-server/ center-server/
COPY host-core/ host-core/
RUN npm ci --prefix center-server --omit=dev
RUN npm ci --prefix host-core --omit=dev
COPY plugins/ plugins/
COPY scripts/prepare-builtin-plugins.mjs scripts/prepare-builtin-plugins.mjs
RUN node scripts/prepare-builtin-plugins.mjs

FROM node:26.13.0-bookworm
LABEL org.opencontainers.image.source="https://github.com/FireSpoonYZ/PiBot"
# Python runs only at the center, for the vendored Hermes learning modules
# (center-server/hermes/vendor/, requires-python >=3.11,<3.15). bookworm ships
# python3.11; the Node adapter launches it via env HERMES_PYTHON (default
# python3). No Python is installed or needed on Android.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/center-contract/ ./center-contract/
COPY --from=build --chown=node:node /app/center-server/ ./center-server/
COPY --from=build --chown=node:node /app/center-web/ ./center-web/
COPY --from=build --chown=node:node /app/host-core/ ./host-core/
COPY --from=build --chown=node:node /app/build/builtin-plugins/ ./build/builtin-plugins/
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node licenses/ ./licenses/
COPY --chown=node:node plugins/ ./plugins/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "center-server/cli.js"]
