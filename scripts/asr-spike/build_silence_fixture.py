"""Two-speaker TTS conversation with exactly known speech and silence spans, for the silence-trim and cut gates.

Each utterance is synthesised by espeak-ng, so its non-silent span is known by construction. Every track gets room noise and
a quiet copy of the other speaker (bleed). Writes track_A.wav, track_B.wav and truth.json (speech spans per track, in seconds).

usage: build_silence_fixture.py <out dir> <lang en|pl> <source conversation.json> [minutes]
"""
import json
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

out = Path(sys.argv[1])
lang = sys.argv[2]
conversation = json.loads(Path(sys.argv[3]).read_text(encoding="utf8"))["utterances"]
minutes = float(sys.argv[4]) if len(sys.argv) > 4 else 5
out.mkdir(parents=True, exist_ok=True)
SR = 16000
random.seed(11)
rng = np.random.default_rng(11)
voices = {"A": f"{'en-us' if lang == 'en' else 'pl'}+m3", "B": f"{'en-us' if lang == 'en' else 'pl'}+f2"}
GAPS = [0.15, 0.3, 0.45, 0.6, 0.9, 1.2, 2.0, 3.5]

timeline = {"A": [], "B": []}
spans = {"A": [], "B": []}
cursor = 0.4
with tempfile.TemporaryDirectory() as tmp:
    for i, utt in enumerate(conversation):
        speaker = "A" if i % 2 == 0 else "B"
        wav = Path(tmp) / "u.wav"
        subprocess.run(["espeak-ng", "-v", voices[speaker], "-s", "165", "-w", str(wav), utt["text"]], check=True)
        x, sr = sf.read(wav, dtype="float32")
        if sr != SR:
            import torchaudio
            import torch
            x = torchaudio.functional.resample(torch.from_numpy(x), sr, SR).numpy()
        nz = np.flatnonzero(np.abs(x) > 0.01 * np.abs(x).max())
        x = x[nz[0] : nz[-1] + 1] * (0.35 / np.abs(x).max())
        timeline[speaker].append((cursor, x))
        spans[speaker].append({"s": cursor, "e": cursor + len(x) / SR})
        cursor += len(x) / SR + random.choice(GAPS)
        if cursor > minutes * 60:
            break
total = cursor + 2.0
tracks = {}
for speaker in "AB":
    y = np.zeros(int(total * SR), dtype=np.float32)
    for at, x in timeline[speaker]:
        i = int(at * SR)
        y[i : i + len(x)] += x
    tracks[speaker] = y
bleed = 10 ** (-24 / 20)
delay = int(0.012 * SR)
for speaker, other in (("A", "B"), ("B", "A")):
    mixed = tracks[speaker] + bleed * np.concatenate([np.zeros(delay, dtype=np.float32), tracks[other][:-delay]])
    mixed += (rng.standard_normal(len(mixed)) * 10 ** (-58 / 20)).astype(np.float32)
    sf.write(out / f"track_{speaker}.wav", np.clip(mixed, -1, 1), SR, subtype="PCM_16")
(out / "truth.json").write_text(json.dumps({"duration": total, "speech": spans}, indent=1))
print(f"{lang}: {total:.0f} s, {len(spans['A'])}+{len(spans['B'])} utterances")
