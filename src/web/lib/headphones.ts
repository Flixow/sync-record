// Headphone and speaker-bleed heuristics. The browser has no headphone API, so
// everything here is a hint the user confirms; never treat it as certain.

export interface DeviceLabel {
  kind: MediaDeviceKind;
  label: string;
}

export type HeadphoneGuess = "likely" | "unlikely" | "unknown" | "undetermined";

const HEADPHONE_WORDS =
  /airpods|headphone|headset|earbud|earphone|earpods|\bbuds\b|słuchawk|sluchawk|kopfh|casque|auricular|cuffie|wh-1000|wf-1000|quietcomfort|arctis/i;
const SPEAKER_WORDS = /speaker|głośnik|glosnik|built-in|builtin|macbook|display audio|monitor|hdmi|realtek|lautsprecher|haut-parleur/i;

/**
 * "unknown": device names are hidden (no microphone permission yet).
 * "undetermined": names are visible but say nothing about headphones.
 *
 * Guesses from device names whether the user wears headphones. Labels are empty
 * until microphone permission is granted, and wired headphones often look like
 * built-in speakers, so "unknown" and "unlikely" are common and never final.
 */
export function guessHeadphones(devices: DeviceLabel[]): { guess: HeadphoneGuess; matched: string | null } {
  const labelled = devices.filter((device) => device.label.trim() !== "" && device.kind !== "videoinput");
  if (labelled.length === 0) return { guess: "unknown", matched: null };
  for (const device of labelled) {
    if (HEADPHONE_WORDS.test(device.label)) return { guess: "likely", matched: device.label };
  }
  const outputs = labelled.filter((device) => device.kind === "audiooutput");
  if (outputs.length > 0 && outputs.every((device) => SPEAKER_WORDS.test(device.label))) {
    return { guess: "unlikely", matched: null };
  }
  return { guess: "undetermined", matched: null };
}

export type BleedVerdict = "bleed" | "quiet";

/** The tone level must rise this much over the room noise (dB) to count as bleed. */
export const BLEED_THRESHOLD_DB = 10;

/**
 * Compares the microphone level at the test-tone frequency before and during
 * the tone. "quiet" does not prove headphones: a very low speaker volume also
 * stays quiet.
 */
export function analyseBleed(baselineDb: number, toneDb: number): { verdict: BleedVerdict; riseDb: number } {
  // A silent analyser reports -Infinity; a floor keeps the arithmetic finite and the message readable.
  const floor = (db: number): number => (Number.isFinite(db) ? Math.max(db, -120) : -120);
  const riseDb = floor(toneDb) - floor(baselineDb);
  return { verdict: riseDb >= BLEED_THRESHOLD_DB ? "bleed" : "quiet", riseDb };
}
