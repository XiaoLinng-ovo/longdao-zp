#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT="${SMARTRECRUIT_DATA_ROOT:-/mnt/workspace/smartrecruit-data}"
RUN_ROOT="$DATA_ROOT/run"

for name in api worker web ocr funasr faster-whisper; do
  pid_file="$RUN_ROOT/$name.pid"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1; then
    echo "$name: running (PID $(cat "$pid_file"))"
  else
    echo "$name: stopped"
  fi
done

echo
curl -fsS http://127.0.0.1:3100/api/v1/health || true
echo
curl -fsS http://127.0.0.1:4001/ready || true
echo
curl -fsS http://127.0.0.1:7860/health || true
echo
ps -eo pid,ppid,%cpu,%mem,rss,cmd --sort=-rss | head -n 20
echo
free -h
echo
du -sh "$DATA_ROOT"/* 2>/dev/null || true
