"""WER of the product's transcript job (scripts/bench-transcribe.ts output) against the fixture conversations.

usage: evaluate_product.py <asr work dir> <bench result.json>
"""
import json
import re
import sys
from pathlib import Path

import jiwer
from num2words import num2words
from whisper_normalizer.english import EnglishTextNormalizer

W = Path(sys.argv[1])
result = json.loads(Path(sys.argv[2]).read_text(encoding="utf8"))
lang = result["lang"]
english = EnglishTextNormalizer()


def norm(text):
    return re.sub(r"\s+", " ", re.sub(r"[\W_]+", " ", text.lower())).strip()


def wer_text(text):
    text = norm(re.sub(r"\d+", lambda m: num2words(int(m.group()), lang=lang), norm(text)))
    return norm(english(text)) if lang == "en" else text


conversation = json.loads((W / f"fix-{lang}" / "conversation.json").read_text(encoding="utf8"))["utterances"]
refs = {"Anna": "A", "Bartek": "B"}
for session in ("clean", "bleed"):
    data = result[session]
    errors = words = 0
    for name, speaker in refs.items():
        ref = wer_text(" ".join(u["text"] for u in conversation if u["speaker"] == speaker))
        hyp = wer_text(data["perSpeaker"].get(name, ""))
        out = jiwer.process_words(ref, hyp)
        errors += out.substitutions + out.deletions + out.insertions
        words += len(ref.split())
    print(f"{lang} {session}: WER {100 * errors / words:.1f}% over {words} reference words; wall {data['wallSec']:.0f}s; peak child RSS {data['peakChildMb']} MB; words per track {data['wordsPerSource']}; bleedDropped {data['bleedDropped']}; duplicateRate {100 * (data['duplicateRate'] or 0):.2f}%")
