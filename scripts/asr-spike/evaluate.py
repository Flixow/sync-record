"""Scores the runs of run_all.sh: WER on the conversations, word-timing accuracy on the clips, the silent track, speed and memory.

usage: evaluate.py <asr work dir>
"""
import difflib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import jiwer

W = Path(sys.argv[1])
# The forced aligner that produced clips.json is itself late by about 42 ms at word starts: measured against TTS audio whose word
# starts are known by construction (median +42 ms, p10 +1, p90 +78). The corrected column subtracts that bias from the reference.
REF_BIAS = float(sys.argv[2]) / 1000 if len(sys.argv) > 2 else 0.0
runs = W / "runs"


def norm(text):
    return re.sub(r"\s+", " ", re.sub(r"[\W_]+", " ", text.lower())).strip()


try:
    from num2words import num2words
    from whisper_normalizer.english import EnglishTextNormalizer

    _english = EnglishTextNormalizer()
except ImportError:  # the raw normalisation still works without the optional packages
    num2words = None
    _english = None


def wer_text(lang, text):
    """Normalisation for WER: lower case, no punctuation, digits spelled out in the language (FLEURS writes some numbers as digits,
    engines write others as words), plus the Whisper English normaliser for British/American spelling."""
    text = norm(text)
    if num2words is not None:
        text = re.sub(r"\d+", lambda m: num2words(int(m.group()), lang=lang), text)
        text = norm(text)
    if lang == "en" and _english is not None:
        text = norm(_english(text))
    return text


def rss_mb(tag):
    try:
        text = tag.with_suffix(".time").read_text()
        return int(re.search(r"Maximum resident set size \(kbytes\): (\d+)", text).group(1)) / 1024
    except Exception:
        return float("nan")


def timing(reference, hyp, window=0.1):
    """Fraction of reference words whose start the engine got right within `window` seconds (matched by sequence alignment)."""
    ref_words = [norm(w["w"]) for w in reference]
    hyp_words = [norm(w["w"]) for w in hyp]
    matcher = difflib.SequenceMatcher(a=ref_words, b=hyp_words, autojunk=False)
    hits, matched, errors = 0, 0, []
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            error = abs(hyp[block.b + k]["s"] - (reference[block.a + k]["s"] - REF_BIAS))
            errors.append(error)
            matched += 1
            if error <= window:
                hits += 1
    return hits, matched, len(reference), errors


rows = defaultdict(dict)
for lang in ("pl", "en"):
    conversation = json.loads((W / f"fix-{lang}" / "conversation.json").read_text(encoding="utf8"))["utterances"]
    clips = json.loads((W / f"fix-{lang}" / "clips.json").read_text(encoding="utf8"))
    refs = {s: " ".join(norm(u["text"]) for u in conversation if u["speaker"] == s) for s in "AB"}
    for tag in sorted({p.name.split(f"-{lang}-")[0] for p in runs.glob(f"*-{lang}-track_A.json")}):
        row = rows[(tag, lang)]
        errors = words = 0
        speech = wall = audio = 0.0
        peak = 0.0
        done = True
        for s in "AB":
            f = runs / f"{tag}-{lang}-track_{s}.json"
            if not f.exists():
                done = False
                continue
            run = json.loads(f.read_text(encoding="utf8"))
            hyp = wer_text(lang, " ".join(w["w"] for w in run["words"]))
            ref = wer_text(lang, refs[s])
            out = jiwer.process_words(ref, hyp)
            errors += out.substitutions + out.deletions + out.insertions
            words += len(ref.split())
            speech += run["speech_sec"]; wall += run["asr_wall_sec"]; audio += run["audio_sec"]
            peak = max(peak, rss_mb(f))
        if words:
            row["wer"] = 100 * errors / words
            row["rtf_speech"] = wall / speech
            row["rtf_audio"] = wall / audio
            row["rss_mb"] = peak
        # timing
        hits = matched = total = 0
        allerr = []
        for i, clip in enumerate(clips):
            f = runs / f"{tag}-{lang}-clip_{i}.json"
            if not f.exists():
                continue
            run = json.loads(f.read_text(encoding="utf8"))
            h, m, t, e = timing(clip["reference"], run["words"])
            hits += h; matched += m; total += t; allerr += e
        if total:
            row["timing_hit"] = 100 * hits / total
            row["timing_matched"] = 100 * matched / total
            allerr.sort()
            row["timing_median_ms"] = 1000 * allerr[len(allerr) // 2] if allerr else float("nan")
        f = runs / f"{tag}-{lang}-silent.json"
        if f.exists():
            row["silent_words"] = len(json.loads(f.read_text(encoding="utf8"))["words"])

print(f"{'config':18} {'lang':4} {'WER%':>6} {'RTFspeech':>9} {'RTFaudio':>8} {'RSS MB':>7} {'t<=100ms%':>9} {'matched%':>8} {'med ms':>7} {'silent'}")
for (tag, lang), row in sorted(rows.items()):
    print(f"{tag:18} {lang:4} {row.get('wer', float('nan')):6.1f} {row.get('rtf_speech', float('nan')):9.3f} {row.get('rtf_audio', float('nan')):8.3f} {row.get('rss_mb', float('nan')):7.0f} {row.get('timing_hit', float('nan')):9.1f} {row.get('timing_matched', float('nan')):8.1f} {row.get('timing_median_ms', float('nan')):7.0f} {row.get('silent_words', '-')}")
