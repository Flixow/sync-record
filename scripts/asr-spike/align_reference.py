"""Reference word times for the timing gate: forced alignment (torchaudio MMS_FA) of the known transcript of each clip.
This is a machine reference, not hand labelling; it is independent of every engine under test.

usage: align_reference.py <fixture dir>
"""
import json
import re
import sys
from pathlib import Path

import soundfile as sf
import torch
import torchaudio
from unidecode import unidecode

fixture = Path(sys.argv[1])
clips = json.loads((fixture / "clips.json").read_text(encoding="utf8"))
bundle = torchaudio.pipelines.MMS_FA
model = bundle.get_model(with_star=False)
tokenizer = bundle.get_tokenizer()
aligner = bundle.get_aligner()


def norm(text):
    return re.sub(r"\s+", " ", re.sub(r"[\W_]+", " ", text.lower())).strip()


for clip in clips:
    audio, sr = sf.read(fixture / clip["file"], dtype="float32")
    waveform = torch.from_numpy(audio).unsqueeze(0)
    words = []  # (original word, romanised word)
    for part in clip["parts"]:
        for word in norm(part["text"]).split():
            rom = re.sub(r"[^a-z']", "", unidecode(word).lower())
            words.append((word, rom))
    aligned = [(w, r) for w, r in words if r]
    with torch.inference_mode():
        emission, _ = model(waveform)
    spans = aligner(emission[0], tokenizer([r for _, r in aligned]))
    ratio = waveform.size(1) / emission.size(1) / sr
    reference = []
    for (word, _), span in zip(aligned, spans):
        reference.append({"w": word, "s": span[0].start * ratio, "e": span[-1].end * ratio})
    clip["reference"] = reference
    clip["skipped"] = [w for w, r in words if not r]
    print(clip["file"], len(reference), "words aligned,", len(clip["skipped"]), "skipped")
(fixture / "clips.json").write_text(json.dumps(clips, ensure_ascii=False, indent=1), encoding="utf8")
