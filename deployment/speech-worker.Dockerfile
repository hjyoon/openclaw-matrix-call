FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS engines
RUN apt-get update && apt-get install --yes --no-install-recommends build-essential ca-certificates cmake curl libsonic-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /sources
COPY deployment/speech-engines.json ./pins.json
RUN node --input-type=module -e 'import { readFileSync } from "node:fs"; import { execFileSync } from "node:child_process"; const pins = JSON.parse(readFileSync("pins.json")); for (const name of ["whisper", "espeak"]) { execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", "--max-time", "120", pins[name].archiveUrl, "--output", `${name}.tar.gz`]); execFileSync("sha256sum", ["--check"], { input: `${pins[name].sha256}  ${name}.tar.gz\n` }); execFileSync("mkdir", [name]); execFileSync("tar", ["--extract", "--gzip", "--file", `${name}.tar.gz`, "--directory", name, "--strip-components=1"]); }'
RUN cmake -S whisper -B whisper-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/whisper -DCMAKE_INSTALL_RPATH=/opt/whisper/lib -DBUILD_SHARED_LIBS=ON -DWHISPER_BUILD_TESTS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_BACKEND_DL=ON -DGGML_BACKEND_DIR=/opt/whisper/lib -DGGML_CPU_ALL_VARIANTS=ON && cmake --build whisper-build --parallel 2 && cmake --install whisper-build
RUN cmake -S espeak -B espeak-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/espeak -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DUSE_MBROLA=OFF -DUSE_LIBSONIC=OFF -DUSE_LIBPCAUDIO=OFF -DUSE_ASYNC=OFF -DESPEAK_BUILD_MANPAGES=OFF && cmake --build espeak-build --parallel 2 && cmake --install espeak-build

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build
WORKDIR /build
COPY deployment/worker-build/package.json deployment/worker-build/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY packages/core/src ./packages/core/src
COPY packages/speech-http/src ./packages/speech-http/src
COPY packages/speech-worker/src ./packages/speech-worker/src
RUN ./node_modules/.bin/esbuild packages/speech-worker/src/main.ts --bundle --platform=node --format=esm --target=node24 --alias:@matrix-call/speech-http=./packages/speech-http/src/index.ts --outfile=worker.mjs --legal-comments=none

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /build/worker.mjs ./worker.mjs
COPY --from=build /build/node_modules/zod/LICENSE ./licenses/zod.txt
COPY --from=engines /opt/whisper/bin/whisper-cli /opt/whisper/bin/whisper-cli
COPY --from=engines /opt/whisper/lib /opt/whisper/lib
COPY --from=engines /opt/espeak/bin/espeak-ng /opt/espeak/bin/espeak-ng
COPY --from=engines /opt/espeak/share/espeak-ng-data /opt/espeak/share/espeak-ng-data
COPY --from=engines /sources/whisper/LICENSE ./licenses/whisper.txt
COPY --from=engines /sources/espeak/COPYING ./licenses/espeak.txt
COPY --from=engines /sources/whisper.tar.gz /sources/espeak.tar.gz ./sources/
COPY deployment/speech-engines.json ./sources/pins.json
COPY deployment/speech-worker.Dockerfile ./sources/Dockerfile
COPY LICENSE ./LICENSE
USER node
CMD ["node", "/app/worker.mjs"]
