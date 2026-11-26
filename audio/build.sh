#!/bin/sh
# Build the capture helper and the analyzer's Python environment.
#   macOS:          Swift Core Audio process tap (bin/s1tap) + venv
#   Windows / Linux: no Swift — capture_win.py records via WASAPI loopback; just the venv
# Run from anywhere: `npm run build:audio`.
set -e
cd "$(dirname "$0")"

case "$(uname -s)" in
  Darwin)
    mkdir -p bin
    swiftc -O -o bin/s1tap tap/s1tap.swift -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker tap/Info.plist
    echo "Built audio/bin/s1tap" ;;
  *)
    echo "Skipping s1tap (macOS only); this platform captures with capture_win.py (WASAPI loopback)" ;;
esac

# Python environment for analyze.py (and soundcard for capture_win.py off macOS;
# the requirements file gates soundcard with a platform marker).
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "python3 not found on PATH"; exit 1; }
[ -x .venv/bin/python ] || [ -x .venv/Scripts/python.exe ] || "$PY" -m venv .venv
if [ -x .venv/Scripts/python.exe ]; then VPY=.venv/Scripts/python.exe; else VPY=.venv/bin/python; fi
"$VPY" -m pip install -q -r requirements.txt
echo "Built audio/.venv"
