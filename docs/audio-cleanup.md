# Audio cleanup of the export

Three optional steps that run inside the one ffmpeg graph of the export, between the conformed tracks and the mix
(`src/server/post/audio-clean.ts`). Nothing is written to the tracks. **All three are off by default** (`DEFAULT_CLEAN`).

| Option | What it does |
| --- | --- |
| `level` | One static gain per track (at most +/-12 dB) so every participant's speech sits at the mean speech level of the project. |
| `bleedGate` (`bleedGateDb`, default -30) | Attenuates a track while another track is clearly the speaker and this one is not. Attack 10 ms, release 80 ms, 40 ms look-ahead. |
| `denoise` (`rnnoiseModel`) | RNNoise (`arnndn`) after leveling. Needs a model file in the data directory; nothing downloads by itself. |

Pass microphone tracks only. The sound of a shared screen is not a speaker; leave it out of the tracks and it stays in the mix unchanged.

## How it decides

- **Speech level** comes from the level frames (`levels/<id>.bin`): the power mean of the frames the voice activity detector calls speech (bleed excluded). A track with under 2 s of speech gets no gain.
- **No compressor, no dynamic normaliser** follows the gain. On a track with a slow level drift and a step (`bench` section `dynamics`): `acompressor` (2:1) leaves the quiet end where it is and only lowers the loud end (-7.6 LU overall, no levelling); `dynaudnorm` with its defaults levels the track (3 s block spread 21.4 -> 12.2 dB) but raises the pauses by 10 dB (pumping); a gentler `dynaudnorm` made the spread worse (32 dB). The static gain cannot pump and leaves loudness to the two-pass loudnorm. It does not reduce the drift inside a track.
- **Gate**: track *t* is open when it is active itself (its own level above a sensitive threshold for 2 frames or more, or above the normal speech threshold, and not 10 dB under another microphone) or when nobody else speaks. Another speaker counts for 300 ms after the last speech frame, so the gaps between words do not reopen the gate; own activity holds for 120 ms. When nobody speaks every gate is open, so room tone is never gated. The sensitive own-activity threshold matters: with the normal speech threshold a soft onset (a track just above its floor) was clipped by 1.7 dB over 100 ms and by 30 dB in its first 20 ms.
- The envelope is a mono float32 file at 1 kHz (`-f f32le -ar 1000 -ac 1`), upsampled by `aresample=48000` and multiplied with the track by `amultiply`. It runs 1 s past the end of the track (`amultiply` stops with the shorter input). The ramps are linear in dB with 1 ms corner rounding; without the rounding the upsampling filter overshot the open gain by 3 % (now 0.3 %).
- **Denoise**: `arnndn` delays its output by one RNNoise frame (480 samples = 10 ms) and drops the last frame; the chain cuts the delay and pads the end, so the track stays aligned (measured lag 0 samples). Model: `beguiling-drafter` (`bd.rnnn`, recording noise / voice) of the rnnoise-models project, pinned to commit `3eee541a`, SHA-256 `ae3f7411...a17b`, downloaded by `ensureRnnoiseModel(modelsDir)` into `<MODELS_DIR>/rnnoise/` when called explicitly. The project states that the models are not subject to copyright; the RNNoise code is BSD-3-Clause. `sh.rnnn` gave the same numbers on the test below (17.5 vs 16.9 dB noise reduction, 10.2 vs 10.3 dB signal-to-error), so `bd` stays for its handling of laughter and breaths.

## Measurements

Method: `scripts/bench-audio-clean.ts` (`tsx scripts/bench-audio-clean.ts --asr <spike work dir> --dir <work dir>`), ffmpeg 8.0.1. Fixtures: `fix-silence-en|pl` (TTS, 6 min, -24 dB bleed, exact speech spans), `fix-en|pl` (10 min conversations, `bleed_A/B` with -22 dB bleed; speech spans from the clean `track_A/B`). The tracks are conformed to 48 kHz mono FLAC and the level frames are computed as the conform job does.

**Bleed (gate on, 301 speaker onsets in 8 tracks).** Bleed = RMS of a track during the other speaker's solo speech, before vs after.

| Fixture | Bleed reduction A / B | Settled (without first 150 ms of each span) | Bleed-to-speech ratio in the mix, before -> after |
| --- | --- | --- | --- |
| fix-silence-en | 29.1 / 28.6 dB | 30.0 / 30.0 dB | -23.4 -> -52.5 dB (A), -23.1 -> -51.7 dB (B) |
| fix-silence-pl | 28.8 / 28.6 dB | 30.0 / 30.0 dB | -23.2 -> -52.1 dB, -22.7 -> -51.3 dB |
| fix-en bleed | 24.2 / 26.8 dB | 28.0 / 30.0 dB | -21.6 -> -45.8 dB, -21.6 -> -48.3 dB |
| fix-pl bleed | 24.9 / 27.4 dB | 28.7 / 30.0 dB | -21.6 -> -46.6 dB, -20.9 -> -48.4 dB |

Worst case 24.2 dB (target 6 dB). Onsets: RMS of the speaker's own speech in the first 100 ms (and first 20 ms) after each onset, gated vs ungated with the same gain: worst 0.00 dB over all 301 onsets, in both windows, and 0.00 dB over the 22 onsets where the gate had been closed just before (limit 1 dB). With `level` on the same numbers hold (fix-en 24.2 dB, fix-silence-pl 28.6 dB, onsets 0.00 dB).

**Loudness (full chain: cleanup -> amix normalize=0 + limiter -> cut -> two-pass loudnorm -16 LUFS / -1 dBTP -> 16-bit WAV, ebur128 on the file).** Same graph as `audioProgramGraph` and `loudnormFilter`.

| Fixture (10 min) | Without cleanup | `level` + `bleedGate` | `level` + `bleedGate`, 3 kept ranges |
| --- | --- | --- | --- |
| fix-en tracks | -16.0 LUFS, -1.0 dBTP | -16.0, -1.0 | -16.0, -1.0 |
| fix-en bleed | -16.0, -1.0 | -16.0, -1.0 | -16.0, -1.0 |
| fix-pl tracks | -15.9, -1.0 | -16.0, -1.0 | -16.0, -1.0 |
| fix-pl bleed | -15.9, -1.0 | -16.0, -1.0 | -16.0, -1.0 |

All within 0.1 LU of target (limit 1 LU), true peak -1.0 dBTP. Cost on 2 tracks / 10 min: `prepareClean` 70-140 ms; measuring pass 16-18.5 s and encode pass 17-20 s with the cleanup, 17-17.5 s and 18-19 s without it (the difference is within the run-to-run spread).

**Level.** Estimated speech level (power mean of level frames) vs integrated loudness of each track (ebur128), difference between the two tracks before -> after:

| Scenario | Gains | Level estimate | ebur128 per track |
| --- | --- | --- | --- |
| fix-en as recorded | +0.2 / -0.2 dB | 0.4 -> 0.0 dB | 0.5 -> 0.9 LU |
| fix-pl as recorded | +2.3 / -2.3 dB | 4.7 -> 0.0 dB | 3.4 -> 1.4 LU |
| fix-en, A +4 dB, B -10 dB | -6.6 / +6.6 dB | 13.2 -> 0.3 dB | 14.5 -> 1.2 LU |
| fix-pl, A +4 dB, B -10 dB | -4.6 / +4.6 dB | 9.1 -> 0.2 dB | 10.6 -> 1.6 LU |
| fix-en, 28 dB apart (beyond the clamp) | -12 / +12 dB | 26.1 -> 2.9 dB | 27.8 -> 3.8 LU |

The level frames are unweighted RMS, so voices with a different spectrum keep up to about 1.5 LU of difference in K-weighted loudness after the match (fix-en as recorded went from 0.5 to 0.9 LU); that is the price of measuring on the level track instead of the audio.

**Artefact indicators (gate).**

| Indicator | Result |
| --- | --- |
| Gate transitions per minute (open and close) | 6.2-7.9 on the TTS fixtures, 7.4-19.3 on the conversations with overlapping speech; closed 36-49 % of the time |
| Speech frames attenuated by more than 3 dB (false mute) | 0 of 6 813-12 776 own-speech frames per track on all four fixtures, energy share 0; 0 of 7 overlapped frames in fix-en |
| Heavy crosstalk (fix-en, speaker B delayed 3 s: 2 381 overlapped frames = 47.6 s) | at equal level 7.5 % / 8.5 % of the overlapped frames of A / B attenuated by more than 3 dB; the quieter speaker loses 19.7 % at -6 dB, 32.8 % at -10 dB, 59.3 % at -20 dB; speech outside the overlap 0.0-0.07 % |
| Click test: gate closed for 500 ms at 38-44 places in the middle of loud speech (three tracks: fix-silence-en, fix-silence-pl, fix-en conversation) | largest sample step around the edges 1.000-1.003 x the step of the ungated signal in the same window with the ramps, 6.1-18.4 x with an instant switch at 48 kHz; peak above 10 kHz around the edges no higher than the ungated signal (-39.8 / -46.8 / -46.8 dBFS against -39.8 / -45.0 / -41.5; the sources end at 8 kHz) with the ramps, -27.7 / -20.6 / -22.5 dBFS with the instant switch |
| Envelope after upsampling | max 1.0029, min 0.03152 (closed gain 0.03162): no overshoot of consequence, no sign flip |

**Denoise** (120 s of fix-en `track_A` plus pink noise and a 100 Hz hum, quiet level -49.4 dBFS): noise 16.9 dB lower (-66.3 dBFS), speech level -0.6 dB, lag 0 samples after the compensation, 1.1 s of wall time for 120 s of audio (about 5.5 s per track for a 10 minute export). The waveform changes by design: signal-to-error against the clean speech is 10.3 dB (28.3 dB for the noisy input), which says nothing about perceived quality.

## Limits

- The gate decides from levels only. A speaker who is 10 dB or more under another one on their own microphone is read as bleed, so quiet interjections made while someone else talks loudly are attenuated (see the crosstalk row). Bleed less than 10 dB under the speaker (loudspeakers, open microphones) is not gated at all.
- The fixtures are TTS and an attenuated copy of the other speaker: no room response, delay or echo, and no real recordings. Nobody listened to any of the output.
- The gate needs two or more tracks; `level` needs speech on the track; the envelope assumes the levels belong to the conformed file it multiplies.

## Recommendation

Keep all three off in `DEFAULT_CLEAN`.

- `bleedGate`: the objective evidence is good where bleed is 20 dB or more under the speaker (24-29 dB less bleed, no clipped onset on 301 onsets, no click, no false mute in turn-taking speech), so it is worth offering as an opt-in toggle for close-microphone sessions. It does not yet support making it the default: the fixtures are synthetic, overlapping speech loses 8 % of the overlapped frames at equal level (up to 59 % for a much quieter interjection), and there has been no listening test. Before it becomes the default: listen to A/B exports of at least three real two-person sessions, including one with a loud laugh or interruption.
- `level`: the lowest risk of the three (a constant gain; loudness, peak and cut behaviour unchanged) and the first candidate for a default after the same listening check.
- `denoise`: opt-in only; it needs the model download and changes the waveform.
