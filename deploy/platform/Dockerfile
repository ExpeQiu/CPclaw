# CPclaw 控制面：仅 contracts + platform。构建上下文为仓库根。
# 基镜像用验证机已缓存的 node:22-bookworm-slim，避免公网拉 Docker Hub。
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/contracts/src packages/contracts/src
COPY packages/platform/package.json packages/platform/package.json
COPY packages/platform/tsconfig.json packages/platform/tsconfig.json
COPY packages/platform/src packages/platform/src
COPY scripts/platform-host.mjs scripts/platform-host.mjs

# 瘦身 workspace：不装 desktop/electron，不依赖仓库根全量 lock。
RUN printf '%s\n' \
  '{' \
  '  "name": "cpclaw-platform-image",' \
  '  "private": true,' \
  '  "type": "module",' \
  '  "packageManager": "pnpm@9.0.0",' \
  '  "dependencies": { "@cpclaw/platform": "workspace:*" }' \
  '}' > package.json \
  && printf '%s\n' 'packages:' '- "packages/contracts"' '- "packages/platform"' > pnpm-workspace.yaml \
  && pnpm install \
  && pnpm --filter @cpclaw/contracts run build \
  && pnpm --filter @cpclaw/platform run build

FROM ${NODE_IMAGE} AS runtime
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

COPY --from=build /app /app

ENV AI_MOCK_MODE=true \
    CPCLAW_DATA_DIR=/data \
    CPCLAW_PLATFORM_PORT=3928 \
    CPCLAW_LISTEN_HOST=0.0.0.0

RUN mkdir -p /data/logs \
  && useradd --system --uid 10001 --home /data cpclaw \
  && chown -R cpclaw:cpclaw /data /app

USER cpclaw
EXPOSE 3928
VOLUME ["/data"]

CMD ["node", "scripts/platform-host.mjs"]
