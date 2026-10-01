#!/data/data/com.termux/files/usr/bin/bash
# bifrost-lite on a spare Android phone via Termux (no root, no store app).
# 1. Install Termux from F-Droid.  2. pkg install git.  3. bash edge/termux-setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== termux deps =="
pkg update -y
pkg install -y python python-pip git libandroid-support binutils

echo "== python env =="
pip install --upgrade pip
pip install -r edge/requirements.txt

echo "== models (~200MB, one-time) =="
bash edge/get_models.sh

echo "== start =="
echo "SPEACHES_URL=http://127.0.0.1:8000/v1  <- put this in agent/.env for LOCAL=1"
cd edge && exec python -m uvicorn voice_server:app --host 127.0.0.1 --port 8000
