#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root in the ModelScope Notebook terminal." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This native deployment currently requires a Debian/Ubuntu Notebook with apt-get." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
# Public PyPI can stall from the Notebook network. Allow an explicit override,
# while using the Tsinghua HTTPS mirror as the native deployment default.
export PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
export PIP_DEFAULT_TIMEOUT="${PIP_DEFAULT_TIMEOUT:-120}"
export PIP_RETRIES="${PIP_RETRIES:-3}"
# ModelScope images can point at an Aliyun Ubuntu mirror that returns 403 from
# this environment. Use the Tsinghua Ubuntu HTTPS mirror for supported Jammy APT packages.
for apt_source in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [[ -f "$apt_source" ]] || continue
  sed -Ei 's|https?://mirrors\.aliyun\.com/ubuntu|https://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' "$apt_source"
done
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl ffmpeg libsndfile1 postgresql postgresql-client postgresql-contrib python3-venv

if ! command -v corepack >/dev/null 2>&1; then
  echo "Node.js Corepack is required but unavailable." >&2
  exit 1
fi

corepack enable
corepack prepare pnpm@9.15.5 --activate

cd "$ROOT"
pnpm install --frozen-lockfile
pnpm --filter @smartrecruit-pro/contracts build
pnpm --filter @smartrecruit-pro/object-storage build
pnpm --filter @smartrecruit-pro/resume-intelligence build
pnpm --filter @smartrecruit-pro/enterprise-ai build
pnpm --filter @smartrecruit-pro/api build
pnpm --filter @smartrecruit-pro/worker build
# Build through the root workspace. The nested web/pnpm-workspace.yaml is only
# a legacy pnpm setting file and does not declare a standalone workspace.
VITE_ROUTER_MODE=hash pnpm --filter smartrecruit-pro-web run build

install_python_service() {
  local directory="$1"
  local requirements="$2"
  python -m venv "$directory/.venv"
  "$directory/.venv/bin/python" -m pip install --upgrade pip
  "$directory/.venv/bin/python" -m pip install -r "$requirements"
}

install_python_service "$ROOT/ocr-service" "$ROOT/ocr-service/requirements.txt"
install_python_service "$ROOT/funasr-service" "$ROOT/funasr-service/requirements.txt"
install_python_service "$ROOT/faster-whisper-service" "$ROOT/faster-whisper-service/requirements.txt"

echo "Native dependencies and production builds are ready."
echo "Next: copy deploy/modelscope/runtime.native.env.example to runtime.native.env, set its secrets and PUBLIC_ORIGIN, then run deploy/modelscope/native-start.sh."
