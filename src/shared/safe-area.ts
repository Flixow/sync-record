// Areas of a canvas that stay clear of the platform's own interface (titles, buttons, progress bars).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Canvas {
  width: number;
  height: number;
}

/** Margins as a share of the canvas size. */
interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Vertical video (Shorts, Reels, TikTok) puts the title, channel and buttons over the lower part and the right edge,
 * so text and faces keep clear of them. Horizontal and square video only keeps a title-safe margin.
 */
export function safeMargins(canvas: Canvas): Margins {
  if (canvas.height > canvas.width) return { top: 0.1, right: 0.14, bottom: 0.22, left: 0.06 };
  return { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 };
}

export function safeArea(canvas: Canvas): Rect {
  const m = safeMargins(canvas);
  const x = Math.round(canvas.width * m.left);
  const y = Math.round(canvas.height * m.top);
  return { x, y, w: Math.round(canvas.width * (1 - m.right)) - x, h: Math.round(canvas.height * (1 - m.bottom)) - y };
}

export function insideRect(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}
