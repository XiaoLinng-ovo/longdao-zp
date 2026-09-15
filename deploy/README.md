# Local infrastructure

Start the Phase 1 infrastructure services from the repository root:

```bash
docker compose -f deploy/docker-compose.yml up -d
```

The compose file intentionally starts PostgreSQL, Redis, MinIO, and ClamAV only. API and Worker images are added after their TypeScript entrypoints and configuration contracts are stable.

Development defaults are not production secrets. Set environment variables or use a private `.env` before exposing any service outside localhost.
