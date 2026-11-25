# Platform AI Configuration

Platform-default model settings live only in public.platform_ai_settings (migration 0110).
OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL and OPENAI_TIMEOUT_MS in process environment
or .env files are not imported, read as platform defaults, or written by the administration API.
Existing environment-only installations must configure the model again through the system administrator UI.
An unconfigured database disables platform AI explicitly; there is no environment fallback.

## Deployment

1. Back up PostgreSQL and the existing encryption key using the production maintenance procedure.
2. Apply approved migration 0110 and deploy matching API and Worker builds together.
3. Provide the same original AI_CONFIG_ENCRYPTION_KEY to API and Worker (canonical base64, 32 bytes).
   This is a server encryption secret, not a model setting. Never regenerate it on deployment or restore.
4. Configure AI_ALLOWED_BASE_URL_ORIGINS with exact trusted HTTPS origins in production.
5. As the system administrator, save the endpoint, API key, model and timeout in the AI settings page.
6. Test model listing and an actual generation for an enterprise authorized to use platform models.

Secrets use AES-256-GCM with platform-specific authenticated context, separate from enterprise keys.
Reads return a constant mask. Omitted API keys preserve the ciphertext; explicit empty keys clear it.
Saves and platform audit records commit atomically. Metadata contains field names and key actions only.
API and Worker read the current database record on each operation; no process restart is required after saving.
Enterprise self-service configurations and explicit platform authorization remain unchanged.

## Verification

Run node scripts/test-platform-ai-postgres-isolated.mjs D:/software/pgsql/bin against a disposable cluster.
The script never uses business database credentials or imports real model settings.
