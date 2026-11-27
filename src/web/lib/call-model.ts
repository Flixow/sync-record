/** What the call stage draws, independent of LiveKit: members, their tiles and the grid. */

/** A track a tile can show (the LiveKit track objects have these two methods). */
export interface VideoSource {
  attach(element: HTMLMediaElement): HTMLMediaElement;
  detach(element: HTMLMediaElement): HTMLMediaElement;
}

export interface CallMember {
  /** The SyncRecord participant id. */
  identity: string;
  name: string;
  local: boolean;
  micOn: boolean;
  speaking: boolean;
  /** The camera picture; null while the camera is off or not received yet. */
  camera: VideoSource | null;
  screen: VideoSource | null;
}

export interface CallTile {
  /** Stable across updates, so the view keeps the same element (and its video) for the same tile. */
  key: string;
  member: CallMember;
  kind: "camera" | "screen";
  video: VideoSource | null;
}

/**
 * Screens first (they are what people look at), then cameras with the local participant first, each group in join order.
 * Your own screen has no tile: a tile of the screen you are sharing would show itself, picture in picture, without end.
 */
export function callTiles(members: readonly CallMember[]): CallTile[] {
  const screens: CallTile[] = members.filter((member) => member.screen && !member.local).map((member) => ({ key: `${member.identity}:screen`, member, kind: "screen", video: member.screen }));
  const cameras: CallTile[] = [...members]
    .sort((a, b) => Number(b.local) - Number(a.local))
    .map((member) => ({ key: `${member.identity}:camera`, member, kind: "camera", video: member.camera }));
  return [...screens, ...cameras];
}

/** Columns of the camera grid: 1 for one tile, 2 up to four, 3 up to nine, then 4. */
export function gridColumns(tiles: number): number {
  if (tiles <= 1) return 1;
  if (tiles <= 4) return 2;
  if (tiles <= 9) return 3;
  return 4;
}
