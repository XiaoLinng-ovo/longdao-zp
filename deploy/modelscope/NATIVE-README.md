# ModelScope Notebook Native Deployment

Use this variant only when the ModelScope CPU Notebook does not provide a Docker daemon. It keeps source code and runtime data separate, while leaving `docker-compose.modelscope.yml` intact for a future cloud-server migration.

## Persistent layout

All mutable state is below `/mnt/workspace/smartrecruit-data`:

- `postgres`: PostgreSQL cluster
- `object-storage`: resumes, interview audio, and generated files
- `paddle-models`, `funasr-models`, `faster-whisper-models`: downloaded OCR and ASR models
- `logs`, `run`: service logs and PID files

Back up the PostgreSQL database with `pg_dump`, back up `object-storage`, and retain `runtime.native.env` in a secret store. The AI encryption key in that file is needed to decrypt stored integration credentials after migration.

## First start

Run this in the Notebook terminal after uploading or cloning the repository. First obtain the public proxy address for port `7860` from the ModelScope interface. For an address such as `https://gateway.example/proxy/7860/`, retain only `https://gateway.example`.

```bash
cd /mnt/workspace/<repository>
bash deploy/modelscope/native-init.sh https://gateway.example
```

The initialization command creates a private `runtime.native.env`, including fresh database and encryption secrets. It never overwrites an existing runtime file.

Then install once and start:

```bash
bash deploy/modelscope/native-install.sh
bash deploy/modelscope/native-start.sh
```

The first model downloads can take several minutes. `native-start.sh` waits for the application services; OCR and ASR model loading may continue until their first real request.

## Health and resource checks

```bash
bash deploy/modelscope/native-status.sh
```

Only port `7860` is public. PostgreSQL, OCR, FunASR, faster-whisper, API, and worker health endpoints bind only to `127.0.0.1`.

## ClamAV and migration

ClamAV remains defined but disabled by default in the Docker deployment. The native Notebook script deliberately does not install or start it; uploads run with virus scanning disabled. Before a production migration, enable ClamAV only after configuring and testing its worker connection.

For cloud-server deployment, reuse the Docker Compose deployment, move the PostgreSQL dump and `object-storage` backup, restore the encryption key, and replace the Notebook proxy origin with the final HTTPS domain. The application service boundaries and persistent data layout remain the same.
