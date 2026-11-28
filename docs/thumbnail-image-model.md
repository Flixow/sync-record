# Model-generated thumbnails: design and cost (not built, no API call made)

Status: design only. Nothing in this document is implemented, and no image-generation request has been made. Building it needs a
consent decision (new paid use, frames of the recording leave the server) and an API key on the host.

## What the model should and should not do

Best practice for a YouTube thumbnail: one clear subject (a face with a readable expression, eyes open), high contrast and
saturation, 3-5 big words that add curiosity instead of repeating the title, text on the side opposite the face, legible at 160 px
wide, nothing in the bottom-right corner (timestamp). The deterministic thumbnail (frame preview strip, zoom on the speaker, outlined
hook text) already follows this; the image model is an optional upgrade for a stronger, more designed look.

Rules of the design:

1. **The model never writes the text.** Image models garble Polish diacritics and long words. The headline is drawn by the server
   (`drawtext`, bundled Noto Sans Bold) on top of the model's picture, exactly as for the deterministic thumbnail.
2. **The face comes from the recording.** The model gets one reference frame (the frame the user picked, 1024 px on the long side)
   and is told to keep the person and restyle everything around them (background, light, colour grade, graphic accents). It does not
   invent a person.
3. **Every variant is checked before it is shown** (see step 4) and the deterministic thumbnail stays available as the fallback.
4. **The user stays in control**: nothing is generated until a button is pressed; the button states the number of calls and the cost,
   and that one frame of the video goes to the provider.

## Flow (one episode thumbnail, 3 variants)

| Step | Call | Provider | Input | Output |
|---|---|---|---|---|
| 1 Concept | 1 text call | the existing language model client (`LLM_PROVIDER=anthropic`, Opus 5.5) | title, 2-3 transcript passages around the frame, language, brand colours if known | JSON: 3 hooks (<= 5 words), emotion, background idea, colour scheme, where the face should sit |
| 2 Render | 3 image-edit calls (one per variant, run in parallel) | image provider (below) | the reference frame + a prompt built from step 1 | 3 images, 16:9 |
| 3 Compose | none (ffmpeg on the server) | | the 3 images + the hooks | 3 thumbnails with the headline, 3840x2160 |
| 4 Check | 1 vision call | Opus 5.5 | the 3 composed thumbnails shrunk to 640 px | JSON per variant: face intact, eyes open, text legible at 160 px, text clear of the face, issues; the best one is pre-selected, failing ones are dropped |

Total: 5 calls for 3 variants. "More variants" repeats steps 2-4 (4 calls). A 9:16 Short thumbnail is the same flow with a
1024x1536 canvas and one variant (2-3 calls).

Failure handling: any failed call, a refused request (content policy), a timeout or a failed check falls back to the deterministic
thumbnail with a plain message; no retry loops, a hard per-episode spend cap (`THUMB_AI_MAX_USD`, default 1.00).

## Cost (public list prices read on 2026-11-27; first-party rate cards, exact tokens per image can differ)

| Provider / model | Price per output image | 3 variants | Source |
|---|---|---|---|
| OpenAI gpt-image-2, 1536x1024, medium | $0.041 | $0.12 | OpenAI image generation guide, cost table |
| OpenAI gpt-image-2, 1536x1024, high | $0.165 | $0.50 | same |
| OpenAI gpt-image-2.5 / 2.6 (flare, sunburst) | by tokens, $30 per 1M output tokens; 2.6 reportedly spends ~4x the tokens at low quality [third-party test, unverified] | measure with `usage` | OpenAI pricing page |
| Google Nano Banana 2.1 (`gemini-nano-banana-2.1`), 1K / 2K | $0.0336 / $0.0504 | $0.10 / $0.15 | Gemini API pricing |
| Google Nano Banana Pro (`gemini-3-pro-image`), 1K-2K | $0.134 | $0.40 | Gemini API pricing (third-party restatement) |

Add to the image price: the reference image as input (about 1-4k image tokens, $8 per 1M on OpenAI, so $0.01-0.03 per call
[INFERENCE, token count of one 1024 px reference not measured]) and the two Opus calls (Anthropic list price $4 / $20 per 1M
input / output tokens; the concept call ~2k in + ~2k out including thinking ~ $0.05, the check call with three 640 px images
~5k in + ~1k out ~ $0.04).

Estimated per episode (5 calls): about $0.25-0.30 with gpt-image-2 medium or Nano Banana 2.1 at 2K, about $0.65-0.70 with
gpt-image-2 high or Nano Banana Pro. Five Shorts thumbnails (1 variant each) add about $0.25 at medium quality.
At 20 episodes a month: about $5-6 (medium) to $13-14 (high) for the long-video thumbnails alone.

## Privacy and compliance

- One frame of the recording (a face) goes to a third party for every generation. The README promises that no frames leave the
  server today; this feature would need an instance switch (`THUMB_AI_PROVIDER` empty = off, the default), a visible notice on the
  button, and the guests' consent (a guest's face may be in the frame; the host decides before enabling).
- Transcript text already goes to the language model when it is configured; the thumbnail concept call sends the same kind of text.
- No audio and no video leave the server, only one still per generation.
- The provider's terms on training with API data must be checked before enabling (not verified here).

## Server design (when approved)

- `src/server/post/thumbnail-ai.ts`: provider registry like `llm.ts` (`openai-images`, `gemini-image`), one request per variant,
  1 MB-class response caps, no redirects, timeouts, the same failure codes; key from `THUMB_AI_API_KEY` / `_FILE` (never in a
  response); off unless provider and key exist.
- `src/shared/thumb-brief.ts`: the pure half: prompt builder and validation of the concept JSON (hook length, enums, colours) and of the
  check JSON; a variant the check does not pass is never offered.
- Job kind `thumbnail-ai` on the existing queue (progress: concept, render, compose, check), results saved like other exports.
- UI: a second button in the Cover step, `Generate with AI (about $0.30)`, disabled with a reason when not configured.

## Evaluation without paid calls

- Concept and check calls can be evaluated with the OMP subscription models (Haiku/Sonnet) on recorded frames before any image
  model is paid for; the quality of the image model itself can only be judged with a real call (a handful of test generations).
- Open decisions are in the case report: provider/model, quality level, variant count, monthly cap, consent about faces.
