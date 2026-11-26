"""Builds the speech fixtures of the S1 spike from FLEURS (read speech, CC BY 4.0).

Per language: a 10 minute two-speaker conversation (one track per speaker, as SyncRecord records them), the same with
speaker bleed, a silent track, and 30 s clips with forced-alignment word times. Everything is deterministic (seeded).

usage: build_fixtures.py <fleurs dir> <out dir> <lang>
"""
import json
import random
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 16000
fleurs, out, lang = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
out.mkdir(parents=True, exist_ok=True)
rng = random.Random(7)

rows = []
for line in (fleurs / "dev.tsv").read_text(encoding="utf8").splitlines():
    cols = line.split("\t")
    if len(cols) < 7:
        continue
    rows.append({"id": cols[0], "file": cols[1], "raw": cols[2], "norm": cols[3], "samples": int(cols[5]), "gender": cols[6]})

# one utterance per sentence id, seconds between 4 and 15
seen, pool = set(), {"FEMALE": [], "MALE": []}
rng.shuffle(rows)
for row in rows:
    seconds = row["samples"] / SR
    if row["id"] in seen or not 4 <= seconds <= 15 or row["gender"] not in pool:
        continue
    seen.add(row["id"])
    pool[row["gender"]].append(row)


def load(row):
    audio, rate = sf.read(fleurs / "dev" / row["file"], dtype="float32")
    assert rate == SR
    audio = audio / max(1e-6, np.abs(audio).max()) * 0.5  # same level for every utterance
    return audio


def build(target_sec, tag, pools):
    """Alternating turns of speaker A (female) and B (male), gaps of 0.3 to 1.4 s, now and then a slight overlap."""
    cursor, turn, utterances = 1.0, 0, []
    taken = {"A": 0, "B": 0}
    while cursor < target_sec:
        speaker = "A" if turn % 2 == 0 else "B"
        source = pools["FEMALE" if speaker == "A" else "MALE"]
        row = source[taken[speaker]]
        taken[speaker] += 1
        audio = load(row)
        # speech starts a little after the file start in FLEURS; keep the file as is: its own silence is part of the realism
        utterances.append({"speaker": speaker, "start": cursor, "audio": audio, "text": row["norm"], "id": row["id"], "raw": row["raw"]})
        cursor += len(audio) / SR + (rng.uniform(0.3, 1.4) if rng.random() > 0.15 else -0.25)
        turn += 1
    total = cursor + 1.0
    tracks = {s: np.zeros(int(total * SR), dtype="float32") for s in "AB"}
    for u in utterances:
        begin = int(u["start"] * SR)
        tracks[u["speaker"]][begin : begin + len(u["audio"])] += u["audio"]
    rng2 = np.random.default_rng(3)
    for s in "AB":  # room noise on every track, -55 dBFS
        tracks[s] += rng2.normal(0, 0.0018, len(tracks[s])).astype("float32")
    meta = [{k: u[k] for k in ("speaker", "start", "text", "id", "raw")} | {"end": u["start"] + len(u["audio"]) / SR} for u in utterances]
    return tracks, meta


tracks, meta = build(600, "conv", pool)
for s in "AB":
    sf.write(out / f"track_{s}.wav", tracks[s], SR, subtype="PCM_16")
(out / "conversation.json").write_text(json.dumps({"lang": lang, "sampleRate": SR, "utterances": meta}, ensure_ascii=False, indent=1), encoding="utf8")

# the same with speaker bleed: the other speaker arrives 22 dB lower and 12 ms late (headphone-less setup)
delay = int(0.012 * SR)
gain = 10 ** (-22 / 20)
for s, o in (("A", "B"), ("B", "A")):
    bleed = tracks[s].copy()
    bleed[delay:] += gain * tracks[o][:-delay]
    sf.write(out / f"bleed_{s}.wav", bleed, SR, subtype="PCM_16")

# a silent track: room noise only
silent = np.random.default_rng(5).normal(0, 0.0018, 60 * SR).astype("float32")
sf.write(out / "silent.wav", silent, SR, subtype="PCM_16")

# clips: 30 s of speaker A turns of the conversation, for the word-timing gate
clips = []
for index in range(5):
    cursor, parts, audio_parts = 0.0, [], []
    while cursor < 28:
        row = pool["FEMALE" if index % 2 == 0 else "MALE"].pop()
        pool_audio = load(row)
        if cursor + len(pool_audio) / SR > 33:
            break
        pad = np.zeros(int(rng.uniform(0.4, 0.9) * SR), dtype="float32")
        audio_parts += [pad, pool_audio]
        cursor += len(pad) / SR
        parts.append({"start": cursor, "text": row["norm"], "id": row["id"]})
        cursor += len(pool_audio) / SR
    clip = np.concatenate(audio_parts)
    sf.write(out / f"clip_{index}.wav", clip, SR, subtype="PCM_16")
    clips.append({"file": f"clip_{index}.wav", "seconds": len(clip) / SR, "parts": parts})
(out / "clips.json").write_text(json.dumps(clips, ensure_ascii=False, indent=1), encoding="utf8")
print(lang, "conversation", round(len(tracks["A"]) / SR), "s,", len(meta), "utterances,", len(clips), "clips")
