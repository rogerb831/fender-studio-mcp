#!/usr/bin/env python3
"""Windows capture: record what's playing out of a WASAPI render device to a
32-bit float WAV, via loopback. The Windows counterpart to tap/s1tap.swift.

    capture_win.py --seconds <s> --out <file.wav> [--device <name substring>] [--rate <hz>]

Prints one JSON line matching s1tap:
    {"file","sampleRate","channels","frames","seconds","peakDb"}
Errors go to stderr as {"error": ...} with a non-zero exit.

Unlike the macOS process tap, this captures the *device* mix (everything the
chosen render endpoint plays), not one process. Two important limits:
  * An app using an **exclusive ASIO** driver (common for audio interfaces, e.g.
    a PreSonus "Studio USB") bypasses the Windows audio engine, so loopback
    records silence. Set Studio One's audio device to a Windows Audio (WASAPI)
    driver, or analyze a `live_bounce` instead.
  * Over Remote Desktop, the only endpoint is usually "Remote Audio".
A near-silent capture (very low peakDb) is the symptom of the first case.
"""
import argparse
import json
import sys

import numpy as np
import soundcard as sc
import soundfile as sf


def fail(msg):
    sys.stderr.write(json.dumps({"error": str(msg)}) + "\n")
    sys.exit(1)


def pick_loopback(device):
    mics = sc.all_microphones(include_loopback=True)
    loop = [m for m in mics if getattr(m, "isloopback", False)]
    if device:
        d = device.lower()
        hit = [m for m in loop if d in m.name.lower()] or [m for m in mics if d in m.name.lower()]
        if not hit:
            names = ", ".join(m.name for m in mics) or "none"
            fail(f'no loopback device matching "{device}" (have: {names})')
        return hit[0]
    # Default: the loopback of the default speaker.
    try:
        return sc.get_microphone(sc.default_speaker().name, include_loopback=True)
    except Exception:
        if loop:
            return loop[0]
        fail("no WASAPI loopback device available")


def list_endpoints():
    # Enumerate the WASAPI loopback endpoints (render devices we can record from).
    mics = sc.all_microphones(include_loopback=True)
    loop = [m for m in mics if getattr(m, "isloopback", False)]
    try:
        default_name = sc.default_speaker().name
    except Exception:
        default_name = None
    print(json.dumps({
        "loopbackEndpoints": [m.name for m in loop],
        "defaultSpeaker": default_name,
    }))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="print the loopback endpoints as JSON and exit")
    ap.add_argument("--seconds", type=float)
    ap.add_argument("--out")
    ap.add_argument("--device", default=None, help="substring of the render device to loop back")
    ap.add_argument("--rate", type=int, default=48000)
    a = ap.parse_args()
    if a.list:
        list_endpoints()
        return
    if a.seconds is None or a.out is None:
        fail("--seconds and --out are required (or pass --list)")
    if not (a.seconds > 0):
        fail("--seconds must be > 0")

    mic = pick_loopback(a.device)
    rate = a.rate
    frames = int(round(a.seconds * rate))
    try:
        # channels=2: a stereo mixdown of the endpoint, matching the analyzer.
        with mic.recorder(samplerate=rate, channels=2, blocksize=2048) as rec:
            data = rec.record(numframes=frames)
    except Exception as e:  # noqa: BLE001 - report any capture failure as JSON
        fail(f"capture failed on {mic.name!r}: {e}")

    data = np.asarray(data, dtype=np.float32)
    if data.ndim == 1:
        data = data[:, None]
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    peak_db = round(20.0 * np.log10(peak), 2) if peak > 0 else -144.0
    sf.write(a.out, data, rate, subtype="FLOAT")
    print(json.dumps({
        "file": a.out,
        "sampleRate": rate,
        "channels": int(data.shape[1]),
        "frames": int(data.shape[0]),
        "seconds": round(data.shape[0] / rate, 4),
        "peakDb": peak_db,
        "device": mic.name,
    }))


if __name__ == "__main__":
    main()
