#!/usr/bin/env bash
# Runs every engine/model on every fixture of the spike. usage: run_all.sh <asr work dir> [parallel jobs]
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
W="$1"; P="${2:-3}"
. "$W/env.sh"; . "$W/venv/bin/activate"
M="$W/models"
mkdir -p "$W/runs"
CONFIGS=(
  "sherpa|$M/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8|parakeet-v3-int8"
  "fw|small|fw-small-int8"
  "fw|deepdml/faster-whisper-large-v3-turbo-ct2|fw-turbo-int8"
  "wcpp|$M/ggml-small.bin|wcpp-small"
  "wcpp|$M/ggml-large-v3-turbo-q5_0.bin|wcpp-turbo-q5"
)
: > "$W/runs/jobs.txt"
for cfg in "${CONFIGS[@]}"; do
  IFS='|' read -r engine model tag <<< "$cfg"
  for lang in pl en; do
    fix="$W/fix-$lang"
    for track in track_A.wav track_B.wav silent.wav clip_0.wav clip_1.wav clip_2.wav clip_3.wav clip_4.wav; do
      echo "$engine|$model|$lang|$fix|$track|$tag" >> "$W/runs/jobs.txt"
    done
  done
done
run_one() {
  IFS='|' read -r engine model lang fix track tag <<< "$1"
  out="$W/runs/$tag-$lang-${track%.wav}"
  [ -f "$out.json" ] && return 0
  /usr/bin/time -v -o "$out.time" python "$ROOT/harness.py" "$engine" "$model" "$lang" "$fix" "$track" --threads 4 --out "$out.json" > "$out.log" 2>&1
}
export -f run_one; export W ROOT
xargs -a "$W/runs/jobs.txt" -d '\n' -P "$P" -I{} bash -c 'run_one "{}"'
echo ALL_DONE
