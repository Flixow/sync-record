import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AsrEngine, AsrWord } from "../../src/server/post/asr.js";
import { issueToken } from "../../src/server/tokens.js";
import type { ProjectFile } from "../../src/shared/project.js";
import { validateSrt, validateVtt, type TranscriptFile } from "../../src/shared/transcript.js";
import { api, hasFfmpeg, SECRET, startServer, type TestServer } from "./helpers.js";
import { makeSyntheticSession } from "../support/synthetic.js";

const SID = "transcribe-fixture-0001";

/** Speech stand-in: a 300 Hz tone at -20 dBFS during the given windows (seconds), silence otherwise. */
function toneTrack(file: string, seconds: number, windows: [number, number][], volumeDb: number): void {
  const enable = windows.map(([from, to]) => `between(t,${from},${to})`).join("+") || "0";
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=f=300:r=16000:d=${seconds}`, "-af", `volume=${volumeDb}dB:enable='${enable}',volume=0:enable='1-(${enable})'`, file]);
}

/** Stand-in engine: every chunk yields the same two words, starting 0.1 s into the chunk. */
class FakeEngine implements AsrEngine {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly calls: string[][] = [];
  async ensureModel(): Promise<void> {}
  async transcribe(_ctx: unknown, files: string[]): Promise<AsrWord[][]> {
    this.calls.push(files);
    return files.map(() => [{ w: "Hello,", s: 0.2, e: 0.5 }, { w: "world.", s: 0.6, e: 1.0 }]);
  }
  async detectLanguage(): Promise<string> {
    return "en";
  }
}

describe.runIf(hasFfmpeg())("transcript job on a synthetic session", () => {
  let server: TestServer;
  let token: string;
  let transcript: TranscriptFile;
  let project: ProjectFile;
  const engine = new FakeEngine();
  const get = (route: string) => api(server, "GET", `/api/sessions/${SID}${route}`, { token });
  const text = async (route: string) => (await fetch(`${server.base}/api/sessions/${SID}${route}`, { headers: { authorization: `Bearer ${token}` } })).text();

  beforeAll(async () => {
    const work = mkdtempSync(path.join(tmpdir(), "syncrecord-tone-"));
    // A speaks at 10-13 s and 20-23 s; B has a quiet copy of A's speech (bleed) and speaks alone at 30-33 s; C stays silent.
    toneTrack(path.join(work, "a.wav"), 40, [[10, 13], [20, 23]], -20);
    toneTrack(path.join(work, "b.wav"), 40, [[10, 13], [20, 23]], -45);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=300:r=16000:d=40", "-af", "volume=0", path.join(work, "c.wav")]);
    // B's own speech: add it to the quiet track by mixing a loud window
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", path.join(work, "b.wav"), "-f", "lavfi", "-i", "sine=f=300:r=16000:d=40", "-filter_complex", "[1:a]volume=-20dB:enable='between(t,30,33)',volume=0:enable='1-between(t,30,33)'[own];[0:a][own]amix=inputs=2:normalize=0", path.join(work, "b2.wav")]);
    server = await startServer({ POST_MIN_FREE_GB: "0" }, engine);
    await makeSyntheticSession({
      sessionId: SID,
      storageDir: server.dir,
      durationSec: 40,
      eventsMs: [],
      participants: [
        { name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false, audioFile: path.join(work, "a.wav") },
        { name: "Bartek", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false, audioFile: path.join(work, "b2.wav") },
        { name: "Celina", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false, audioFile: path.join(work, "c.wav") },
      ],
    });
    token = issueToken(SECRET, { sid: SID, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    await api(server, "POST", `/api/sessions/${SID}/project`, { token });
    await api(server, "POST", `/api/sessions/${SID}/project/jobs`, { token, json: { kind: "conform" } });
    await server.app.post.idle();
    const queued = await api(server, "POST", `/api/sessions/${SID}/project/jobs`, { token, json: { kind: "transcribe", params: { lang: "en" } } });
    expect(queued.status).toBe(202);
    await server.app.post.idle();
    transcript = (await get("/project/transcript")).body as unknown as TranscriptFile;
    project = ((await get("/project")).body as { project: ProjectFile }).project;
  }, 120_000);

  afterAll(async () => {
    await server.close();
  });

  it("puts words on the project timeline where the speech was", () => {
    expect(project.transcript.status).toBe("done");
    const anna = transcript.words.filter((word) => word.pid === "p1-anna");
    // both of Anna's utterances fit one chunk, so the engine saw one chunk and returned its two words
    expect(anna).toHaveLength(2);
    // the chunk starts 150 ms before the speech (padding); the word starts 0.2 s into the chunk
    expect(anna[0]?.s).toBeGreaterThan(10_000);
    expect(anna[0]?.s).toBeLessThan(10_400);
    expect(transcript.words.every((word, index, all) => index === 0 || (all[index - 1]?.s ?? 0) <= word.s)).toBe(true);
  });

  it("transcribes nothing on a silent track and drops the bleed copy on the other microphone", () => {
    expect(transcript.words.filter((word) => word.pid === "p3-celina")).toHaveLength(0);
    // Bartek's quiet copies of Anna's speech (10-13 s, 20-23 s) never reach the engine; only his own speech at 30 s does
    const bartek = transcript.words.filter((word) => word.pid === "p2-bartek");
    expect(bartek.length).toBeGreaterThan(0);
    expect(bartek.every((word) => word.s > 29_000)).toBe(true);
  });

  it("serves SRT, VTT and text that validate", async () => {
    const srt = await text("/project/transcript/srt");
    expect(validateSrt(srt)).toEqual([]);
    expect(srt).toContain("Anna: Hello, world.");
    const vtt = await text("/project/transcript/vtt?speakers=0");
    expect(validateVtt(vtt)).toEqual([]);
    expect(vtt).not.toContain("<v ");
    expect(await text("/project/transcript/txt")).toContain("Anna: Hello, world.");
  });

  it("refuses to run before the media is prepared", async () => {
    const other = "transcribe-fixture-0002";
    await makeSyntheticSession({ sessionId: other, storageDir: server.dir, durationSec: 20, eventsMs: [], participants: [{ name: "Anna", startOffsetMs: 0, audioPpm: 0, clientClockPpm: 0, camera: false }] });
    await api(server, "POST", `/api/sessions/${other}/project`, { token: issueToken(SECRET, { sid: other, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 }) });
    const t2 = issueToken(SECRET, { sid: other, role: "participant", pid: "p1-anna", host: true, exp: Date.now() + 3_600_000 });
    await api(server, "POST", `/api/sessions/${other}/project/jobs`, { token: t2, json: { kind: "transcribe" } });
    await server.app.post.idle();
    const state = ((await api(server, "GET", `/api/sessions/${other}/project`, { token: t2 })).body as { project: ProjectFile }).project;
    expect(state.transcript.status).toBe("failed");
    expect(state.transcript.error).toMatch(/conform/);
  });
});
