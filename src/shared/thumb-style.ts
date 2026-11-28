// How a thumbnail is composed: where the speaker sits in the picture, which side the headline takes, its colour and the
// wording rules. Pure; the server renders it (src/server/post/thumbnail-frame.ts) and the browser shows the same defaults.

import type { ThumbnailKind } from "./publish.js";
import type { Canvas, Rect } from "./safe-area.js";

export type ThumbnailColor = "white" | "yellow";
export const THUMBNAIL_COLORS: readonly ThumbnailColor[] = ["white", "yellow"];
/** Fill colours of the headline presets, `RRGGBB`. */
export const THUMBNAIL_COLOR_HEX: Record<ThumbnailColor, string> = { white: "FFFFFF", yellow: "FFD400" };

/** The headline takes the left or the right third of a video thumbnail; a Short's headline sits at the top. */
export type ThumbnailSide = "left" | "right";
export const THUMBNAIL_SIDES: readonly ThumbnailSide[] = ["left", "right"];

/** A headline of more than this many words is unreadable at the size of a suggestion on a phone. */
export const HOOK_MAX_WORDS = 5;
/** Hard limit on the characters of a headline (five long words). */
export const HOOK_MAX_CHARS = 60;

/** Where a face usually sits in a webcam picture, as a share of its width and height (`LayoutInput.focus`). */
export const THUMBNAIL_FOCUS = { x: 0.5, y: 0.38 } as const;
/** How far the picture is enlarged onto the speaker: a video thumbnail 1.25 times, a Short (already a narrow crop) not at all. */
export const THUMBNAIL_ZOOM: Record<ThumbnailKind, number> = { video: 1.25, short: 1 };
/** Where the face lands in the thumbnail (share of its width, when the text is on the left; mirrored when it is on the right) and of its height. */
export const FACE_TARGET = { x: 0.64, y: 0.46 } as const;

/** The side the text goes to when the user did not choose: opposite of the face (a face on the left half pushes the text to the right). */
export const defaultTextSide = (focus: { x: number; y: number } = THUMBNAIL_FOCUS): ThumbnailSide => (focus.x < 0.5 ? "right" : "left");

const even = (n: number): number => Math.round(n / 2) * 2;
const evenDown = (n: number): number => Math.floor(n / 2) * 2;
const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n));

export interface ThumbnailFraming {
  /** The size the program picture is composed at: the thumbnail enlarged by the zoom. */
  compose: Canvas;
  /** The window cut out of it, null when nothing is cut (no zoom). */
  crop: Rect | null;
}

/**
 * Zoom and crop onto the speaker: the picture is composed `zoom` times larger than the thumbnail (one resample, no second
 * one), then the window is cut so the face (at `focus` of the picture) lands on the side opposite the text, a little below
 * the middle. The window stays inside the picture, so a face near an edge lands as close to the target as the picture allows.
 */
export function thumbnailFraming(canvas: Canvas, kind: ThumbnailKind, side: ThumbnailSide, focus: { x: number; y: number } = THUMBNAIL_FOCUS): ThumbnailFraming {
  const zoom = THUMBNAIL_ZOOM[kind];
  if (!(zoom > 1)) return { compose: { ...canvas }, crop: null };
  const compose = { width: Math.max(canvas.width, even(canvas.width * zoom)), height: Math.max(canvas.height, even(canvas.height * zoom)) };
  const targetX = side === "left" ? FACE_TARGET.x : 1 - FACE_TARGET.x;
  const x = clamp(evenDown(focus.x * compose.width - targetX * canvas.width), 0, compose.width - canvas.width);
  const y = clamp(evenDown(focus.y * compose.height - FACE_TARGET.y * canvas.height), 0, compose.height - canvas.height);
  return { compose, crop: { x, y, w: canvas.width, h: canvas.height } };
}

/** The words of a headline: no control characters, single spaces, no quotation marks around it, at most `HOOK_MAX_WORDS` words. */
export function normalizeHook(text: string): string {
  const plain = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["'“”„«»‘’]+|["'“”„«»‘’]+$/gu, "")
    .trim();
  const words = plain.split(" ").filter((word) => word !== "");
  return words.slice(0, HOOK_MAX_WORDS).join(" ").slice(0, HOOK_MAX_CHARS).trim();
}

export interface ThumbnailStyle {
  /** The headline as typed (normalised); empty for a thumbnail without text. */
  text: string;
  color: ThumbnailColor;
  /** The side the user chose; null lets `defaultTextSide` decide. */
  side: ThumbnailSide | null;
}

/** The style of a thumbnail job from its (untrusted) parameters: anything that is not a known value falls back to the default. */
export function parseThumbnailStyle(params: Record<string, unknown>): ThumbnailStyle {
  return {
    text: typeof params.text === "string" ? normalizeHook(params.text) : "",
    color: params.color === "yellow" ? "yellow" : "white",
    side: params.side === "left" || params.side === "right" ? params.side : null,
  };
}
