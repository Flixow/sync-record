import {
  backgroundCss,
  canvasFor,
  CANVASES,
  computeTiles,
  tileCss,
  type Aspect,
  type Background,
  type LayoutSource,
  type Tile,
} from "../../shared/layout.js";
import { sceneAt, type Scene } from "../../shared/scenes.js";
import { h } from "../lib/dom.js";
import { t } from "../i18n/index.js";
import type { Stage } from "./stage.js";

/** The long edge of the preview canvas in CSS pixels. */
export const PREVIEW_LONG_EDGE = 640;
/** A playing picture further than this from the audio is moved back (a seek is visible, so smaller drifts are left alone). */
const DRIFT_LIMIT_S = 0.08;
/** A paused picture is moved as soon as it is off the audio by more than this. */
const PAUSED_EPSILON_S = 0.001;
/** How long the test hook waits for a picture before it gives up on it. */
const SHOWN_TIMEOUT_MS = 8000;
/** A presented frame further than this from the seek target is a stale one. */
const STALE_FRAME_S = 0.1;

/** A picture the preview can show: its size for the layout and the proxy to play (null when the proxies are removed). */
export interface PreviewSource extends LayoutSource {
  name: string;
  /** URL of the 480p proxy on the project timeline. */
  video: string | null;
}

export interface PreviewState {
  /** Scenes on the project timeline. */
  scenes: Scene[];
  aspect: Aspect;
  background: Background;
}

export interface LayoutPreview {
  el: HTMLElement;
  /** New scenes, shape or background. */
  update(state: PreviewState): void;
  /** Puts the pictures at the audio's position; called on every frame while playing. */
  tick(ms: number): void;
  /** Test hook: stops, seeks to `ms` and resolves once every visible picture has shown the frame of that instant. */
  seekMs(ms: number): Promise<void>;
  dispose(): void;
}

interface Entry {
  source: PreviewSource;
  /** The tile: a video of the proxy, or a plain box when the proxy is gone. */
  tile: HTMLElement;
  /** A second copy of the picture for a blurred background, made when one is first needed. */
  backdrop: HTMLVideoElement | null;
}

declare global {
  interface Window {
    __syncPreview?: { seekMs(ms: number): Promise<void>; canvasSelector: string };
  }
}

const noop = (): void => undefined;

function makeVideo(src: string, testId: string, className: string): HTMLVideoElement {
  const video = h("video", { class: className, preload: "auto", playsinline: true, tabindex: -1, "aria-hidden": "true", "data-testid": testId, src });
  video.muted = true;
  video.disablePictureInPicture = true;
  return video;
}

/**
 * The picture of the program as the browser draws it: a container with the canvas's aspect ratio, a background and one
 * <video> per source positioned by the same tiles the renderer uses (`computeTiles`, `tileCss`). The videos play the
 * proxies and follow the audio element; every scene boundary only changes where they sit.
 */
export function layoutPreview(stage: Stage, sources: PreviewSource[], initial: PreviewState): LayoutPreview {
  const { audio } = stage;
  let state = initial;
  const entries = new Map<string, Entry>();
  const container = h("div", { class: "lay-canvas", "data-testid": "pj-lay-canvas", role: "img", "aria-label": t("pj.lay.preview") });
  const backdropLayer = h("div", { class: "lay-backdrop" });
  container.append(backdropLayer);
  for (const source of sources) {
    const tile = source.video
      ? makeVideo(source.video, "pj-lay-video", "lay-tile")
      : h("div", { class: "lay-tile lay-empty", "data-testid": "pj-lay-empty" }, source.name);
    tile.dataset.source = source.id;
    tile.hidden = true;
    container.append(tile);
    entries.set(source.id, { source, tile, backdrop: null });
  }

  let appliedScene: Scene | null = null;
  let dirty = true;
  let visible = new Set<HTMLVideoElement>();
  let disposed = false;

  function layoutSize(): void {
    const canvas = canvasFor(state.aspect, PREVIEW_LONG_EDGE);
    container.style.width = `${canvas.width}px`;
    container.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
    container.dataset.aspect = state.aspect;
  }

  /** Blur and its bleed scale with the rendered size of the container, which is smaller than the canvas on a narrow page. */
  function styleBackground(): void {
    const canvas = CANVASES[state.aspect];
    const css = backgroundCss(state.background, canvas);
    container.style.backgroundColor = css.backgroundColor;
    const scale = container.clientWidth > 0 ? container.clientWidth / canvas.width : 1;
    const blur = css.blurPx * scale;
    container.style.setProperty("--lay-blur", `${blur.toFixed(2)}px`);
    // the blurred copy is drawn larger than the container, so the blur does not fade into transparent edges
    container.style.setProperty("--lay-bleed", `${(blur * 2).toFixed(2)}px`);
  }

  const backdropOf = (entry: Entry): HTMLVideoElement | null => {
    if (!entry.source.video) return null;
    if (!entry.backdrop) {
      entry.backdrop = makeVideo(entry.source.video, "pj-lay-bg-video", "lay-bg-video");
      entry.backdrop.hidden = true;
      backdropLayer.append(entry.backdrop);
    }
    return entry.backdrop;
  };

  function syncOne(video: HTMLVideoElement, ms: number, hard: boolean): void {
    const playing = !audio.paused && !audio.ended;
    const target = ms / 1000;
    const drift = Math.abs(video.currentTime - target);
    if (hard || (!video.seeking && drift > (playing ? DRIFT_LIMIT_S : PAUSED_EPSILON_S))) video.currentTime = target;
    if (playing) {
      if (video.paused) void video.play().catch(noop);
    } else if (!video.paused) {
      video.pause();
    }
  }

  /** Puts the tiles of `scene` on the canvas; returns the videos that are on screen now. */
  function place(scene: Scene | null): Set<HTMLVideoElement> {
    layoutSize();
    styleBackground();
    const shown = new Set<HTMLVideoElement>();
    const canvas = CANVASES[state.aspect];
    const layoutSources = scene ? scene.sources.map((id) => entries.get(id)?.source).filter((source): source is PreviewSource => source !== undefined) : [];
    const { tiles } = scene && layoutSources.length > 0
      ? computeTiles({ layout: scene.layout, canvas, sources: layoutSources, ...(scene.fit ? { fit: scene.fit } : {}), background: state.background })
      : { tiles: [] as Tile[] };
    const placed = new Set<string>();
    tiles.forEach((tile, index) => {
      const entry = entries.get(tile.sourceId);
      if (!entry) return;
      placed.add(tile.sourceId);
      Object.assign(entry.tile.style, tileCss(tile, canvas));
      entry.tile.style.zIndex = String(index + 1);
      entry.tile.hidden = false;
      if (entry.tile instanceof HTMLVideoElement) shown.add(entry.tile);
    });
    for (const [id, entry] of entries) {
      if (placed.has(id)) continue;
      entry.tile.hidden = true;
      if (entry.tile instanceof HTMLVideoElement && !entry.tile.paused) entry.tile.pause();
    }
    // a blurred background is the featured picture, as the renderer draws it
    const featured = state.background.kind === "blur" ? tiles[0]?.sourceId : undefined;
    for (const [id, entry] of entries) {
      const backdrop = id === featured ? backdropOf(entry) : entry.backdrop;
      if (!backdrop) continue;
      backdrop.hidden = id !== featured;
      if (id === featured) shown.add(backdrop);
      else if (!backdrop.paused) backdrop.pause();
    }
    container.dataset.layout = scene ? scene.layout : "";
    container.dataset.sceneStart = scene ? String(scene.s) : "";
    container.dataset.tiles = String(tiles.length);
    return shown;
  }

  function tick(ms: number, hard = false): void {
    if (disposed) return;
    const scene = sceneAt(state.scenes, ms);
    if (dirty || scene !== appliedScene) {
      const before = visible;
      visible = place(scene);
      appliedScene = scene;
      dirty = false;
      for (const video of visible) syncOne(video, ms, hard || !before.has(video));
      return;
    }
    for (const video of visible) syncOne(video, ms, hard);
  }

  const onAudio = (): void => tick(audio.currentTime * 1000);
  for (const type of ["play", "pause", "seeked", "ratechange"]) audio.addEventListener(type, onAudio);
  const resize = new ResizeObserver(() => {
    styleBackground();
  });
  resize.observe(container);
  container.addEventListener("click", () => {
    if (audio.paused) void audio.play().catch(noop);
    else audio.pause();
  });

  /** Resolves when `video` shows the frame of its current position (a seek, then a presented frame). */
  function shown(video: HTMLVideoElement): Promise<void> {
    return new Promise((resolve) => {
      const give = setTimeout(resolve, SHOWN_TIMEOUT_MS);
      const finish = (): void => {
        clearTimeout(give);
        // one more frame: the compositor has drawn the picture before the caller reads the page
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      };
      const presented = (): void => {
        // a seek to the frame already on screen presents nothing new, so the callback is not waited for forever
        const fallback = setTimeout(finish, 300);
        // a frame presented from before the seek (still in the compositor) is not the answer: ask for the next one
        const wait = (): void => {
          video.requestVideoFrameCallback((_now, metadata) => {
            if (Math.abs(metadata.mediaTime - video.currentTime) > STALE_FRAME_S && video.readyState >= 2) {
              wait();
              return;
            }
            clearTimeout(fallback);
            finish();
          });
        };
        wait();
      };
      if (!video.seeking && video.readyState >= 2) presented();
      else video.addEventListener("seeked", presented, { once: true });
    });
  }

  layoutSize();
  styleBackground();
  tick(audio.currentTime * 1000);

  return {
    el: container,
    update(next) {
      state = next;
      dirty = true;
      tick(audio.currentTime * 1000);
    },
    tick: (ms) => tick(ms),
    async seekMs(ms) {
      audio.pause();
      stage.player.seek(ms);
      const landed = Math.abs(audio.currentTime * 1000 - ms) < 2 ? ms : audio.currentTime * 1000;
      tick(landed, true);
      await Promise.all([...visible].map((video) => shown(video)));
    },
    dispose() {
      disposed = true;
      for (const type of ["play", "pause", "seeked", "ratechange"]) audio.removeEventListener(type, onAudio);
      resize.disconnect();
      for (const entry of entries.values()) {
        for (const video of [entry.tile, entry.backdrop]) {
          if (video instanceof HTMLVideoElement) {
            video.pause();
            video.removeAttribute("src");
            video.load();
          }
        }
      }
      container.replaceChildren();
    },
  };
}
