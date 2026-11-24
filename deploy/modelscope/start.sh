#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_ENV="$ROOT/deploy/modelscope/runtime.env"
DATA_ROOT="${SMARTRECRUIT_DATA_ROOT:-/mnt/workspace/smartrecruit-data}"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is unavailable. This Notebook cannot run the Compose deployment until Docker access is enabled." >&2
  exit 1
fi

if [[ ! -f "$RUNTIME_ENV" ]]; then
  echo "Missing $RUNTIME_ENV. Copy deploy/modelscope/runtime.env.example and set the three required values." >&2
  exit 1
fi

required=(PUBLIC_ORIGIN POSTGRES_PASSWORD AI_CONFIG_ENCRYPTION_KEY)
for key in "${required[@]}"; do
  if ! grep -Eq "^${key}=.+" "$RUNTIME_ENV"; then
    echo "Missing $key in $RUNTIME_ENV" >&2
    exit 1
  fi
done

mkdir -p "$DATA_ROOT"/{postgres,redis,object-storage,paddle-models,funasr-models,faster-whisper-models,clamav}
export SMARTRECRUIT_DATA_ROOT="$DATA_ROOT"

cd "$ROOT"
docker compose --env-file "$RUNTIME_ENV" -f deploy/docker-compose.modelscope.yml up -d --build
docker compose --env-file "$RUNTIME_ENV" -f deploy/docker-compose.modelscope.yml ps
