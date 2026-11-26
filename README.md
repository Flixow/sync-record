<p align="center">
  <img src="src/web/public/logo.svg" alt="SyncRecord logo" width="72" height="72" />
</p>

<h1 align="center">SyncRecord</h1>

<p align="center">
  Every voice at full quality, recorded locally. One clean track per person, collected by a small server you run yourself.
</p>

SyncRecord is for podcasts and interviews held over a call (Google Meet or any call app). The call is only used for
talking. Each participant opens a SyncRecord link in their own browser and records their own microphone, camera and
optionally their screen **on their own computer**, so the quality never depends on the connection. The files are
uploaded in the background to a collector you host. After the session the collector remuxes every track and writes a
manifest with the start time of each track on one shared clock, ready for post-production.

There are no accounts, no payments and no cloud service: an invite link carries a signed token and storage is a local
directory or any S3-compatible bucket you choose.

## Features

- Chromium only (Chrome, Edge, Brave) on Mac and Windows, up to 4 participants per session.
- Separate tracks per participant and kind: microphone audio, camera video, optional screen share. Recorded with
  `MediaRecorder` in 1 s slices as WebM (VP9 video, Opus audio), each kind in its own recorder so one failure never
  takes down the others.
- Chunks are written to the browser's private storage (OPFS) first and uploaded in the background with resume.
- Crash recovery: reopen the session link after a crash and SyncRecord finds the unfinished recordings, finishes their
  upload and keeps the local copy until you delete it. Nothing expires on its own.
- Shared clock: a handshake against the collector measures each browser's clock offset; the start time of every track
  and a short sync beep (plus a "clap now" prompt) are stored in the manifest.
- Disk space check before and during recording (`navigator.storage.estimate`), with no hard session limit.
- Setup screen with device check, headphone confirmation (with a one-click skip), a speaker-bleed test, explicit
  recording consent and a live roster that shows who is recording what.
- English and Polish interface.
- Collector: small Node/TypeScript server, configured by environment variables only, runs with plain Node or Docker.

## Requirements

- Node.js 22 or newer.
- **ffmpeg** (with `ffprobe`) on the collector machine. This is a required dependency: after a session every track is
  remuxed with `ffmpeg -c copy`. The Docker image includes it.
- A Chromium-based browser for every participant. Camera and microphone access needs HTTPS, except on `localhost`.

## Quick start

```sh
npm ci
npm run build
cp .env.example .env        # set TOKEN_SIGNING_SECRET to at least 16 random characters
set -a; . ./.env; set +a    # or export the variables any other way
npm start
```

Open `http://localhost:8080`, enter your name and create a session, then send the invite link to the other
participants. For anything beyond your own machine put the collector behind an HTTPS reverse proxy.

### Docker

```sh
cp .env.example .env        # set TOKEN_SIGNING_SECRET
docker build -t sync-record .
docker run --env-file .env -e HOST=0.0.0.0 -p 8080:8080 -v syncrecord-data:/data sync-record
```

`docker-compose.example.yml` shows the same as a compose file: copy it to `docker-compose.yml`, create `.env` as above and
run `docker compose up --build`. The image listens on 8080, runs as the unprivileged `node` user and keeps recordings in
the `/data` volume (a bind mount must be writable by uid 1000). The Dockerfile builds with the classic builder as well as
BuildKit. The compose example sets no resource limits; add `mem_limit` (and `memswap_limit`) to the service if the host is shared.

The image also carries the speech engine for **Transcribe**: `python3` and `faster-whisper` (CPU wheels only, in a
virtualenv on `PATH`). The model is **not** in the image (about 1.6 GB): it downloads into `MODELS_DIR` (`/models`, a
volume, so it survives container and image upgrades) on the first transcript job, which needs outbound access to
huggingface.co once and takes a few minutes. Mount the `/models` volume (the compose example does) so it is downloaded
only once. `ASR_MODEL` and `ASR_COMPUTE_TYPE` change the model and the compute type. To check an image:

```sh
npm run smoke:image -- sync-record   # transcribes a short Polish fixture inside the image; first run downloads the model
```

## Configuration

Everything is read from the environment (see `.env.example`). Nothing is hardcoded.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TOKEN_SIGNING_SECRET` | required | At least 16 characters. Signs invite and participant tokens. |
| `SESSION_CREATE_KEY` | empty | When set, creating a session requires this key. Use it on any public deployment. |
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Listen address. |
| `TOKEN_TTL_HOURS` | `72` | Lifetime of invite and participant tokens. A participant token is renewed every time the participant opens the session page; the host's invite link is renewed the same way, so it stays valid while the host keeps coming back. |
| `MAX_UPLOAD_BYTES` | `16777216` | Largest accepted upload request. |
| `STORAGE_DRIVER` | `local` | `local` or `s3`. |
| `STORAGE_LOCAL_DIR` | `./data` | Directory for the local driver. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | empty | S3-compatible storage; the bucket and both keys are required when `STORAGE_DRIVER=s3`. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | Where to find the tools. |
| `POST_DIR` | `<STORAGE_LOCAL_DIR>/post` (`./post` with S3) | Local directory for post-production: projects, proxies, analysis files and exports (always local, also with the S3 driver). |
| `POST_CONCURRENCY` | `1` | Post-production jobs that run at the same time. |
| `POST_NICE` | `10` | Niceness of ffmpeg and speech-recognition child processes. |
| `POST_THREADS` | `0` | Threads per child process; `0` lets the tool choose. |
| `POST_MIN_FREE_GB` | `10` | A job is refused (HTTP 507) when the data directory has less free space than this. |
| `POST_RETENTION` | `keep-exports` | `keep-exports` deletes proxies and intermediates after an export; `keep-all` keeps them. They can always be deleted per session. |
| `LOUDNESS_LUFS`, `TRUE_PEAK_DBTP` | `-16`, `-1` | Default loudness target and true-peak ceiling of exports. |
| `MODELS_DIR` | `<POST_DIR>/models` (`/models` in the Docker image) | Where speech models are downloaded on first use. Models never go into git. |
| `ASR_PYTHON` | `python3` | A Python with `faster-whisper` installed (`pip install faster-whisper`; the Docker image has it); the transcript job runs it as a child process. |
| `ASR_MODEL` | `deepdml/faster-whisper-large-v3-turbo-ct2` | faster-whisper model; `small` is a faster, less accurate choice (about 2.5x as fast; 17% instead of 7% word error rate on Polish). |
| `ASR_COMPUTE_TYPE` | `int8` | CTranslate2 compute type of the model on the CPU: `int8`, `int8_float32`, `int16`, `float32`, `auto`, ... (an unsupported one fails the transcript job). |
| `LLM_URL` | empty | Optional chat-completions endpoint (base URL of an OpenAI-compatible server) for the language-model features: clip re-ranking, chapter titles, title and description drafts, scene-plan suggestions. Empty = off, and every feature works without it. See [Optional language model](#optional-language-model). |
| `LLM_PROVIDER` | `openai-compatible` | `openai-compatible` (llama.cpp, Ollama, LiteLLM, OpenRouter, OpenAI, any server with `/v1/chat/completions`; key optional) or `omp-gateway` (an OMP auth gateway; key and model required). |
| `LLM_MODEL` | `default` | Model name sent to the endpoint. Required for `omp-gateway` (`provider/model-id`). |
| `LLM_API_KEY`, `LLM_API_KEY_FILE` | empty | Bearer key for the endpoint, from the environment or from a file (use the file with Docker/Kubernetes secrets); set at most one. Refused over plain `http://` unless the host is this machine, Docker's `host.docker.internal` or a Tailscale address. |
| `POSTHOG_KEY`, `POSTHOG_HOST` | empty | Optional telemetry to a PostHog instance you operate. Off unless both are set; see [Telemetry](#telemetry). |
| `LLM_TIMEOUT_MS` | `60000` | Per-request timeout, 1000 to 600000. A timeout counts as a failure: the built-in rules answer instead. |
| `WEB_DIR` | `./dist/web` | Built web client. |

## Output

For a session with id `<id>` the storage holds:

```
session/<id>/manifest.json
session/<id>/<participant>/audio.webm
session/<id>/<participant>/camera.webm
session/<id>/<participant>/screen.webm
```

`<participant>` is `p1-<name>`, `p2-<name>` and so on (the host is `p1`). When someone records more than once (for
example after a crash) the later recordings are `audio-2.webm`, `camera-2.webm` and so on, and the manifest lists every
segment with its own start time. Raw uploaded parts stay under `session/<id>/raw/` so a failed remux can be retried
(`POST /api/sessions/<id>/end` is repeatable).

`manifest.json` lists the participants (name, consent version and time, browser) and for each track: the file, the
codec settings, the start time on the client clock and on the server clock, the clock offset with its uncertainty and
all samples taken during the recording, the sync markers, why the track ended (`stopped`, `trackEnded`, `sessionEnded`,
`crash`, `forced`) and the duration measured after remux. Server time is `clientTimeMs + offsetMs`; the client clock is
`performance.timeOrigin + performance.now()`.

Drift between microphones and variable frame rate are **not** corrected in the collector. The manifest carries what
the post-production step needs to do that.

## Post-production

The host opens `/project/<session id>` from the results card. Opening it creates a project under `POST_DIR` and starts
a **conform** job: every track is brought onto one timeline. Audio becomes 48 kHz mono FLAC with the start offset and the
clock drift (measured from the handshake samples against the media duration; applied only for recordings of at least
five minutes) removed, video becomes a 480p constant-frame-rate H.264 proxy, and waveform peaks and a level track are
written next to them. The original recordings are never modified.

Jobs run in a small persistent queue (`POST_DIR/<id>/jobs/*.json`). A job survives a collector restart: it is resumed
(up to three attempts) or marked failed with a reason, and a leftover ffmpeg from the killed process is removed. Jobs
refuse to start below `POST_MIN_FREE_GB` of free disk. Proxies and intermediates can be deleted per session from the
project page.

### Transcript and highlights

**Transcribe** runs a local speech-to-text job (no cloud). Each track is searched for speech first (energy on the level
track, and a track counts as speaking only when it is not just another speaker's voice leaking into its microphone), so
silent stretches and bleed never reach the engine and a silent track produces no text. The engine is
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) with `large-v3-turbo` in int8 on the CPU; it needs a Python
with `faster-whisper` installed (`ASR_PYTHON`; the Docker image has it) and downloads the model into `MODELS_DIR` on first use, never into the
repository. Words carry their own start and end on the project timeline; words heard on two tracks at once are reduced to
the louder one. The language is detected per project or set by hand. The transcript is searchable, click-to-seek, and
exports as SRT, VTT or plain text (with or without speaker names). Pressing **M** (or the button) while recording drops
a highlight marker into every active recording; the markers show up as chips above the transcript.

Measured on this build's 10-minute test conversations (read speech, two speakers, 12 vCPU, no GPU): word error rate 5.0 %
English and 7.0 % Polish; about 0.15-0.4x real time; 1.7 GB of memory. Word starts land within 100 ms of the reference
for roughly 70 % (English) and 85 % (Polish) of the words, so cuts through words stay at the pause middle, never at a
word edge.

### Cutting

The transcript on the project page is also the cutting tool. Click a word to play from it, shift-click or drag to select
a stretch of words, then **Delete** (the key or the button), **Keep only** or **Restore**. Cuts go through the middle of
the pauses around the words, removed words are struck through, and the player skips every removed part. **Silences**
finds the pauses in which nobody speaks (minimum length and the gap to keep are adjustable), lists them for review with a
per-silence preview (1.5 s before, the jump, 1.5 s after) and applies the checked ones as one undoable step. The strip
above the transcript shows the combined waveform, the removed ranges, the highlights and the selection, and seeks on
click or drag. Undo and redo are `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` and `Ctrl+Y`. The edit is saved a moment after every
change as `POST_DIR/<id>/edl.json` (a save made from a stale copy is refused and the saved edit is loaded instead);
nothing in the recordings changes. **Render preview** writes the audio with the cuts applied (`proxies/mix-cut.m4a`) so
you can hear the real joins.

### Export

**Export** renders the edit to a file: YouTube 1080p30, 1080p60, 4K 30 and 4K 60 (H.264 High, 4:2:0, 2 B-frames, closed
GOP of half a second, AAC 48 kHz stereo, `moov` first, no edit list) and audio-only MP3 or WAV. Audio is taken from the
conformed tracks and normalised in two passes to `LOUDNESS_LUFS` (default -16) with a true peak limit of
`TRUE_PEAK_DBTP` (default -1); video is taken from the original recording, conformed at full size, and cut at the same
frames. Progress is shown, a running export can be cancelled (the ffmpeg process is stopped), and finished exports are
listed with download and delete. With `POST_RETENTION=keep-exports` (default) the proxies are deleted after an export;
open **Prepare** again to edit further. `POST_THREADS` bounds the encoder threads.

On the project page the **Export** section lists the formats (video and audio groups) and shows the server's loudness
target and true-peak limit under *Advanced*, where one camera can also be chosen instead of the layout's scenes. A bar
shows the stage (loudness measurement, then encode) and **Cancel** stops the render. Finished exports are listed with
size, length, measured loudness and a download link. After an export with the default retention the page says that the
preview media were removed: the transcript, the cuts, the layout and the list of exports stay, the cuts can still be
edited and undone, and **Prepare** brings playback back without losing the undo history.

### Layouts and vertical video

When a project has picture sources, the export is composed by one layout engine (`src/shared/layout.ts`) whose geometry
the browser preview and the ffmpeg render both use. Layouts: solo, side by side, grid, speaker with thumbnails, and
screen with camera. The canvas is 16:9, 9:16 (Shorts, Reels) or 1:1, filled or fitted, over a colour or a blurred copy of
the picture. On 9:16 every picture stays inside the safe area, clear of the platform's title and buttons. **Active
speaker** switching follows who is talking on their own microphone (a voice that only leaks into someone else's
microphone does not count), with a minimum time on screen, hysteresis, a short hold after speech ends, and a rhythm
(calm, balanced, lively). Manual scene edits are layered over the automatic ones, are saved separately (`scenes.json`) and
can be undone or cleared.

On the project page the **Layout** section drives a live preview above the player. It draws the layout engine's own
geometry (the same percentages the render derives its crops from) with the 480p proxies and keeps every picture in step
with the audio, frame exact while paused. Buttons pick the layout and the shape; how pictures fill their tile (automatic,
fill or whole picture), the background (a colour, or a blurred copy of the featured picture with a strength slider), the
rhythm, the shortest scene and what to show while nobody speaks are saved like the cuts. The scene list shows each scene
with its layout and featured picture, marks the scenes changed by hand and resets them one at a time; the strip above the
transcript marks the scene boundaries. The layout has its own undo and redo (`Ctrl/Cmd+Z` while the focus is inside the
Layout section; elsewhere the same keys undo cuts). When the proxies have been removed the preview says so and the layout
stays editable. `/project/<id>?hooks=1` exposes `window.__syncPreview.seekMs(ms)` for `scripts/bench-preview-ssim.ts`,
which compares preview frames with the exported video (SSIM, gate 0.98 per frame).

### Captions

Exports can burn in captions (four presets, bundled Noto Sans, Polish diacritics included, word highlighting on two of
them) laid out inside the safe area, and write matching `.srt` and `.vtt` files next to the video. Captions follow the
cuts: removed words are dropped and times are moved onto the edited timeline. Rendering uses libass through ffmpeg; see
`docs/captions.md`.

### Audio cleanup

Three optional steps run inside the export's one ffmpeg graph, on microphone tracks only. All are **off by default**:

- **Level speakers**: one static gain per track (at most ±12 dB) so every voice sits at the same speech level.
- **Bleed gate**: while another track is the clear speaker and this one is not, this track is attenuated (default -30 dB, ramps of 10 ms in and 80 ms out, 40 ms look-ahead so onsets stay intact). On the synthetic bleed fixtures it lowered bleed by at least 24 dB with no clipped onsets, but overlapping speech loses some frames and it has not been judged by ear, so use it for close-microphone sessions and listen first.
- **Denoise**: RNNoise through `arnndn`. The model is not in the repository: `POST /api/sessions/<id>/project/audio/denoise-model` (the Denoise button in Export) downloads it once into `MODELS_DIR/rnnoise`, the only network call besides the speech model.

Loudness is normalised after the cleanup, so the export still lands on the target. Details and measurements: [docs/audio-cleanup.md](docs/audio-cleanup.md).

### Clips and publishing

**Clips** proposes 20-90 second stretches that start and end on sentence boundaries, from a question and its answer, speech
energy and pace, and the moments marked with M; each suggestion says why it was chosen. A clip is a child project with its
own range and preset (vertical 1080x1920 by default); its start and end can be adjusted word by word and it is exported
with the same renderer, captions included. **Publish** drafts chapters (checked against YouTube's rules: the first at
00:00, at least three, ascending, at least ten seconds apart), three title variants and a description from the transcript,
and picks thumbnail frames (3840x2160, or 2160x3840 for a Short, under 50 MB) with an optional text plate. All of it works
without a language model; the optional one is described under [Optional language model](#optional-language-model).

On the project page the **Clips** panel lists the suggestions with their reasons and a text excerpt; play a range, move its
start or end one word at a time, save it, then render the saved clip (vertical 1080x1920 with captions by default) and
find the file in the exports list. The **Export** panel gains burned-in captions in four styles (with captions on, .srt and
.vtt files are also written next to a video) and audio cleanup (level the speakers, reduce bleed between microphones, reduce
background noise); every option is off by default, and the noise model is downloaded only when you ask for it. The
**Publish** panel shows the chapters with YouTube's rules checked and a copy button, the title and description draft, and a
thumbnail picker (moment, video or Short shape, optional text) that ends with a picture you can download. The "language model"
boxes of Clips and Publish, and the scene-plan box of the layout editor, are off by default and only act when `LLM_URL` is set.

### Optional language model

Off unless `LLM_URL` is set, and then used only for the request that ticks the box. Four things use it, each with a
built-in fallback: re-ranking and titling clips, retitling the chapters (start times and count never change), the title
and description draft, and a **scene-plan suggestion** (layout per stretch of the recording). Any failure (refused,
timeout, overload, an answer that does not validate) returns the built-in result and a short reason; nothing is retried.

What the model receives: transcript text and, for the scene plan, a few numbers per stretch (speech, overlap and silence
share, loudness, speaker changes, screen share yes/no). Never audio, video or frames. When `LLM_URL` is not on this
machine, the boxes say that the transcript leaves it; point it only at a service you may send it to.

The model chooses from a fixed list per stretch (never timestamps) and its layouts are written as ordinary scene overrides
in one undoable step, so the plan stays hand-editable. Highlights and cut suggestions are only listed, never applied.
Transition types are not part of the editor (the renderer makes hard cuts), so none are suggested. Without a model the
same button gives no layout changes and lists long silences as cut candidates and the clip suggestions as highlights.

Providers share one small interface (`LlmClient` in `src/server/post/llm.ts`: `enabled` and `rank(prompt)` returning
parsed JSON or `null`). To add one, implement it and register it in `PROVIDERS`; for a service that speaks the OpenAI
chat-completions protocol you only need `LLM_URL`, `LLM_MODEL` and your own `LLM_API_KEY`:

```sh
LLM_URL=https://api.openai.com
LLM_MODEL=<model id of your choice>
LLM_API_KEY_FILE=/run/secrets/llm_key
```

`omp-gateway` talks to an OMP `auth-gateway` (`omp auth-gateway serve`) that holds provider credentials for
you (`LLM_MODEL=provider/model-id`, a per-client token from the gateway's `--clients` file as the key). Give the
application a gateway client token, never the token of the auth broker behind it: a broker token exposes every
credential the broker holds. Using a chat subscription this way is the operator's own responsibility: Anthropic's
terms do not allow routing subscription credentials through third-party applications, and OpenAI limits subscription use
to its participating apps. It is meant for a private, single-operator installation; anyone else should use their own API
keys with `openai-compatible`.

## Telemetry

Off by default. Nothing is sent, no connection is opened and the build contains no key or host unless the operator sets both
`POSTHOG_KEY` and `POSTHOG_HOST` (an `https://` origin; `http://` only for localhost) in the server's environment. The
repository, the web bundle and the Docker image carry neither; the browser never talks to PostHog (there is no PostHog SDK
in the web app, so there is no autocapture, no session recording and no page-view tracking).

When enabled, the server sends exactly these events (session lifecycle and errors only), each as one request to `POSTHOG_HOST/capture/`, fire-and-forget with a
3 s timeout:

| Event | Properties |
| --- | --- |
| `session_created` | none |
| `session_joined` | `participants` (a number, including the host) |
| `recording_started` | `audio`, `camera`, `screen` (three booleans: which kinds the participant records) |
| `recording_stopped` | none |
| `session_ended` | `participants` (a number); sent once per session |
| `project_ready` | none (the post-production project finished preparing its media) |
| `remux_failed` | none (a track could not be turned into its final file) |
| `job_failed` | `kind` of the post-production job (for example `transcribe`) |
| `server_error` | `error`: class name of an unexpected request error, not its message |

Every event also carries a random id generated at each server start (it identifies no person and no recording),
`$process_person_profile: false` and `$geoip_disable: true`. Never sent: audio, video, frames, transcripts, names, emails,
session or participant ids, file names, paths, error messages, IP addresses of participants (the server's own address is
what PostHog sees, so also switch on "Discard client IP data" in the PostHog project). The set of events is a closed list in
`src/server/telemetry.ts`; adding one is a code change.

## How it works

```mermaid
flowchart LR
  subgraph browser[Each participant's browser]
    GUM[getUserMedia / getDisplayMedia] --> REC[MediaRecorder per kind]
    REC --> OPFS[(OPFS: one file per chunk)]
    OPFS --> UP[Background uploader]
  end
  UP -- "PUT bytes at offset, SHA-256" --> COL[Collector]
  browser -- "clock handshake, presence (SSE)" --> COL
  COL --> ST[(Local disk or S3-compatible)]
  COL -- "after session end: ffmpeg -c copy" --> OUT[audio / camera / screen .webm + manifest.json]
```

**Chunks are not standalone.** `MediaRecorder` slices of one recording only make sense in order and only the first one
carries the WebM header; losing it loses the track. So each recording is treated as one append-only byte stream:

- Locally, every chunk is a separate OPFS file that is written whole and closed before the next one, so a killed tab
  loses at most the chunk in flight. Only the unbroken prefix `0..n` of chunk files counts.
- The collector accepts bytes only at the current end of a track (`PUT .../data?offset=N` with a SHA-256 header). A gap is
  answered with `409` and the offset to resume from, a repeated or overlapping request is trimmed to the new bytes, and a
  corrupted body is refused. The uploader therefore always asks the collector how many bytes it holds and continues from
  exactly there, which is also how recovery after a crash works. The collector rebuilds the byte count from the stored
  parts after a restart.
- After the session ends the parts of each track are joined in order and remuxed with
  `ffmpeg -c copy -cues_to_front 1`. Chunked `MediaRecorder` output has no duration and no seek index; this adds both
  without re-encoding.

**Clock.** Before recording, and every 60 s while recording, the client exchanges NTP-style samples with the collector.
The sample with the smallest round trip gives the offset. A track's start time is the moment of the recorder `start`
event, converted with the offset. A short beep plays when recording starts, and the host can trigger a beep for everyone
at a scheduled server time. With headphones the beep does not reach the microphone, so the UI also asks for one clap.

**Consent and visibility.** Nothing is recorded until a participant ticks the consent box and clicks "Start
recording". The consent text says what is recorded and where it goes. Every participant sees the roster with who is
recording which tracks. The collector stores the consent version and time per participant in the manifest.

**Headphones.** Browsers have no headphone API. The setup screen pre-fills the "I am wearing headphones" checkbox from
device names (AirPods, Headphones, Headset and similar, re-checked when devices change) and says plainly that this is a
guess. A separate test plays a quiet tone and listens on the microphone to detect speaker bleed. Neither blocks you:
you can confirm, or skip with one click.

## Development

```sh
npm run dev:server   # collector with reload (needs the env vars above)
npm run dev:web      # Vite dev server, proxies /api to http://127.0.0.1:8080
npm run check        # typecheck, lint, unit tests
```

### Acceptance test

`npm run test:e2e` builds nothing by itself: run `npm run build` first. It starts the built collector on port 18750
(`E2E_PORT` to change it) with a throw-away data directory, opens two isolated browser contexts with fake camera and
microphone, records a short session, cuts the guest's network for a few seconds (uploads retry, then resume), crashes
the host's renderer mid-recording, reopens the session to resume the upload, ends the session while the guest is still
recording and checks that the output files are seekable, decodable and described by a valid manifest.

`tests/e2e/editor.spec.ts` starts from a synthetic session written to the collector's storage (it needs `ffmpeg`), signs
a host token with the fixed `E2E_SECRET` of `playwright.config.ts`, and drives the cutting tools on the project page:
prepare, transcribe with a stand-in speech engine, delete, undo and redo, reload, silences, preview render. It needs no
fake media devices, so any Chromium works, also one attached with `E2E_CDP_URL`.

`tests/e2e/export.spec.ts` renders an MP3 of an edited program from the page, downloads it and checks its length against
the kept time, checks that the player, transcript and cuts survive the removal of the preview media after the export, and
deletes the export. `tests/e2e/layout.spec.ts` uses a two-camera session: it changes the layout, shape and background
and checks the live preview's geometry, edits and resets a scene by hand, undoes the layout with the keyboard, reloads,
seeks the preview with the test hook, cancels a 4K export and renders a vertical one.

It launches Chromium itself, so install one first (`npx playwright install chromium`) or pick an installed browser with
`E2E_BROWSER_CHANNEL=chrome`. To attach to a Chromium you started yourself, set `E2E_CDP_URL`; for `session.spec.ts` it
must have been started with the flags in `FAKE_MEDIA_ARGS` (see `tests/e2e/session.spec.ts`). The test runs with one
worker because both participants share the machine. The guest also shares a screen (the browser must auto-select a
capture source, which `FAKE_MEDIA_ARGS` does); set `E2E_SCREEN=0` to leave the screen track out.

## Limits and honest notes

- Chromium only. Safari and Firefox are not supported.
- There is no rate limiting and no session expiry on the collector. Put it behind a reverse proxy and use
  `SESSION_CREATE_KEY` if it is reachable from the internet.
- Tokens are passed in the `Authorization` header, except the live event stream, which uses a query parameter because
  `EventSource` cannot set headers. Do not log request URLs on the collector's proxy.
- Local copies live in the browser's origin storage. Clearing site data deletes them, so keep them until the collector
  shows each track as ready.
- The S3-compatible driver stores every uploaded part as its own object and streams the remuxed files with multipart
  upload. The automated tests use the local driver; the driver was also tried once end to end (a two-person session,
  remuxed tracks and manifest written to the bucket) against a local SeaweedFS S3 gateway with path-style addressing.
- Only one browser tab per session and device can record; a second tab is asked to wait until the first one is closed.
- A participant who joins twice (for example after clearing site data) uses up a second place; there is no way to remove
  a participant in v1.
- Remuxing browser output with `-c copy` can log `non monotonically increasing dts` warnings for variable frame rate
  screen captures. The files stay valid and seekable; drift and frame-rate fixes belong to post-production.
- A single collector process owns a session; running several replicas against one bucket is not supported.

## Licence

The fonts and the backdrop photo are third-party assets with their own licences, listed in
[THIRD_PARTY.md](THIRD_PARTY.md).

MIT, see [LICENSE](LICENSE).
