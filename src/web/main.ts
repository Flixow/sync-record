import "./styles.css";
import { SessionApi, loadCredentials, saveCredentials } from "./lib/api.js";
import { ProjectApi } from "./lib/project-api.js";
import { Room } from "./lib/room.js";
import { initLang, onLangChange, t } from "./i18n/index.js";
import { claimView, noAccessView } from "./views/access.js";
import { homeView } from "./views/home.js";
import { joinView } from "./views/join.js";
import { projectView } from "./views/project-view.js";
import { roomView } from "./views/room-view.js";

const app = document.getElementById("app");
if (!app) throw new Error("missing #app");

initLang();

let room: Room | null = null;
let roomUnsubscribe: (() => void) | null = null;
let rendering = 0;
let disposeProject: (() => void) | null = null;
let focusHeading = false;

function navigate(path: string): void {
  history.pushState(null, "", path);
  focusHeading = true;
  void render();
}

function show(view: HTMLElement): void {
  app?.replaceChildren(view);
  const heading = view.querySelector("h1");
  document.title = heading?.textContent ? `${heading.textContent} · ${t("brand.name")}` : t("brand.name");
  if (focusHeading && heading) {
    heading.tabIndex = -1;
    heading.focus();
  }
  focusHeading = false;
}

function disposeRoom(): void {
  roomUnsubscribe?.();
  roomUnsubscribe = null;
  room?.dispose();
  room = null;
}

async function renderProject(sid: string, ticket: number): Promise<void> {
  disposeRoom();
  const credentials = loadCredentials(sid);
  if (!credentials?.host) {
    show(noAccessView());
    return;
  }
  // Visiting the page renews the host token (sliding expiry), as the room page does.
  let token = credentials.participantToken;
  try {
    token = (await new SessionApi(sid, token).view()).renewedToken;
    saveCredentials(sid, { ...credentials, participantToken: token });
  } catch {
    // the project calls report an expired token themselves
  }
  if (ticket !== rendering) return;
  const view = projectView(new ProjectApi(sid, token));
  disposeProject = view.dispose;
  show(view.el);
}

async function render(): Promise<void> {
  const ticket = (rendering += 1);
  disposeProject?.();
  disposeProject = null;
  const projectMatch = /^\/project\/([a-z0-9-]+)\/?$/.exec(location.pathname);
  if (projectMatch?.[1]) {
    await renderProject(projectMatch[1], ticket);
    return;
  }
  const claimMatch = /^\/claim\/([a-z0-9-]+)\/?$/.exec(location.pathname);
  if (claimMatch?.[1]) {
    disposeRoom();
    const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : "";
    show(claimView(claimMatch[1], fragment || null, navigate));
    return;
  }
  const match = /^\/join\/([a-z0-9-]+)\/?$/.exec(location.pathname);
  if (!match || !match[1]) {
    disposeRoom();
    const view = await homeView(navigate);
    if (ticket === rendering) show(view);
    return;
  }
  const sid = match[1];
  const credentials = loadCredentials(sid);
  if (!credentials) {
    disposeRoom();
    const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : "";
    show(joinView(sid, fragment || null, navigate));
    return;
  }
  // The invite token only lives in the fragment until it is exchanged; remove it from the address bar.
  if (location.hash) history.replaceState(null, "", location.pathname);

  if (!room || room.sid !== sid) {
    disposeRoom();
    room = new Room(sid, credentials);
    void room.init();
  }
  const view = roomView(room);
  roomUnsubscribe?.();
  let queued = false;
  roomUnsubscribe = room.subscribe(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      view.update();
    });
  });
  if (ticket === rendering) show(view.el);
}

onLangChange(() => void render());
window.addEventListener("popstate", () => {
  focusHeading = true;
  void render();
});
void render();
