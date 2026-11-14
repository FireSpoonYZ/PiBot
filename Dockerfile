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
# Bot learning runs Python only in the Center. Bookworm provides Python 3.11
# for center-server/learning-engine/vendor/. Set PIBOT_LEARNING_PYTHON to
# select an interpreter explicitly; the default is python3.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
# Official Bitwarden CLI for the Vaultwarden adapter
# (center-server/vaultwarden-client.js): pinned version, pure-JS package with no
# native optional deps so amd64 and arm64 builds work identically. Installed
# into its own prefix; center-server/host-core lockfiles stay untouched.
# The adapter spawns it only on the container loopback via `bw serve`.
ARG BW_CLI_VERSION=2026.10.1
RUN mkdir -p /opt/bitwarden-cli && cd /opt/bitwarden-cli \
    && npm init -y >/dev/null \
    && npm install --omit=dev --ignore-scripts --no-audit --no-fund --save-exact "@bitwarden/cli@${BW_CLI_VERSION}" \
    && ln -s /opt/bitwarden-cli/node_modules/.bin/bw /usr/local/bin/bw
# Optional Antigravity CLI (agy) for the Center-only Antigravity ACP provider.
# Off by default so standard Center images do not bundle or download it.
# Build with `--build-arg INSTALL_AGY=true`, or bind-mount a verified host binary
# read-only at /usr/local/bin/agy. URLs and SHA-512 checksums match the official
# Linux manifests (https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_{amd64,arm64}.json).
ARG INSTALL_AGY=false
ARG AGY_VERSION=1.5.9
ARG AGY_AMD64_URL=https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.9-4515810895593472/linux-x64/cli_linux_x64.tar.gz
ARG AGY_AMD64_SHA512=d01eb13ba7750eed18907f1ae8860864371e0ad9064415e8d033d22b4bd7b9b4e4c7f962058520b452d67db1c33163d9a889d55a7dffa159596ec6cd91a87b79
ARG AGY_ARM64_URL=https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.9-4515810895593472/linux-arm/cli_linux_arm64.tar.gz
ARG AGY_ARM64_SHA512=16c632a09b81f598f7652bc11180861f9d2ee4408ffa161dadc83b2010de7a9cd055e97b4b46cd01903e35c0e8bf21d8262462ba7c5f168cc6dada9ac3d522c0
RUN if [ "$INSTALL_AGY" = "true" ]; then \
      arch="$(dpkg --print-architecture)"; \
      case "$arch" in \
        amd64) agy_url="$AGY_AMD64_URL"; agy_sha512="$AGY_AMD64_SHA512" ;; \
        arm64) agy_url="$AGY_ARM64_URL"; agy_sha512="$AGY_ARM64_SHA512" ;; \
        *) echo "Unsupported architecture for INSTALL_AGY: $arch" >&2; exit 1 ;; \
      esac; \
      case "$agy_url" in \
        *"/${AGY_VERSION}-"*) ;; \
        *) echo "AGY_URL does not match pinned AGY_VERSION=${AGY_VERSION}" >&2; exit 1 ;; \
      esac; \
      curl -fsSL --connect-timeout 20 --max-time 300 -o /tmp/agy.tar.gz "$agy_url" \
      && echo "${agy_sha512}  /tmp/agy.tar.gz" | sha512sum -c - \
      && tar -xzf /tmp/agy.tar.gz -C /tmp antigravity \
      && mv /tmp/antigravity /usr/local/bin/agy \
      && chmod 0755 /usr/local/bin/agy \
      && rm -f /tmp/agy.tar.gz; \
    fi
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
