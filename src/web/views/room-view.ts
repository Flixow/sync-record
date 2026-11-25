import type { TrackKind } from "../../shared/protocol.js";
import { MAX_PARTICIPANTS } from "../../shared/protocol.js";
import { clientNowMs } from "../lib/clock.js";
import { h, setChildren } from "../lib/dom.js";
import type { LocalRecording } from "../lib/opfs.js";
import type { Room } from "../lib/room.js";
import { formatBytes, formatDuration, minutesLeft, plannedBytes, PLANNED_HOURS, storageLevel } from "../lib/storage-math.js";
import { getLang, t } from "../i18n/index.js";
import { banner, card, header } from "./layout.js";

const KIND_ORDER: TrackKind[] = ["audio", "camera", "screen"];

function selectOptions(select: HTMLSelectElement, devices: MediaDeviceInfo[], selected: string, fallback: string): void {
  const signature = JSON.stringify([devices.map((d) => [d.deviceId, d.label]), selected]);
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;
  select.replaceChildren(
    ...devices.map((device, index) => {
      const option = h("option", { value: device.deviceId }, device.label || `${fallback} ${index + 1}`);
      option.selected = device.deviceId === selected;
      return option;
    }),
  );
}

/**
 * Builds the room page and returns it with an `update` that mirrors `room`
 * state into the DOM. Controls (inputs, selects, buttons) are created once and
 * re-attached on every update, so focus, open dropdowns and clicks survive the
 * frequent progress updates.
 */
export function roomView(room: Room): { el: HTMLElement; update: () => void } {
  // ---- persistent controls --------------------------------------------------
  const button = (testId: string, classes: string, onclick: () => void): HTMLButtonElement =>
    h("button", { type: "button", class: classes, "data-testid": testId, onclick });
  const checkbox = (id: string, onchange: (checked: boolean) => void): HTMLInputElement => {
    const input = h("input", { type: "checkbox", id, "data-testid": id });
    input.addEventListener("change", () => onchange(input.checked));
    return input;
  };

  const micSelect = h("select", { id: "mic-select", "data-testid": "mic-select" });
  micSelect.addEventListener("change", () => void room.selectMic(micSelect.value));
  const camSelect = h("select", { id: "cam-select", "data-testid": "cam-select" });
  camSelect.addEventListener("change", () => void room.selectCamera(camSelect.value));
  const camCheck = checkbox("want-camera", (checked) => void room.setWantCamera(checked));
  const screenCheck = checkbox("want-screen", (checked) => room.setWantScreen(checked));
  const hpCheck = checkbox("hp-confirm", (checked) => room.setHeadphones(checked ? "yes" : "unset"));
  const consentCheck = checkbox("consent", (checked) => room.setConsent(checked));
  const meterFill = h("div", { class: "meter-fill" });
  const meter = h("div", { class: "meter", role: "meter" }, meterFill);
  const preview = h("video", { class: "preview", playsinline: true, autoplay: true, "data-testid": "camera-preview" });
  preview.muted = true;

  const allowButton = button("allow-media", "btn btn-primary", () => void room.requestPermissions());
  const hpTestButton = button("hp-test", "btn btn-small", () => void room.runBleedTest());
  const hpSkipButton = button("hp-skip", "btn btn-small btn-ghost", () => room.setHeadphones("skipped"));
  const hpUndoButton = button("hp-undo", "btn btn-small", () => room.setHeadphones("unset"));
  const startButton = button("start-recording", "btn btn-primary btn-large", () => void room.start());
  const stopButton = button("stop-recording", "btn btn-danger", () => {
    if (confirm(t("rec.stopConfirm"))) void room.stopMine("stopped");
  });
  const beepButton = button("host-beep", "btn", () => void room.hostBeep());
  const endButton = button("end-session", "btn btn-ghost", () => {
    if (confirm(t("rec.endConfirm"))) void room.endSession();
  });
  const anotherButton = button("record-another", "btn btn-primary", () => void room.recordAnother());
  const forceButton = button("force-end", "btn btn-small btn-ghost", () => {
    const waiting = (room.results?.participants ?? []).filter((p) => p.tracks.some((track) => track.status === "receiving")).map((p) => p.displayName);
    if (confirm(t("res.forceConfirm", { names: waiting.length > 0 ? waiting.join(", ") : "-" }))) void room.endSession(true);
  });
  const refreshButton = button("refresh-results", "btn btn-small", () => void room.pollResults());
  const copyButton = button("copy-invite", "btn btn-small", () => undefined);
  const retryLockButton = button("retry-lock", "btn btn-small", () => void room.retryLock());
  const inviteInput = h("input", { type: "text", readonly: true, "data-testid": "invite-link" });
  inviteInput.addEventListener("focus", () => inviteInput.select());
  const copiedNote = h("span", { class: "hint", role: "status" });
  const timerEl = h("span", { class: "timer", "data-testid": "rec-timer" });

  // ---- containers -----------------------------------------------------------
  const banners = h("div", { class: "banners" });
  const devicesBody = h("div", { class: "stack" });
  const hpBody = h("div", { class: "stack" });
  const storageBody = h("div", { class: "stack" });
  const startBody = h("div", { class: "stack" });
  const recordingBody = h("div", { class: "stack" });
  const trackList = h("ul", { class: "plain-list" });
  const clapSlot = h("div");
  const liveStorageSlot = h("div");
  const finishedBody = h("div", { class: "stack" });
  const resultsList = h("div");
  const rosterBody = h("ul", { class: "plain-list roster", "data-testid": "roster" });
  const localBody = h("ul", { class: "plain-list local-list", "data-testid": "local-recordings" });
  const inviteBody = h("div", { class: "stack" });

  const consentBlock = h(
    "div",
    { class: "stack" },
    h(
      "ul",
      { class: "consent-list" },
      h("li", {}, t("consent.what")),
      h("li", {}, t("consent.where", { host: location.host })),
      h("li", {}, t("consent.visible")),
      h("li", {}, t("consent.local")),
    ),
    h("label", { class: "check", for: "consent" }, consentCheck, h("span", {}, t("consent.check"))),
  );

  const setupCard = card(
    t("setup.title"),
    h("section", { class: "step" }, h("h3", {}, t("setup.devices.title")), devicesBody),
    h("section", { class: "step" }, h("h3", {}, t("hp.title")), hpBody),
    h("section", { class: "step" }, h("h3", {}, t("st.title")), storageBody),
    h("section", { class: "step" }, h("h3", {}, t("consent.title")), consentBlock, startBody),
  );
  const setupEndButton = button("end-session-setup", "btn btn-small btn-ghost", () => {
    if (confirm(t("rec.endConfirm"))) void room.endSession();
  });
  setupEndButton.textContent = t("rec.end");
  setupCard.append(h("div", { class: "row end-row" }, setupEndButton));
  const recordingCard = card(null, recordingBody);
  const finishedCard = card(t("fin.title"), finishedBody);
  const resultsCard = card(t("res.title"), h("p", { class: "hint" }, t("res.body")), resultsList);
  const rosterCard = card(t("roster.title"), rosterBody);
  const localCard = card(t("local.title"), localBody, h("p", { class: "hint" }, t("local.note")));
  const inviteCard = card(t("room.invite.title"), inviteBody);

  // static texts of persistent buttons
  allowButton.textContent = t("setup.allow");
  hpSkipButton.textContent = t("hp.skip");
  hpUndoButton.textContent = t("hp.undo");
  stopButton.textContent = t("rec.stop");
  beepButton.textContent = t("rec.beep");
  beepButton.title = t("rec.beepHint");
  endButton.textContent = t("rec.end");
  anotherButton.textContent = t("fin.again");
  forceButton.textContent = t("res.force");
  refreshButton.textContent = t("res.refresh");
  copyButton.textContent = t("room.invite.copy");
  retryLockButton.textContent = t("room.lock.retry");
  meter.setAttribute("aria-label", t("setup.level"));

  // ---- static layout --------------------------------------------------------
  setChildren(
    recordingBody,
    h("div", { class: "rec-head" }, h("span", { class: "rec-badge", "data-testid": "rec-badge" }, h("span", { class: "dot-live" }), t("rec.live")), timerEl),
    clapSlot,
    liveStorageSlot,
    trackList,
    h("p", { class: "hint" }, t("rec.keepOpen")),
    h("div", { class: "row" }, stopButton, beepButton, endButton),
  );
  setChildren(
    inviteBody,
    h("p", { class: "hint" }, t("room.invite.hint", { max: MAX_PARTICIPANTS })),
    inviteInput,
    copyButton,
    copiedNote,
  );

  // ---- update helpers -------------------------------------------------------
  function updateDevices(): void {
    if (room.permission !== "granted") {
      setChildren(
        devicesBody,
        room.permission === "denied" ? banner("error", t("setup.denied"), "permission-denied") : h("p", { class: "hint" }, t("setup.allowHint")),
        room.deviceError ? banner("error", room.deviceError) : null,
        room.permission === "denied" ? null : allowButton,
      );
      return;
    }
    selectOptions(micSelect, room.devices.mics, room.micId, t("setup.mic"));
    selectOptions(camSelect, room.devices.cameras, room.camId, t("setup.camera"));
    camCheck.checked = room.wantCamera;
    screenCheck.checked = room.wantScreen;
    if (preview.srcObject !== room.previewCamera) preview.srcObject = room.previewCamera;
    const hasCamera = room.devices.cameras.length > 0;
    setChildren(
      devicesBody,
      room.deviceError ? banner("error", room.deviceError) : null,
      h("label", { for: "mic-select" }, t("setup.mic")),
      micSelect,
      meter,
      h("label", { class: "check", for: "want-camera" }, camCheck, h("span", {}, t("setup.recordCamera"))),
      hasCamera ? h("label", { for: "cam-select" }, t("setup.camera")) : h("p", { class: "hint" }, t("setup.noCameraFound")),
      hasCamera ? camSelect : null,
      room.wantCamera && hasCamera ? preview : null,
      h("label", { class: "check", for: "want-screen" }, screenCheck, h("span", {}, t("setup.recordScreen"))),
    );
  }

  function updateHeadphones(): void {
    hpCheck.checked = room.headphones === "yes";
    hpTestButton.textContent = room.bleedBusy ? t("hp.testing") : t("hp.test");
    hpTestButton.disabled = room.bleedBusy || room.permission !== "granted";
    const bleedKind = room.bleed?.verdict === "bleed" ? "warn" : "info";
    setChildren(
      hpBody,
      h("p", {}, t("hp.body")),
      room.headphones === "skipped"
        ? h("div", { class: "stack" }, banner("warn", t("hp.skipped"), "hp-skipped"), hpUndoButton)
        : h(
            "div",
            { class: "stack" },
            h("label", { class: "check", for: "hp-confirm" }, hpCheck, h("span", {}, t("hp.confirm"))),
            h("p", { class: "hint", "data-testid": "hp-guess" }, t(room.guess.guess === "likely" && !room.headphonesAuto ? "hp.guess.found" : `hp.guess.${room.guess.guess}`, { device: room.guess.matched ?? "" })),
            h("div", { class: "row" }, hpTestButton, hpSkipButton),
            room.permission !== "granted" ? h("p", { class: "hint" }, t("hp.testNeedsMic")) : null,
            room.bleed
              ? banner(bleedKind, room.bleed.verdict === "bleed" ? t("hp.bleed", { db: Math.round(room.bleed.riseDb) }) : t("hp.quiet"), "hp-bleed-result")
              : null,
          ),
    );
  }

  function updateStorage(): void {
    const storage = room.storage;
    if (!storage || storage.quota === 0) {
      setChildren(storageBody, h("p", { class: "hint" }, t("st.unknown")));
      return;
    }
    const kinds = room.kinds;
    const level = storageLevel(storage.free, kinds);
    const text = level === "ok" ? t("st.ok") : level === "low" ? t("st.low") : t("st.critical", { minutes: minutesLeft(storage.free, kinds) });
    setChildren(
      storageBody,
      h("p", { "data-testid": "storage-line" }, t("st.line", { free: formatBytes(storage.free), quota: formatBytes(storage.quota), hours: PLANNED_HOURS, need: formatBytes(plannedBytes(kinds)) })),
      banner(level === "ok" ? "ok" : level === "low" ? "warn" : "error", text, `storage-${level}`),
      room.persisted === null ? null : h("p", { class: "hint" }, room.persisted ? t("st.persisted") : t("st.notPersisted")),
    );
  }

  function updateStart(): void {
    const missing = room.missingToStart;
    startButton.disabled = missing.length > 0 || room.starting;
    startButton.textContent = room.starting ? t("start.starting") : t("start.button");
    setChildren(startBody, startButton, missing.length > 0 ? h("p", { class: "hint", "data-testid": "start-missing" }, t("start.missing", { list: missing.join(", ") })) : null);
  }

  function trackRow(recording: LocalRecording, live: boolean): HTMLElement {
    const status = room.uploader.statusOf(recording);
    const uploaded = recording.meta.complete ? recording.totalBytes : status.uploaded;
    const bar = h("div", { class: "bar-fill" });
    bar.style.width = `${Math.min(100, Math.round((uploaded / Math.max(1, recording.totalBytes)) * 100))}%`;
    return h(
      "li",
      { class: "track-row", "data-testid": `track-${recording.meta.kind}`, "data-upload": status.phase },
      h("div", { class: "track-head" }, h("strong", {}, t(`rec.track.${recording.meta.kind}`)), live ? h("span", { class: "dot-live" }) : null, h("span", { class: `pill pill-${status.phase}` }, t(`rec.upload.${status.phase}`))),
      h("div", { class: "bar" }, bar),
      h("div", { class: "muted small" }, `${t("rec.saved", { size: formatBytes(recording.totalBytes) })} · ${t("rec.uploaded", { size: formatBytes(uploaded) })}`),
    );
  }

  const currentRecordings = (): LocalRecording[] =>
    room.recordings
      .filter((rec) => room.recorders.some((r) => r.recording === rec))
      .sort((a, b) => KIND_ORDER.indexOf(a.meta.kind) - KIND_ORDER.indexOf(b.meta.kind));

  function updateRecording(): void {
    const live = new Set(room.recorders.filter((r) => r.active).map((r) => r.recording));
    timerEl.textContent = t("rec.elapsed", { time: formatDuration((clientNowMs() - (room.startedAtMs ?? clientNowMs())) / 1000) });
    beepButton.hidden = !room.isHost;
    endButton.hidden = !room.isHost;
    setChildren(
      clapSlot,
      clientNowMs() < room.clapUntilMs ? h("div", { class: "clap", role: "status", "data-testid": "clap-prompt" }, h("strong", {}, t("rec.clap.title")), h("p", {}, t("rec.clap.body"))) : null,
    );
    const liveStorage = room.liveStorage;
    setChildren(
      liveStorageSlot,
      liveStorage && liveStorage.level !== "ok"
        ? banner(liveStorage.level === "critical" ? "error" : "warn", liveStorage.level === "critical" ? t("st.liveCritical", { minutes: liveStorage.minutes }) : t("st.liveLow", { free: formatBytes(liveStorage.free), minutes: liveStorage.minutes }), "storage-live")
        : null,
    );
    setChildren(trackList, ...currentRecordings().map((rec) => trackRow(rec, live.has(rec))));
  }

  function updateFinished(): void {
    const mine = [...room.recordings].sort((a, b) => a.meta.startClientMs - b.meta.startClientMs || KIND_ORDER.indexOf(a.meta.kind) - KIND_ORDER.indexOf(b.meta.kind));
    const allDone = mine.every((rec) => rec.meta.complete);
    setChildren(
      finishedBody,
      mine.length === 0
        ? banner("info", t("fin.nothing"), "finished-nothing")
        : banner(allDone ? "ok" : "info", allDone ? t("fin.done") : t("fin.uploading"), allDone ? "finished-done" : "finished-uploading"),
      mine.length > 0 ? h("ul", { class: "plain-list" }, ...mine.map((rec) => trackRow(rec, false))) : null,
      room.ended ? null : anotherButton,
      room.isHost && !room.ended ? endButton : null,
    );
    endButton.hidden = false;
  }

  function updateResults(): void {
    const manifest = room.results;
    setChildren(
      resultsList,
      manifest
        ? h(
            "ul",
            { class: "plain-list", "data-testid": "results" },
            ...manifest.participants.flatMap((participant) =>
              participant.tracks.map((track) =>
                h(
                  "li",
                  { class: "result-row", "data-status": track.status },
                  h("span", {}, `${participant.displayName} · ${t(`rec.track.${track.kind}`)}${track.segment > 1 ? ` #${track.segment}` : ""}`),
                  h("span", { class: `pill pill-${track.status}` }, t(`res.status.${track.status}`)),
                  track.file ? h("code", {}, `${participant.participantId}/${track.file}`) : null,
                ),
              ),
            ),
          )
        : null,
      h("div", { class: "row" }, refreshButton, forceButton),
      h("p", { class: "hint" }, t("res.forceHint")),
    );
  }

  function updateRoster(): void {
    setChildren(
      rosterBody,
      ...room.roster.map((entry) => {
        const mine = entry.participantId === room.creds.participantId;
        const lost = entry.state === "recording" && !entry.online;
        const stateText = lost ? t("roster.lost") : !entry.online ? t("roster.offline") : t(`roster.state.${entry.state}`);
        const kinds = entry.kinds.length > 0 ? ` · ${entry.kinds.map((kind) => t(`rec.track.${kind}`)).join(", ")}` : "";
        return h(
          "li",
          { class: "roster-row", "data-testid": `roster-${entry.participantId}`, "data-state": entry.state },
          h("span", { class: `dot ${entry.state === "recording" ? "dot-rec" : entry.online ? "dot-on" : "dot-off"}` }),
          h("span", { class: "roster-name" }, entry.name, mine ? h("span", { class: "tag" }, t("roster.you")) : null, entry.host ? h("span", { class: "tag" }, t("roster.host")) : null),
          h("span", { class: "muted small" }, stateText + kinds),
        );
      }),
    );
  }

  // One row per local recording; the row and its buttons live as long as the recording does.
  const localRows = new Map<string, { li: HTMLElement; info: HTMLElement; pill: HTMLElement }>();
  const empty = h("li", { class: "muted" }, t("local.empty"));

  function localRow(rec: LocalRecording): { li: HTMLElement; info: HTMLElement; pill: HTMLElement } {
    const cached = localRows.get(rec.meta.recordingId);
    if (cached) return cached;
    const download = button(`download-${rec.meta.kind}`, "btn btn-small", () => void room.download(rec));
    download.textContent = t("local.download");
    const remove = button(`delete-${rec.meta.kind}`, "btn btn-small btn-ghost", () => {
      if (confirm(rec.meta.complete ? t("local.deleteComplete") : t("local.deleteIncomplete"))) {
        void room.deleteLocal(rec).then(() => {
          localRows.delete(rec.meta.recordingId);
          room.notify();
        });
      }
    });
    remove.textContent = t("local.delete");
    const info = h("span", { class: "muted small" });
    const pill = h("span", { class: "pill" });
    const li = h(
      "li",
      { class: "local-row", "data-testid": `local-${rec.meta.kind}` },
      h("div", {}, h("strong", {}, t(`rec.track.${rec.meta.kind}`)), info),
      pill,
      h("div", { class: "row" }, download, remove),
    );
    const created = { li, info, pill };
    localRows.set(rec.meta.recordingId, created);
    return created;
  }

  function updateLocal(): void {
    if (room.recordings.length === 0) {
      setChildren(localBody, empty);
      return;
    }
    setChildren(
      localBody,
      ...room.recordings.map((rec) => {
        const row = localRow(rec);
        row.li.dataset.complete = String(rec.meta.complete);
        row.info.textContent = ` ${new Date(rec.meta.startClientMs || Date.now()).toLocaleTimeString(getLang())} · ${formatBytes(rec.totalBytes)}`;
        const phase = room.uploader.statusOf(rec).phase;
        row.pill.className = `pill pill-${rec.meta.complete ? "done" : phase}`;
        row.pill.textContent = rec.meta.complete ? t("local.complete") : t(`rec.upload.${phase}`);
        return row.li;
      }),
    );
  }

  function updateInvite(): void {
    const token = room.creds.inviteToken;
    inviteCard.hidden = !room.isHost || !token;
    if (inviteCard.hidden) return;
    inviteInput.value = `${location.origin}/join/${room.sid}#${token}`;
    copyButton.onclick = () => void navigator.clipboard.writeText(inviteInput.value).then(() => (copiedNote.textContent = t("room.invite.copied")));
  }

  function update(): void {
    const blocks: Node[] = [];
    if (room.missingFeatures.length > 0) blocks.push(banner("error", t("room.unsupported", { missing: room.missingFeatures.join(", ") }), "unsupported"));
    if (room.fatal === "invalid") blocks.push(banner("error", t("join.invalid"), "fatal"));
    if (room.fatal === "notFound") blocks.push(banner("error", t("join.notFound"), "fatal"));
    if (room.lock === "blocked") {
      blocks.push(h("div", { class: "banner banner-warn", "data-testid": "lock-blocked" }, h("strong", {}, t("room.lock.title")), h("p", {}, t("room.lock.body")), retryLockButton));
    }
    if (room.ended && room.phase !== "setup") blocks.push(banner("info", t("room.ended"), "session-ended"));
    if (room.recoveryPending) blocks.push(banner("info", t("local.recovered", { count: room.recoveredCount }), "recovered"));
    if (!room.online) blocks.push(banner("warn", t("err.server"), "offline"));
    for (const notice of room.notices) {
      const el = banner(notice.kind, notice.text, "notice");
      const close = h("button", { type: "button", class: "banner-close", "aria-label": "×" }, "×");
      close.addEventListener("click", () => room.dismissNotice(notice.id));
      el.append(close);
      blocks.push(el);
    }
    setChildren(banners, ...blocks);

    const usable = room.missingFeatures.length === 0 && !room.fatal && room.lock === "held";
    setupCard.hidden = !(usable && room.phase === "setup");
    setupEndButton.hidden = !room.isHost || room.ended;
    recordingCard.hidden = !(usable && room.phase === "recording");
    finishedCard.hidden = !(usable && room.phase === "finished");
    resultsCard.hidden = !(usable && room.isHost && room.ended);
    rosterCard.hidden = !usable;
    // Local copies stay reachable (download, delete) even when the token expired.
    localCard.hidden = !(room.missingFeatures.length === 0 && room.lock === "held");
    inviteCard.hidden = true;
    if (!usable) {
      if (!localCard.hidden) updateLocal();
      return;
    }

    if (room.phase === "setup") {
      updateDevices();
      updateHeadphones();
      updateStorage();
      updateStart();
    } else if (room.phase === "recording") {
      updateRecording();
    } else {
      updateFinished();
    }
    if (!resultsCard.hidden) updateResults();
    updateRoster();
    updateLocal();
    updateInvite();
  }

  const stopLevel = room.onLevel((level) => {
    meterFill.style.width = `${Math.round(level * 100)}%`;
  });

  const sessionTag = h("span", { class: "session-tag", "data-testid": "session-id" }, t("room.session", { id: room.sid.slice(0, 8) }));
  const el = h("div", { class: "shell" }, header(sessionTag), h("main", { class: "page room" }, banners, h("div", { class: "room-grid" }, h("div", { class: "main-col" }, setupCard, recordingCard, finishedCard, resultsCard), h("div", { class: "side-col" }, inviteCard, rosterCard, localCard))));

  // Elapsed time and the clap prompt refresh once a second while recording.
  const ticker = window.setInterval(() => {
    if (!el.isConnected) {
      window.clearInterval(ticker);
      stopLevel();
      return;
    }
    if (room.phase === "recording") updateRecording();
  }, 1000);

  update();
  return { el, update };
}
