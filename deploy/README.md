# Local infrastructure

For a Linux production server, use [PRODUCTION.md](PRODUCTION.md) and the root `compose.production.yml`. This page describes the legacy local setup only.

Start the complete application from the repository root:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

The compose file starts PostgreSQL, Redis, MinIO, a local PP-StructureV3 OCR service, API, Worker, and Web. The first OCR startup downloads Paddle models into the persistent `paddle_models` volume and can take several minutes. Open `http://127.0.0.1:5174` after all services become healthy. The default resume scan gate is disabled.

Development defaults are not production secrets. Set environment variables or use a private `.env` before exposing any service outside localhost.
