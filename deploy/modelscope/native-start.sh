#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_ENV="$ROOT/deploy/modelscope/runtime.native.env"
DATA_ROOT="${SMARTRECRUIT_DATA_ROOT:-/mnt/workspace/smartrecruit-data}"
RUN_ROOT="$DATA_ROOT/run"
LOG_ROOT="$DATA_ROOT/logs"
PG_DATA="$DATA_ROOT/postgres"
PG_SOCKET="$RUN_ROOT/postgres-socket"
PG_PORT="${PGPORT:-5432}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root in the ModelScope Notebook terminal." >&2
  exit 1
fi
if [[ ! -f "$RUNTIME_ENV" ]]; then
  echo "Missing $RUNTIME_ENV. Copy runtime.native.env.example and set its values first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$RUNTIME_ENV"
set +a

for key in PUBLIC_ORIGIN POSTGRES_PASSWORD AI_CONFIG_ENCRYPTION_KEY; do
  if [[ -z "${!key:-}" || "${!key}" == *replace-with* ]]; then
    echo "Set $key in $RUNTIME_ENV before starting." >&2
    exit 1
  fi
done
if ! [[ "$PUBLIC_ORIGIN" =~ ^https?://[^/]+$ ]]; then
  echo "PUBLIC_ORIGIN must contain protocol and host only, without a path or trailing slash." >&2
  exit 1
fi
for command in pg_config runuser curl node; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing $command. Run native-install.sh first." >&2; exit 1; }
done

mkdir -p "$DATA_ROOT/object-storage" "$DATA_ROOT/paddle-models" "$DATA_ROOT/funasr-models" \
  "$DATA_ROOT/faster-whisper-models" "$RUN_ROOT" "$LOG_ROOT"
install -d -m 700 -o postgres -g postgres "$PG_DATA" "$PG_SOCKET"
touch "$LOG_ROOT/postgres.log"
chown postgres:postgres "$LOG_ROOT/postgres.log"

PG_BIN="$(pg_config --bindir)"
INITDB="$PG_BIN/initdb"
PG_CTL="$PG_BIN/pg_ctl"
PSQL="$PG_BIN/psql"

if [[ ! -f "$PG_DATA/PG_VERSION" ]]; then
  runuser -u postgres -- "$INITDB" -D "$PG_DATA" --encoding=UTF8 --locale=C --auth-host=scram-sha-256 --auth-local=peer
fi

if ! runuser -u postgres -- "$PG_CTL" -D "$PG_DATA" status >/dev/null 2>&1; then
  runuser -u postgres -- "$PG_CTL" -D "$PG_DATA" -l "$LOG_ROOT/postgres.log" \
    -o "-p $PG_PORT -h 127.0.0.1 -k $PG_SOCKET" start -w -t 60
fi

password_b64="$(printf %s "$POSTGRES_PASSWORD" | base64 -w 0)"
runuser -u postgres -- "$PSQL" -h "$PG_SOCKET" -p "$PG_PORT" -d postgres -v ON_ERROR_STOP=1 \
  -v app_role="$POSTGRES_USER" -v app_db="$POSTGRES_DB" -v app_password_b64="$password_b64" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'app_role')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_role')
\gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'app_role', convert_from(decode(:'app_password_b64', 'base64'), 'UTF8'))
\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'app_db', :'app_role')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'app_db')
\gexec
SQL

export NODE_ENV=production
export HOST=127.0.0.1
export PORT=3100
export PGHOST=127.0.0.1
export PGPORT="$PG_PORT"
export PGUSER="$POSTGRES_USER"
export PGPASSWORD="$POSTGRES_PASSWORD"
export PGDATABASE="$POSTGRES_DB"
export ALLOWED_ORIGINS="$PUBLIC_ORIGIN"
export REQUIRE_CSRF=true
export ENV_FILE_PATH="$RUNTIME_ENV"
export RECRUITING_QUARANTINE_ROOT="$DATA_ROOT/object-storage"
export RESUME_VIRUS_SCAN_ENABLED=false
export WORKER_DB_POLL=true
export WORKER_HEALTH_HOST=127.0.0.1
export WORKER_HEALTH_PORT=4001
export OCR_SERVICE_URL=http://127.0.0.1:8090
export FUNASR_BASE_URL=http://127.0.0.1:10095/transcribe
export FUNASR_TIMEOUT_MS=120000
export FUNASR_DEVICE=cpu
export FUNASR_OFFLINE_DEVICE=cpu
export FUNASR_STREAMING_DEVICE=cpu
export FUNASR_PRELOAD_MODELS=1
export FUNASR_BATCH_SIZE_S="${FUNASR_BATCH_SIZE_S:-20}"
export FASTER_WHISPER_BASE_URL=http://127.0.0.1:10096/transcribe
export FASTER_WHISPER_TIMEOUT_MS=120000
export FASTER_WHISPER_DEVICE=cpu
export FASTER_WHISPER_COMPUTE_TYPE=int8
export PADDLE_PDX_CACHE_HOME="$DATA_ROOT/paddle-models"
export MODELSCOPE_CACHE="$DATA_ROOT/funasr-models/modelscope"
export OMP_NUM_THREADS="${OCR_CPU_THREADS:-2}"
export MKL_NUM_THREADS="${OCR_CPU_THREADS:-2}"

cd "$ROOT"
node scripts/migrate-postgres.mjs

is_running() {
  local name="$1"
  local pid_file="$RUN_ROOT/$name.pid"
  [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1
}

start_process() {
  local name="$1"
  local workdir="$2"
  shift 2
  if is_running "$name"; then
    echo "$name already runs with PID $(cat "$RUN_ROOT/$name.pid")"
    return
  fi
  rm -f "$RUN_ROOT/$name.pid"
  (
    cd "$workdir"
    nohup "$@" >"$LOG_ROOT/$name.log" 2>&1 &
    echo $! >"$RUN_ROOT/$name.pid"
  )
  echo "Started $name with PID $(cat "$RUN_ROOT/$name.pid")"
}

start_process ocr "$ROOT/ocr-service" "$ROOT/ocr-service/.venv/bin/python" -m uvicorn main:app --host 127.0.0.1 --port 8090
start_process funasr "$ROOT/funasr-service" env HF_HOME="$DATA_ROOT/funasr-models/huggingface" "$ROOT/funasr-service/.venv/bin/python" -m uvicorn server:app --host 127.0.0.1 --port 10095
start_process faster-whisper "$ROOT/faster-whisper-service" env HF_HOME="$DATA_ROOT/faster-whisper-models/huggingface" XDG_CACHE_HOME="$DATA_ROOT/faster-whisper-models/cache" "$ROOT/faster-whisper-service/.venv/bin/python" -m uvicorn server:app --host 127.0.0.1 --port 10096
start_process api "$ROOT" node apps/api/dist/src/index.js
start_process worker "$ROOT" node apps/worker/dist/src/index.js
start_process web "$ROOT" env WEB_HOST=0.0.0.0 WEB_PORT=7860 WEB_API_TARGET=http://127.0.0.1:3100 WEB_FUNASR_TARGET=http://127.0.0.1:10095 node scripts/serve-web-production.mjs

wait_http() {
  local name="$1"
  local url="$2"
  local timeout="$3"
  local elapsed=0
  until curl -fsS "$url" >/dev/null 2>&1; do
    if (( elapsed >= timeout )); then
      echo "$name did not become ready within ${timeout}s. Check $LOG_ROOT/$name.log" >&2
      return 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "$name is ready"
}

wait_http api http://127.0.0.1:3100/api/v1/health 60
wait_http worker http://127.0.0.1:4001/ready 60
wait_http web http://127.0.0.1:7860/ 30

echo "The public application entrypoint is ModelScope's proxy for port 7860."
echo "Run deploy/modelscope/native-status.sh for health, process, memory, and log locations."
