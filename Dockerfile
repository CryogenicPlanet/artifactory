# Local development image. See docs/deployment.md for the isolation gap.
FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS build
WORKDIR /opt/comms
COPY package.json bun.lock ./
COPY packages/boot/package.json packages/boot/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json tsconfig.json ./
COPY packages/boot packages/boot
COPY packages/server packages/server
COPY packages/ui packages/ui
RUN bun run build

FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS dependencies
WORKDIR /opt/comms
COPY package.json bun.lock ./
COPY packages/boot/package.json packages/boot/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN bun install --production --frozen-lockfile --ignore-scripts
# Resolve workspace imports to immutable compiled entries, not absent src trees.
RUN sed -i 's|./src/index.ts|./dist/index.js|' packages/boot/package.json \
    && sed -i 's|./src/start.ts|./dist/start.js|' packages/server/package.json

FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS runtime
WORKDIR /opt/comms
COPY --from=dependencies /opt/comms /opt/comms
COPY --from=build /opt/comms/packages/boot/dist packages/boot/dist
COPY --from=build /opt/comms/packages/server/dist packages/server/dist
COPY --from=build /opt/comms/packages/server/pages packages/server/pages
RUN mkdir /data && chown 1000:1000 /data && chmod 0700 /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
USER 1000:1000
VOLUME ["/data"]
EXPOSE 8080
CMD ["bun", "packages/server/dist/main.js"]
