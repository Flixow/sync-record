"""Speech engine harness of the S1 spike: the same energy VAD and chunking for every engine, then WER, word timing and speed.

usage: harness.py <engine> <model> <lang> <fixture dir> <track wav> [--threads N] [--out file.json]
engines: fw (faster-whisper), wcpp (whisper.cpp), sherpa (sherpa-onnx transducer, model = model directory)
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 16000
TOOLS = Path(__file__).resolve().parents[2]


# ---- VAD and chunking (the production implementation in TypeScript follows the same rules) ----
def energy_vad(audio, sr=SR):
    frame = int(0.02 * sr)
    n = len(audio) // frame
    rms = np.sqrt(np.mean(audio[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    floor = np.percentile(db, 10)
    threshold = max(floor + 12.0, -50.0)
    speech = db > threshold
    segs, start = [], None
    for i, flag in enumerate(speech):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            segs.append([start, i])
            start = None
    if start is not None:
        segs.append([start, n])
    merged = []
    for s, e in segs:  # bridge gaps under 500 ms
        if merged and (s - merged[-1][1]) * 0.02 < 0.5:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    out = []
    for s, e in merged:
        if (e - s) * 0.02 < 0.25:
            continue
        out.append((max(0.0, s * 0.02 - 0.15), min(len(audio) / sr, e * 0.02 + 0.15)))
    return out, db


def split_long(segs, db, limit=25.0):
    out = []
    for s, e in segs:
        while e - s > limit:
            lo, hi = int((s + limit * 0.6) / 0.02), int((s + limit) / 0.02)
            cut = lo + int(np.argmin(db[lo:hi]))
            out.append((s, cut * 0.02))
            s = cut * 0.02
        out.append((s, e))
    return out


def chunks_of(audio, segs, limit=28.0, pad=0.6):
    """Packs speech segments into chunks of at most `limit` seconds, separated by `pad` s of silence."""
    chunks, current, length = [], [], 0.0
    for s, e in segs:
        d = e - s
        if current and length + pad + d > limit:
            chunks.append(current)
            current, length = [], 0.0
        current.append((s, e, length + (pad if current else 0.0)))
        length += (pad if len(current) > 1 else 0.0) + d
    if current:
        chunks.append(current)
    packed = []
    for chunk in chunks:
        total = chunk[-1][2] + (chunk[-1][1] - chunk[-1][0])
        wave = np.zeros(int((total + 0.3) * SR), dtype="float32")
        for s, e, at in chunk:
            piece = audio[int(s * SR) : int(e * SR)]
            wave[int(at * SR) : int(at * SR) + len(piece)] = piece
        packed.append({"audio": wave, "segs": chunk})
    return packed


def to_track_time(chunk, t):
    best = chunk["segs"][0]
    for seg in chunk["segs"]:
        if t >= seg[2] - 0.3:
            best = seg
    s, e, at = best
    return min(e, max(s, s + (t - at)))


# ---- engines ----
def engine_fw(model_name, lang, threads):
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=threads)

    def run(chunks):
        results = []
        for chunk in chunks:
            segments, _ = model.transcribe(chunk["audio"], language=lang, word_timestamps=True, vad_filter=False, beam_size=1, condition_on_previous_text=False, temperature=0.0)
            results.append([{"w": w.word.strip(), "s": w.start, "e": w.end} for seg in segments for w in seg.words if w.word.strip()])
        return results

    return run


def engine_wcpp(model_path, lang, threads):
    binary = Path(os.environ.get("WHISPER_CLI", "whisper-cli"))

    def run(chunks):
        results = []
        if not chunks:
            return results
        with tempfile.TemporaryDirectory() as tmp:
            for i, chunk in enumerate(chunks):
                wav = Path(tmp) / f"c{i}.wav"
                sf.write(wav, chunk["audio"], SR, subtype="PCM_16")
            files = [str(Path(tmp) / f"c{i}.wav") for i in range(len(chunks))]
            args = [str(binary), "-m", model_path, "-l", lang, "-t", str(threads), "-ojf", "-np", "-bs", "1", "-bo", "1", "-mc", "0", "-ml", "1", "-sow", *files]
            subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for i in range(len(chunks)):
                data = json.loads((Path(tmp) / f"c{i}.wav.json").read_text(encoding="utf8"))
                words = []
                for seg in data["transcription"]:
                    text = seg["text"].strip()
                    if not text or text.startswith("[_") or text.startswith("["):
                        continue
                    words.append({"w": text, "s": seg["offsets"]["from"] / 1000.0, "e": seg["offsets"]["to"] / 1000.0})
                results.append(words)
        return results

    return run


def engine_sherpa(model_dir, lang, threads):
    import sherpa_onnx

    d = Path(model_dir)
    recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(d / "encoder.int8.onnx"), decoder=str(d / "decoder.int8.onnx"), joiner=str(d / "joiner.int8.onnx"),
        tokens=str(d / "tokens.txt"), num_threads=threads, sample_rate=SR, feature_dim=128, decoding_method="greedy_search", model_type="nemo_transducer",
    )

    def run(chunks):
        results = []
        for chunk in chunks:
            stream = recognizer.create_stream()
            stream.accept_waveform(SR, chunk["audio"])
            recognizer.decode_stream(stream)
            r = stream.result
            words, cur = [], None
            for token, ts in zip(r.tokens, r.timestamps):
                if token.startswith(("▁", " ")) or cur is None:
                    if cur and cur["w"]:
                        words.append(cur)
                    cur = {"w": token.lstrip("▁ "), "s": ts, "e": ts + 0.08}
                else:
                    cur["w"] += token
                    cur["e"] = ts + 0.08
            if cur and cur["w"]:
                words.append(cur)
            results.append([w for w in words if w["w"]])
        return results

    return run


def norm(text):
    return re.sub(r"\s+", " ", re.sub(r"[\W_]+", " ", text.lower())).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("engine")
    parser.add_argument("model")
    parser.add_argument("lang")
    parser.add_argument("fixture")
    parser.add_argument("track")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--out")
    parser.add_argument("--limit-sec", type=float, default=0)
    args = parser.parse_args()

    audio, sr = sf.read(Path(args.fixture) / args.track, dtype="float32")
    if args.limit_sec:
        audio = audio[: int(args.limit_sec * sr)]
    t_load = time.time()
    run = {"fw": engine_fw, "wcpp": engine_wcpp, "sherpa": engine_sherpa}[args.engine](args.model, args.lang, args.threads)
    load_sec = time.time() - t_load
    segs, db = energy_vad(audio)
    segs = split_long(segs, db)
    chunks = chunks_of(audio, segs)
    speech_sec = sum(e - s for s, e in segs)
    t0 = time.time()
    per_chunk = run(chunks)
    wall = time.time() - t0
    words = []
    for chunk, ws in zip(chunks, per_chunk):
        for w in ws:
            words.append({"w": w["w"], "s": to_track_time(chunk, w["s"]), "e": to_track_time(chunk, w["e"])})
    words.sort(key=lambda w: w["s"])
    result = {"engine": args.engine, "model": Path(args.model).name, "lang": args.lang, "track": args.track, "audio_sec": len(audio) / sr, "speech_sec": speech_sec, "chunks": len(chunks), "load_sec": load_sec, "asr_wall_sec": wall, "rtf_audio": wall / (len(audio) / sr), "rtf_speech": wall / max(1e-6, speech_sec), "words": words}
    if args.out:
        Path(args.out).write_text(json.dumps(result, ensure_ascii=False), encoding="utf8")
    print(json.dumps({k: v for k, v in result.items() if k != "words"}))


if __name__ == "__main__":
    main()
