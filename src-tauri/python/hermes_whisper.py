"""Hermes subtitle runner for faster-whisper (written to hermes-data/python/hermes on start).

Prints "NN.N%" progress lines and "[file] <path>" for every subtitle file it writes,
which is what Hermes' queue parsers read. GPU (CUDA, float16) first, CPU (int8) fallback.
"""
import argparse
import os
import sys

# CTranslate2 needs cuBLAS/cuDNN: reuse the ones shipped inside the PyTorch wheel.
try:
    import torch

    os.add_dll_directory(os.path.join(os.path.dirname(torch.__file__), "lib"))
except Exception:
    pass

from faster_whisper import WhisperModel

p = argparse.ArgumentParser()
p.add_argument("input")
p.add_argument("--model", default="large-v3-turbo")
p.add_argument("--language", default="")
p.add_argument("--task", default="transcribe", choices=["transcribe", "translate"])
p.add_argument("--formats", default="srt")
p.add_argument("--output-dir", required=True)
p.add_argument("--models-dir", required=True)
a = p.parse_args()


def run(device, compute):
    model = WhisperModel(a.model, device=device, compute_type=compute, download_root=a.models_dir)
    segments, info = model.transcribe(a.input, language=a.language or None, task=a.task, vad_filter=True)
    total = info.duration or 1.0
    out = []
    for s in segments:  # lazy: decoding happens here, so GPU errors surface here too
        out.append(s)
        print(f"{min(100.0, s.end / total * 100):.1f}%", flush=True)
    return out, info


try:
    segs, info = run("cuda", "float16")
    device = "GPU"
except Exception as e:  # no NVIDIA GPU / driver issue
    print(f"GPU unavailable ({e}); using CPU", flush=True)
    segs, info = run("cpu", "int8")
    device = "CPU"


def stamp(t, sep):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}{sep}{ms:03}"


os.makedirs(a.output_dir, exist_ok=True)
base = os.path.join(a.output_dir, os.path.splitext(os.path.basename(a.input))[0])
suffix = f".{info.language}" if a.task == "transcribe" else ".en"
for fmt in a.formats.split(","):
    path = f"{base}{suffix}.{fmt}"
    with open(path, "w", encoding="utf-8") as f:
        if fmt == "vtt":
            f.write("WEBVTT\n\n")
        for i, s in enumerate(segs, 1):
            text = s.text.strip()
            if fmt == "srt":
                f.write(f"{i}\n{stamp(s.start, ',')} --> {stamp(s.end, ',')}\n{text}\n\n")
            elif fmt == "vtt":
                f.write(f"{stamp(s.start, '.')} --> {stamp(s.end, '.')}\n{text}\n\n")
            else:
                f.write(text + "\n")
    print(f"[file] {path}", flush=True)
print(f"Detected language: {info.language} ({device})", flush=True)
sys.exit(0)
