#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_ENV="$ROOT/deploy/modelscope/runtime.native.env"
PUBLIC_ORIGIN="${1:-${PUBLIC_ORIGIN:-}}"

if [[ "$#" -gt 1 ]]; then
  echo "Usage: bash deploy/modelscope/native-init.sh https://modelscope-public-host" >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root in the ModelScope Notebook terminal." >&2
  exit 1
fi
if [[ -f "$RUNTIME_ENV" ]]; then
  echo "$RUNTIME_ENV already exists. It was left unchanged." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required to generate deployment secrets." >&2
  exit 1
fi
if ! [[ "$PUBLIC_ORIGIN" =~ ^https?://[^/]+$ ]]; then
  echo "Pass the public protocol and host only, without /proxy/7860/ or a trailing slash." >&2
  exit 1
fi

postgres_password="$(openssl rand -base64 36 | tr -d '\r\n')"
encryption_key="$(openssl rand -base64 32 | tr -d '\r\n')"

umask 077
cat >"$RUNTIME_ENV" <<EOF
# Generated on this Notebook. Keep this file with the database backup; do not commit it.
PUBLIC_ORIGIN=$PUBLIC_ORIGIN

POSTGRES_DB=smartrecruit
POSTGRES_USER=smartrecruit
POSTGRES_PASSWORD=$postgres_password
AI_CONFIG_ENCRYPTION_KEY=$encryption_key

# CPU profile for one 8 vCPU / 32 GB ModelScope Notebook.
WORKER_CONCURRENCY=3
FUNASR_CPU_THREADS=4
FUNASR_BATCH_SIZE_S=20
OCR_CPU_THREADS=2
FASTER_WHISPER_CPU_THREADS=2
FASTER_WHISPER_MODEL=base
FASTER_WHISPER_LANGUAGE=zh
EOF
chmod 600 "$RUNTIME_ENV"

echo "Created $RUNTIME_ENV with freshly generated secrets."
echo "Next: bash deploy/modelscope/native-install.sh"
