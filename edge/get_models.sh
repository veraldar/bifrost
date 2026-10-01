#!/usr/bin/env bash
# Download the edge voice models (once). ~200MB total. MIT/Apache-licensed.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models && cd models

asr="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
tts="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models"

fetch() { # url
  local f; f="$(basename "$1")"
  [ -e "${f%.tar.bz2}" ] && { echo "have $f"; return; }
  echo "get $f"
  curl -fL --retry 3 -o "$f" "$1"
  case "$f" in
    *.tar.bz2) tar xjf "$f" && rm "$f" ;;
  esac
}

fetch "$asr/sherpa-onnx-whisper-tiny.en.tar.bz2"
fetch "$asr/silero_vad.onnx"
fetch "$tts/vits-piper-fr_FR-siwis-low.tar.bz2"
fetch "$tts/vits-piper-en_US-lessac-low.tar.bz2"

echo "models ready:"
ls -1
