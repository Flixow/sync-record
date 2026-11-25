// Small word lists and text helpers shared by clip suggestions, chapters and publishing drafts (English and Polish).
// Everything here is pure; the lists are deliberately short: they only have to be good enough for heuristics.

import { wordKey, type TranscriptWord } from "./transcript.js";

export type Lang = "en" | "pl";

const set = (text: string): Set<string> => new Set(text.split(/\s+/).filter((word) => word !== ""));

/** Words that carry no topic (union of both languages is used for term extraction, so mixed-language talk still works). */
const STOP_EN = set(`
  about above after again against all also although always among and any anyway are aren around because been before being below
  between both but can cannot could couldn did didn does doesn doing don down during each even ever every few for from further
  get gets getting got had hadn has hasn have haven having her here hers herself him himself his how however into its itself
  just let like many may maybe might more most much must myself nor not now off once only other our ours ourselves out over own
  quite really rather said same say she should shouldn since some still such than that the their theirs them themselves then
  there these they this those though through thus too under until upon very was wasn were weren what when where whether which
  while who whom whose why will with won would wouldn yeah yes yep you your yours yourself yourselves one two three going know
  think mean thing things actually kind sort okay right oh well got want need make made take took come came look see seen
  said says told tell sure thanks thank please mhm hmm yes new first second last next good great
`);

const STOP_PL = set(`
  aby ale bardzo bez bo być byli była było były będzie będą bym byś czyli czy coś dla dlatego gdy gdyby gdzie go ich jak jako
  jaki jakie jakiś jeden jego jej jeśli jeżeli jednak jeszcze kiedy każdy która które którzy którego której którym którą który
  mam masz mamy mają mogą może można mnie między nad nam nas nasz nasze nawet nic nie nich nim niż oraz pod ponieważ potem
  przed przez przy sobie tak także takie taki taka tam tego tej ten też tego teraz tutaj tych tylko tym wiec więc wiele wszyscy
  wszystko wszystkie właśnie wtedy zatem również żeby jestem jesteś jesteśmy jest są był była było były będzie będą jeśli
  dobrze okej super trochę natomiast innych inne inny własne każde jakie ktoś nich nimi nami wami one oni ona ono ten ta to
  aha eee yyy tzn itd itp się trzy dwa dwie kilka gdzie wszystkim tego nowy nowe lub albo ani został została zostało zostały pierwszy pierwsza pierwsze
`);

export const STOP_WORDS: ReadonlySet<string> = new Set([...STOP_EN, ...STOP_PL]);

/** Function words that occur in one language only; they decide which language a transcript is in. */
const MARKERS_EN = set("the and of is you that it was for with this have are not they what but his her she from will would there their been which when your about can had were");
const MARKERS_PL = set("nie się że jest na jak ale czy tak już jego jej ten tym przez dla oraz tylko który która które mnie mam być będzie bardzo więc może gdy też po od co do");

/** The language of a text, judged from function words and Polish letters; English when there is nothing to go on. */
export function detectLanguage(words: Pick<TranscriptWord, "t">[]): Lang {
  let en = 0;
  let pl = 0;
  let letters = 0;
  let polishLetters = 0;
  for (const word of words) {
    const key = word.t.toLowerCase().replace(/[^\p{L}]+/gu, "");
    if (key === "") continue;
    if (MARKERS_EN.has(key)) en += 1;
    if (MARKERS_PL.has(key)) pl += 1;
    for (const char of key) {
      letters += 1;
      if ("ąćęłńóśźż".includes(char)) polishLetters += 1;
    }
  }
  if (letters > 0 && polishLetters / letters > 0.015) pl += Math.ceil(words.length * 0.02) + 1;
  return pl > en ? "pl" : "en";
}

/** Words that start a clause which depends on the one before it: a clip starting on one of these begins mid-thought. */
const CONNECTIVES_EN = set("and but so or nor yet because cause cuz then also plus which whereas although though anyway");
const CONNECTIVES_PL = set("i a ale więc wiec bo ponieważ czyli oraz lub albo natomiast jednak zatem dlatego że żeby gdyż choć chociaż");

/**
 * Whether a sentence starting with this word is a continuation. English "I" is a pronoun and never a connective; Polish "i"
 * (and, even when capitalised at the start of a sentence) is.
 */
export function startsWithConnective(firstWord: string, lang: Lang): boolean {
  const key = wordKey(firstWord);
  if (key === "") return false;
  return (lang === "pl" ? CONNECTIVES_PL : CONNECTIVES_EN).has(key);
}

/** Short reactions that say nothing by themselves. */
const BACKCHANNEL = set(`
  yeah yes yep yup no nope right okay ok sure mhm mm hmm hm uh um oh ah wow really true exactly indeed alright cool great nice thanks
  thank you huh aha tak nie jasne okej dobrze właśnie super rozumiem ach och serio dokładnie racja dzięki dziękuję hmm eee
`);

/** A sentence of one word, or of up to three words that are all reactions ("yeah right", "no, no", "tak, jasne"). */
export function isBackchannel(sentenceWords: { t: string }[]): boolean {
  if (sentenceWords.length === 1) return true;
  if (sentenceWords.length > 3) return false;
  return sentenceWords.every((word) => BACKCHANNEL.has(wordKey(word.t)));
}

/**
 * Abbreviations after which a full stop does not end the sentence: titles always, the others only when the next word is
 * not capitalised (so "np. kawa" does not split, "…itd. Potem" does).
 */
export const ABBREVIATION_TITLES: ReadonlySet<string> = set("mr mrs ms dr prof sr jr st vs mgr inż hab ks gen płk kpt ppłk im św");
export const ABBREVIATION_SOFT: ReadonlySet<string> = set(`
  etc inc ltd corp fig approx dept est vol no al np itd itp tzn tzw tj godz ul os pl pt tys mln mld ok ww zob por wg ang łac
  r w ur zm cm km kg mm ml tel
`);

// ---- terms ------------------------------------------------------------------------------------------------------------

/** Lower-case word pieces of a text; apostrophes split ("don't" gives "don" and "t", both short enough to be dropped). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** A cheap stem: Polish words keep their first five letters, English words lose common suffixes. */
export function stem(token: string, lang: Lang): string {
  if (lang === "pl") return token.length > 5 ? token.slice(0, 5) : token;
  let word = token;
  if (word.length > 4 && word.endsWith("ies")) word = `${word.slice(0, -3)}y`;
  else if (word.length > 4 && word.endsWith("sses")) word = word.slice(0, -2);
  else if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us") && !word.endsWith("is")) word = word.slice(0, -1);
  if (word.length > 5 && word.endsWith("ing")) word = word.slice(0, -3);
  else if (word.length > 4 && word.endsWith("ed")) word = word.slice(0, -2);
  else if (word.length > 5 && word.endsWith("ly")) word = word.slice(0, -2);
  return word;
}

/** A content term: a stem of a word that is not a stop word, not a number and at least three letters long. */
export function termsOf(text: string, lang: Lang): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) {
    if (token.length < 3 || /^\p{N}+$/u.test(token) || STOP_WORDS.has(token)) continue;
    out.push(stem(token, lang));
  }
  return out;
}

/** Joins transcript tokens into text: pieces the engine split off ("-Fi", "'s", ",500") are glued to the word before. */
export function joinWords(words: Pick<TranscriptWord, "t">[]): string {
  let out = "";
  for (const word of words) {
    const text = word.t.trim();
    if (text === "") continue;
    const glue = /^[-'’]\p{L}/u.test(text) || /^[.,]\d/.test(text) || /^[,.;:!?)\]]+$/.test(text);
    out += out === "" || glue ? text : ` ${text}`;
  }
  return out;
}

export const capitalize = (text: string): string => (text === "" ? text : text.charAt(0).toUpperCase() + text.slice(1));

/** Cuts text to at most `max` characters at a word boundary, with an ellipsis when something was cut. */
export function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const head = space > max * 0.5 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s,;:.\-–—]+$/u, "")}…`;
}
