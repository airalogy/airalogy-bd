FROM ghcr.io/astral-sh/uv:0.12.4@sha256:d0a6eca6c669dc7e9c51218707b8438a3d30402733d739dcc00adb3e213e8f5c AS uv
FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS build
COPY --from=uv /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-dev build-essential git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
ENV NEXT_TELEMETRY_DISABLED=1 UV_PYTHON_DOWNLOADS=never BD_CACHE_DIR=/opt/bd/.uv-cache BD_RUNTIME_DIRECTORY=/opt/bd/runtime
WORKDIR /opt/bd
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY docs/licensing.md docs/dependency-licenses.json ./docs/
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN pnpm install --frozen-lockfile --registry="$NPM_REGISTRY" --fetch-timeout=300000
COPY bin ./bin
COPY scripts ./scripts
COPY dashboard ./dashboard
COPY fixtures/demo/content ./fixtures/demo/content
ARG BD_VERSION
RUN node -e "const v=require('./package.json').version;if(process.env.BD_VERSION && process.env.BD_VERSION!==v)throw new Error('Image version differs from package.json')"
RUN uv sync --script scripts/workspace_service.py --cache-dir /opt/bd/.uv-cache --locked && uv sync --script scripts/validate.py --cache-dir /opt/bd/.uv-cache --locked && uv sync --script scripts/generate_dashboard_data.py --cache-dir /opt/bd/.uv-cache --locked && uv sync --script scripts/oss_backup.py --cache-dir /opt/bd/.uv-cache --locked
RUN node bin/bd.mjs build --content fixtures/demo/content

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS runtime
ARG BD_VERSION
ARG BD_REVISION
LABEL org.opencontainers.image.title="Airalogy BD" \
      org.opencontainers.image.source="https://github.com/airalogy/airalogy-bd" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${BD_VERSION}" \
      org.opencontainers.image.revision="${BD_REVISION}"
RUN apt-get update && apt-get install -y --no-install-recommends python3 git ca-certificates && rm -rf /var/lib/apt/lists/* && groupadd -g 10001 bd && useradd -u 10001 -g bd -m bd && mkdir /workspace /backups && chown bd:bd /workspace /backups
COPY --from=build /usr/local/bin/uv /usr/local/bin/uv
COPY --from=build --chown=10001:10001 /opt/bd /opt/bd
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 UV_PYTHON_DOWNLOADS=never UV_OFFLINE=1 BD_MODE=server BD_CACHE_DIR=/opt/bd/.uv-cache BD_RUNTIME_DIRECTORY=/opt/bd/runtime
WORKDIR /workspace
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/bd/bin/bd.mjs"]
CMD ["start", "--hostname", "0.0.0.0", "--port", "3000"]
