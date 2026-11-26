#!/usr/bin/env bash
# Smoke test of the built Docker image: transcribes a short Polish fixture with the speech engine inside the image.
# usage: npm run smoke:image [-- <image>]      (default image: sync-record; build it first with `docker build -t sync-record .`)
# The first run downloads the model (about 1.6 GB) into a named volume; later runs reuse it.
# Environment: SMOKE_MODELS_VOLUME (volume name, default syncrecord-smoke-models), SMOKE_MEMORY (default 4g),
# ASR_MODEL and ASR_COMPUTE_TYPE are passed through when set.
set -euo pipefail
image="${1:-sync-record}"
root="$(cd "$(dirname "$0")/.." && pwd)"
env_args=()
for name in ASR_MODEL ASR_COMPUTE_TYPE; do
  [ -n "${!name:-}" ] && env_args+=(-e "$name=${!name}")
done
exec docker run --rm \
  --memory "${SMOKE_MEMORY:-4g}" --memory-swap "${SMOKE_MEMORY:-4g}" --oom-score-adj=800 \
  -e TOKEN_SIGNING_SECRET=smoke-test-secret-not-used \
  ${env_args[@]+"${env_args[@]}"} \
  -v "${SMOKE_MODELS_VOLUME:-syncrecord-smoke-models}:/models" \
  -v "$root/tests/smoke:/smoke:ro" \
  --entrypoint node "$image" /smoke/asr-smoke.mjs
