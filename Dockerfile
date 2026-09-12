# Immutable launcher and fixed privileged keepers; editable children use separate UIDs.
FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS build
WORKDIR /opt/comms
COPY package.json bun.lock ./
COPY patches ./patches
COPY packages/boot/package.json packages/boot/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json tsconfig.json ./
COPY packages/boot packages/boot
COPY packages/protocol packages/protocol
COPY packages/server packages/server
COPY packages/ui packages/ui
RUN bun run build

FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS dependencies
WORKDIR /opt/comms
COPY package.json bun.lock ./
COPY patches ./patches
COPY packages/boot/package.json packages/boot/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN bun install --production --frozen-lockfile --ignore-scripts
# Protocol is pure TypeScript; Bun resolves its source exports in the immutable image.
COPY packages/protocol/src packages/protocol/src
# Resolve workspace imports to immutable compiled entries, not absent src trees.
RUN sed -i 's|./src/index.ts|./dist/index.js|' packages/boot/package.json \
    && sed -i 's|./src/start.ts|./dist/start.js|' packages/server/package.json

FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS runtime
USER 0:0
WORKDIR /opt/comms
COPY --from=dependencies /opt/comms /opt/comms
COPY --from=build /opt/comms/packages/boot/dist packages/boot/dist
COPY --from=build /opt/comms/packages/server/dist packages/server/dist
COPY --from=build /opt/comms/packages/server/pages packages/server/pages
RUN apt-get update && apt-get install -y --no-install-recommends sudo util-linux tini \
    && rm -rf /var/lib/apt/lists/* \
    && usermod --login boot bun \
    && groupadd --gid 1003 comms \
    && useradd --uid 1001 --no-create-home --shell /usr/sbin/nologin app \
    && useradd --uid 1002 --no-create-home --shell /usr/sbin/nologin build \
    && usermod --append --groups comms boot \
    && mkdir /data
COPY deployment /opt/comms/deployment
RUN chmod 0755 /opt/comms/deployment/entrypoint /opt/comms/deployment/child-keeper /opt/comms/deployment/preparation-keeper \
    && cp /opt/comms/deployment/sudoers /etc/sudoers.d/comms \
    && chmod 0440 /etc/sudoers.d/comms \
    && visudo --check
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data COMMS_ISOLATED=true
USER 0:0
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/comms/deployment/entrypoint"]
