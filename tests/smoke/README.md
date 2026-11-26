# Container smoke test

`npm run smoke:image [-- <image>]` runs `asr-smoke.mjs` inside the built image (see `scripts/smoke-image.sh`): it
transcribes `polish.flac` through the same engine the transcript job uses and fails on an empty transcript.

`polish.flac` (8.5 s, 16 kHz mono, about 140 KB) is synthesized, not recorded, so it has no copyright or privacy
attached. Regenerate it with:

```sh
espeak-ng -v pl -s 135 -w polish.wav "Dzień dobry, witamy w nagraniu testowym. Dzisiaj sprawdzamy rozpoznawanie mowy w języku polskim."
ffmpeg -y -i polish.wav -ar 16000 -ac 1 -c:a flac -compression_level 12 polish.flac
```
