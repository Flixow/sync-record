# Episode timeline

A video-editor style view in the Episode step: what was recorded per participant, what the episode shows and plays at every moment,
and a way to change what is on the canvas for a stretch of time.

## What it shows

Top to bottom, on one shared time axis:

| Lane | Source of the data |
| --- | --- |
| Ruler | project duration, tick step follows the zoom |
| Picture (program) | `SceneState.scenes`: the scenes the episode uses now (automatic plan with the manual overrides on top). A block carries the main source, the layout when it shows several, and a mark when the stretch is manual |
| Sound (program) | the loudest participant per instant, from the peak files of the participants' microphones. The preview mix and the export contain every microphone, so this lane says whose voice carries the moment |
| per participant: Audio | waveform of the participant's microphone tracks (`api.peaks`, one lane per participant, several segments combined) |
| per participant: Camera, Screen | the stretches of the project in which the participant's camera / screen share exists (`offsetMs`, `timelineDurationMs`) |

A participant without a camera has an Audio lane only; the picture lane shows his name card while he is the main source.
Removed ranges (the cut list of the transcript editor) are hatched over all lanes. The playhead is one line over all lanes.

## Moving

- Click anywhere on the lanes: the player jumps there (`Stage.seek`). The transcript, the layout preview and the old overview strip follow, as they do for every seek.
- Click a word in the transcript: `Stage.seek` is already called; the timeline follows through `Stage.onSeek` and scrolls the playhead into view.
- A range slider over the whole episode scrubs the playhead (`aria-valuetext` is the clock). Arrow keys on the lanes move by 1 s, with Shift by 10 s; Home/End jump to the ends.
- Zoom: buttons, Ctrl/Cmd + wheel (around the pointer), Fit. The lanes scroll horizontally. While playing the view follows the playhead (option "Follow").

## Editing the canvas

Pointer drag on the lanes selects a range (snapped to 100 ms, at least 200 ms); a click on the Picture lane selects the scene under it. The
selection panel offers:

- **Main picture**: any source the layouts can show (cameras, screens, name cards), taken from `SceneState.sources`. Writes `SceneOverride { s, e, sources: [picked, ...rest of the scene at the start] }`.
- **Layout**: any layout id. Writes `SceneOverride { s, e, layout }`.
- **Automatic again**: `SceneState.resetRange(s, e)` drops every override touching the range.

This is the same data and the same calls as the scene table of the layout fold, so there is one source of truth: the override list in
`scenes.json` (saved with the revision check, undo/redo history in `SceneState`, one undo step per change, picked up by the preview and by the
export). The timeline has Undo, Redo and "All automatic" for the whole plan next to its own save status. No new storage, no new endpoint.

What it does not do: change audio. Every microphone is always in the mix; the Sound lane is information. Choosing a source "for audio" would
be a second plan next to the scene plan and is not part of this change.

## Structure

- `src/shared/episode-timeline.ts`: pure model (lanes of a project, loudest-participant runs, zoom and range maths, override for a range) with unit tests.
- `src/web/views/episode-timeline.ts`: the view. Lanes are laid out in one scroll area; waveform, sound and ruler are painted on a canvas that covers the visible window only (sticky), so a long episode at high zoom never allocates a huge canvas.
- `src/web/views/scene-sources.ts`: the names of the sources, shared with the layout panel (one place that turns a `LayoutSource` into a participant label).
- The layout panel receives the `SceneState` from the page instead of creating it, so the fold and the timeline edit one plan.
