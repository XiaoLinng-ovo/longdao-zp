# ModelScope Notebook Deployment

This Notebook variant keeps all mutable state under `/mnt/workspace/smartrecruit-data`, publishes only the Web entrypoint on port `7860`, and uses same-origin reverse proxying for the API and real-time ASR WebSocket. PostgreSQL, Redis, OCR, FunASR, faster-whisper, and ClamAV are not public.

## First start

1. Start the ModelScope CPU Notebook, open its Terminal, and clone or upload this repository below `/mnt/workspace`.
2. Verify Docker before spending time on a build:

   ```bash
   docker info
   docker compose version
   ```

   The standard Notebook environment may not expose a Docker daemon. Stop here if either command fails; do not install a privileged Docker daemon inside the Notebook.

3. Copy the template and create durable secrets:

   ```bash
   cd /mnt/workspace/<repository>
   cp deploy/modelscope/runtime.env.example deploy/modelscope/runtime.env
   openssl rand -base64 32
   openssl rand -base64 32
   ```

   Use the first output for `POSTGRES_PASSWORD` and the second for `AI_CONFIG_ENCRYPTION_KEY`. Do not rotate the AI key after data has been encrypted.

4. Set `PUBLIC_ORIGIN` to the public gateway origin shown by ModelScope for port `7860`. For an address such as `https://gateway.example/proxy/7860/`, use only `https://gateway.example`.

5. Start the complete stack:

   ```bash
   bash deploy/modelscope/start.sh
   ```

   The first start downloads OCR and speech-recognition models and can take several minutes. Open the ModelScope proxy URL for port `7860` after `web`, `postgres`, `ocr`, `funasr`, and `api` are healthy.

## Validation

Run these commands in the Notebook terminal after startup:

```bash
curl -fsS http://127.0.0.1:7860/health
curl -fsS http://127.0.0.1:7860/api/v1/ready
docker compose --env-file deploy/modelscope/runtime.env -f deploy/docker-compose.modelscope.yml ps
docker stats --no-stream
```

Validate the public proxy with login, a create/update action, a resume upload and analysis, one OCR document, a live-interview microphone session, a stored recording replay, and a Notebook restart. Run the project's heavier test scripts only after the normal flow works because they create test business records.

## Data and Migration

- Back up `/mnt/workspace/smartrecruit-data/postgres` with a logical `pg_dump` from the PostgreSQL container. Back up `object-storage` with it because it contains resumes, interview audio, and generated media.
- Preserve `deploy/modelscope/runtime.env` in a secure secret store together with the database backup. The encryption key is required to read stored integration and AI credentials.
- Migration to a cloud server reuses `deploy/docker-compose.modelscope.yml`: replace `SMARTRECRUIT_DATA_ROOT` with the server data path, move the database and object-storage backup, set a fixed `PUBLIC_ORIGIN`, and put TLS/reverse proxy in front of port `7860`.
- ClamAV remains defined but is disabled by default. Do not enable the `virus-scan` profile until `CLAMAV_HOST=clamav` is also configured for the worker and the scan flow is tested.
