# Local infrastructure

Start the Phase 1 infrastructure services from the repository root:

```bash
docker compose -f deploy/docker-compose.yml up -d
```

The compose file starts PostgreSQL, Redis, MinIO, ClamAV, and a local PP-StructureV3 OCR service. The first OCR startup downloads Paddle models into the persistent `paddle_models` volume and can take several minutes. Configure API and Worker with `OCR_SERVICE_URL=http://127.0.0.1:8090` when running them on the host, or `http://ocr:8090` when they run inside the Compose network.

Development defaults are not production secrets. Set environment variables or use a private `.env` before exposing any service outside localhost.
