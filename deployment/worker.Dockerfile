FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build
WORKDIR /build
COPY deployment/worker-build/package.json deployment/worker-build/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY packages/core/src ./packages/core/src
COPY packages/worker/src ./packages/worker/src
RUN ./node_modules/.bin/esbuild packages/worker/src/main.ts --bundle --platform=node --format=esm --target=node24 --outfile=worker.mjs --legal-comments=none

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /build/worker.mjs ./worker.mjs
COPY --from=build /build/node_modules/zod/LICENSE ./licenses/zod.txt
COPY LICENSE ./LICENSE
USER node
EXPOSE 19790
CMD ["node", "/app/worker.mjs"]
