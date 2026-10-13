FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build
WORKDIR /build
COPY deployment/browser-build/package.json deployment/browser-build/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY packages/core/src ./packages/core/src
COPY packages/worker/src ./packages/worker/src
COPY packages/matrixrtc/src ./packages/matrixrtc/src
COPY packages/browser-worker/src ./packages/browser-worker/src
COPY packages/voice/src ./packages/voice/src
COPY packages/agent-http/src ./packages/agent-http/src
COPY packages/speech-http/src ./packages/speech-http/src
COPY scripts/build-browser-assets.mjs ./scripts/build-browser-assets.mjs
RUN ./node_modules/.bin/esbuild packages/browser-worker/src/main.ts --bundle --platform=node --format=esm --target=node24 --external:playwright-core --outfile=worker.mjs --legal-comments=none
RUN node scripts/build-browser-assets.mjs

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright XDG_CONFIG_HOME=/data/config XDG_CACHE_HOME=/data/cache
WORKDIR /app
COPY --from=build /build/node_modules/playwright-core ./node_modules/playwright-core
RUN node node_modules/playwright-core/cli.js install --with-deps chromium
COPY --from=build /build/worker.mjs ./worker.mjs
COPY --from=build /build/assets ./assets
COPY --from=build /build/licenses ./licenses
COPY LICENSE ./LICENSE
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 19790
CMD ["node", "/app/worker.mjs"]
