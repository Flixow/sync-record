# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Speech engine: faster-whisper in a virtualenv. Every dependency (ctranslate2, onnxruntime, av, tokenizers, numpy)
# ships a prebuilt CPU wheel, so no compiler is needed (--only-binary) and no GPU/CUDA/torch is pulled in. Only the
# finished virtualenv is copied to the final image: no pip, no pip cache, no bytecode caches.
FROM node:22-bookworm-slim AS asr
ARG FASTER_WHISPER_VERSION=1.2.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && apt-get clean \
    && find /var/lib/apt/lists -type f -delete
RUN python3 -m venv /opt/asr \
    && /opt/asr/bin/pip install --no-cache-dir --only-binary=:all: "faster-whisper==${FASTER_WHISPER_VERSION}" \
    && /opt/asr/bin/pip uninstall -y pip \
    && find /opt/asr -type d -name __pycache__ -prune -exec rm -r {} +

FROM node:22-bookworm-slim
# ffmpeg is a required dependency: the collector remuxes every track with `ffmpeg -c copy`.
# python3 is the interpreter of the speech engine virtualenv copied from the asr stage (same base image, same Python);
# ca-certificates lets it download the model over HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates \
    && apt-get clean \
    && find /var/lib/apt/lists -type f -delete
WORKDIR /app
# The model is not baked into the image (the large one is about 1.6 GB): it downloads into MODELS_DIR on the first
# transcript job and stays in the /models volume across container and image upgrades. Without ASR_MODEL the server picks
# the largest model that fits the container's memory (large-v3-turbo, small or base); set ASR_MODEL to pin one.
# ASR_COMPUTE_TYPE changes the compute type.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STORAGE_LOCAL_DIR=/data \
    PATH=/opt/asr/bin:$PATH \
    MODELS_DIR=/models \
    ASR_COMPUTE_TYPE=int8
COPY --from=asr /opt/asr /opt/asr
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY assets ./assets
RUN mkdir -p /data /models && chown node:node /data /models
USER node
VOLUME ["/data", "/models"]
EXPOSE 8080
# TOKEN_SIGNING_SECRET and every other setting come from the environment (see .env.example).
CMD ["node", "dist/server/index.js"]
