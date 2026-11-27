import { callTiles, gridColumns, type CallTile, type VideoSource } from "../lib/call-model.js";
import { h, setChildren } from "../lib/dom.js";
import type { Room } from "../lib/room.js";
import { t } from "../i18n/index.js";
import { banner, card } from "./layout.js";

interface TileView {
  el: HTMLElement;
  video: HTMLVideoElement;
  initial: HTMLElement;
  avatarNote: HTMLElement;
  caption: HTMLElement;
  attached: VideoSource | null;
}

/**
 * The conversation card: join, mute, camera, leave and a grid of tiles. Tile elements (and the videos in them) live as long as
 * the tile does, so a picture does not flicker when somebody starts speaking.
 */
export function callCard(room: Room): { el: HTMLElement; update: () => void } {
  const button = (testId: string, classes: string, onclick: () => void): HTMLButtonElement =>
    h("button", { type: "button", class: classes, "data-testid": testId, onclick });
  const joinButton = button("call-join", "btn btn-primary", () => void room.call?.join());
  const muteButton = button("call-mute", "btn", () => void room.call?.toggleMic());
  const cameraButton = button("call-camera", "btn", () => void room.call?.toggleCamera());
  const leaveButton = button("call-leave", "btn btn-ghost", () => void room.call?.leave());
  const soundButton = button("call-sound", "btn btn-small", () => void room.call?.enableAudio());
  const status = h("p", { class: "hint", role: "status", "data-testid": "call-status" });
  const messages = h("div", { class: "banners" });
  const controls = h("div", { class: "row", role: "group", "aria-label": t("call.group") }, muteButton, cameraButton, leaveButton);
  const grid = h("div", { class: "call-grid", role: "list", "aria-label": t("call.grid"), "data-testid": "call-grid" });
  const body = h("div", { class: "stack" });
  const el = card(t("call.title"), body);
  soundButton.textContent = t("call.sound");
  leaveButton.textContent = t("call.leave");
  setChildren(body, h("p", { class: "hint" }, t("call.hint")), messages, joinButton, status, controls, grid);

  const tiles = new Map<string, TileView>();

  function tileView(tile: CallTile): TileView {
    const cached = tiles.get(tile.key);
    if (cached) return cached;
    const video = h("video", { playsinline: true, autoplay: true, muted: true });
    video.muted = true; // the sound of a remote participant comes from the call's own audio elements
    const initial = h("strong");
    const avatarNote = h("small");
    const caption = h("figcaption", { class: "call-caption" });
    const view: TileView = {
      el: h(
        "figure",
        { class: `call-tile call-tile-${tile.kind}`, role: "listitem", "data-testid": `call-tile-${tile.kind}-${tile.member.identity}` },
        video,
        h("div", { class: "call-avatar", "aria-hidden": "true" }, initial, avatarNote),
        caption,
      ),
      video,
      initial,
      avatarNote,
      caption,
      attached: null,
    };
    tiles.set(tile.key, view);
    return view;
  }

  function updateTile(tile: CallTile): HTMLElement {
    const view = tileView(tile);
    if (view.attached !== tile.video) {
      view.attached?.detach(view.video);
      tile.video?.attach(view.video);
      view.attached = tile.video;
    }
    const { member } = tile;
    const mine = member.local;
    const host = room.roster.find((entry) => entry.participantId === member.identity)?.host === true;
    view.el.dataset.video = String(tile.video !== null);
    view.el.dataset.speaking = String(member.speaking);
    view.initial.textContent = (member.name.trim()[0] ?? "?").toUpperCase();
    view.avatarNote.textContent = tile.kind === "camera" ? t("call.tile.noCamera") : "";
    setChildren(
      view.caption,
      h("span", {}, tile.kind === "screen" ? t("call.tile.screen", { name: member.name }) : member.name),
      mine && tile.kind === "camera" ? h("span", { class: "tag" }, t("call.tile.you")) : null,
      host && tile.kind === "camera" ? h("span", { class: "tag" }, t("call.tile.host")) : null,
      !member.micOn && tile.kind === "camera" ? h("span", { class: "tag call-tag-muted", "data-testid": `call-muted-${member.identity}` }, t("call.tile.muted")) : null,
    );
    return view.el;
  }

  function update(): void {
    const call = room.call;
    if (!call) return;
    const inCall = call.state === "connected" || call.state === "reconnecting";
    const connecting = call.state === "connecting";
    joinButton.hidden = inCall;
    joinButton.disabled = connecting || room.permission !== "granted";
    joinButton.textContent = connecting ? t("call.joining") : t("call.join");
    controls.hidden = !inCall;
    grid.hidden = !inCall;
    muteButton.textContent = call.micMuted ? t("call.unmute") : t("call.mute");
    muteButton.setAttribute("aria-pressed", String(call.micMuted));
    cameraButton.textContent = call.cameraMuted ? t("call.cameraOn") : t("call.cameraOff");
    cameraButton.setAttribute("aria-pressed", String(call.cameraMuted));
    cameraButton.disabled = !call.hasCamera;
    status.textContent = inCall
      ? call.state === "reconnecting"
        ? t("call.state.reconnecting")
        : call.members.length <= 1
          ? t("call.alone")
          : t("call.state.connected")
      : room.permission !== "granted"
        ? t("call.needMic")
        : "";
    setChildren(
      messages,
      call.error ? banner("error", call.error, "call-error") : null,
      inCall && call.micMuted && room.headphones !== "yes" ? banner("info", t("call.joinedMuted"), "call-joined-muted") : null,
      inCall && !call.hasCamera && room.permission === "granted" ? h("p", { class: "hint" }, t("call.noCamera")) : null,
      inCall && call.audioBlocked ? h("div", { class: "banner banner-warn" }, h("p", {}, t("call.soundBlocked")), soundButton) : null,
    );
    const wanted = inCall ? callTiles(call.members) : [];
    const keep = new Set(wanted.map((tile) => tile.key));
    for (const [key, view] of tiles) {
      if (keep.has(key)) continue;
      view.attached?.detach(view.video);
      view.el.remove();
      tiles.delete(key);
    }
    grid.style.setProperty("--call-cols", String(gridColumns(wanted.filter((tile) => tile.kind === "camera").length)));
    // Move an element only when its place changed: a video that leaves the document pauses.
    wanted.forEach((tile, index) => {
      const element = updateTile(tile);
      if (grid.children[index] !== element) grid.insertBefore(element, grid.children[index] ?? null);
    });
  }

  return { el, update };
}
