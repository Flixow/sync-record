// The short text printed on a thumbnail (the "hook"): validation of options from any source, and deterministic options from
// the words spoken at the chosen moment. The language model (src/server/post/llm.ts) only improves on these. Pure.

import { capitalize, startsWithConnective, stem, termsOf, tokenize, type Lang } from "./lexicon.js";
import { HOOK_MAX_WORDS, normalizeHook } from "./thumb-style.js";

/** How many options are offered for a frame. */
export const HOOK_COUNT = 3;

/** A hook as it is shown: no emoji or markdown, no quotation marks, at most five words, no dangling punctuation (`?` and `!` stay). */
export function cleanHook(raw: string): string {
  const plain = raw.replace(/\p{Extended_Pictographic}/gu, " ").replace(/[*_#`~]+/gu, " ");
  return normalizeHook(plain).replace(/^[\s,;:.\-–—…]+|[\s,;:.\-–—…]+$/gu, "").trim();
}

/** The words of a text, lower case, for comparing a hook with the title. */
const key = (text: string): string => tokenize(text).join(" ");

/** True when the hook says what the title already says: the same words, or one inside the other. */
export function repeatsTitle(hook: string, title: string): boolean {
  const a = key(hook);
  const b = key(title);
  return a !== "" && b !== "" && (b.includes(a) || a.includes(b));
}

/** The usable hooks of a list of unknown content: strings only, cleaned, not repeating the title, no duplicates, at most `HOOK_COUNT`. Null when none is usable. */
export function validateHooks(raw: unknown, title: string): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "string") continue;
    const hook = cleanHook(item);
    if (hook === "" || repeatsTitle(hook, title) || out.some((other) => key(other) === key(hook))) continue;
    out.push(hook);
    if (out.length >= HOOK_COUNT) break;
  }
  return out.length > 0 ? out : null;
}

/** Several lists of options as one: in order, without duplicates or repeats of the title, `HOOK_COUNT` at most. */
export function mergeHooks(lists: string[][], title: string): string[] {
  return validateHooks(lists.flat(), title) ?? [];
}

const FILLER = /^(?:well|yeah|okay|ok|right|like|tak|no|dobra|okej|słuchaj)$/u;

/** The first clause of a sentence, when it is a complete thought of two to five words ("Why did the first version fail?"); null otherwise. */
export function leadClause(sentence: string, language: Lang): string | null {
  const words = sentence.trim().split(/\s+/u).filter((word) => word !== "");
  while (words.length > 2 && (startsWithConnective(words[0] as string, language) || FILLER.test(tokenize(words[0] as string).join("")))) words.shift();
  const end = words.findIndex((word) => /[,;:]$/u.test(word));
  const clause = end === -1 ? words : words.slice(0, end + 1);
  const hook = cleanHook(clause.join(" "));
  const count = hook === "" ? 0 : hook.split(" ").length;
  return count >= 2 && clause.length <= HOOK_MAX_WORDS ? capitalize(hook) : null;
}

const TEMPLATES: Record<Lang, ((word: string, display: string) => string)[]> = {
  en: [(word) => `The truth about ${word}`, (_, display) => `${display}: what really matters`, (word) => `What nobody says about ${word}`],
  pl: [(_, display) => `${display}: cała prawda`, (_, display) => `${display}: czego nikt nie mówi`, (_, display) => `${display}: co naprawdę ważne`],
};
const GENERIC: Record<Lang, string[]> = { en: ["You need to hear this", "Watch this"], pl: ["Musisz to usłyszeć", "Zobacz to"] };

export interface HookInput {
  /** What is said at the chosen moment. */
  sentence: string;
  /** The title the hook must not repeat. */
  title: string;
  /** The recording's keywords as written in the transcript, best first. */
  keywords: string[];
  language: Lang;
}

/**
 * Hook options with no model: the first complete clause of the sentence spoken at the frame, then keyword headlines built
 * on the sentence's own keywords before the recording's other keywords. Each has at most five words and none repeats the
 * title; a recording with nothing to go on gets generic ones.
 */
export function fallbackHooks(input: HookInput): string[] {
  const { language } = input;
  const spoken = new Set(termsOf(input.sentence, language));
  const inSentence = input.keywords.filter((word) => spoken.has(stem(word.toLowerCase(), language)));
  const pool = [...new Set([...inSentence, ...input.keywords])].slice(0, 3);
  const lead = leadClause(input.sentence, language);
  const candidates: string[] = lead === null ? [] : [lead];
  for (const template of TEMPLATES[language]) {
    for (const word of pool) candidates.push(template(word, capitalize(word)));
  }
  candidates.push(...GENERIC[language]);
  return mergeHooks([candidates], input.title);
}
