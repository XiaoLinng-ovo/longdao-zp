-- 招聘渠道接入预留结构。
-- 密钥不进入数据库，仍由服务端 .env / 外部密钥系统保存；本表只保存非敏感配置与同步状态。

CREATE TABLE IF NOT EXISTS channel_connections (
  provider text PRIMARY KEY CHECK (provider IN ('boss', 'liepin', '51job', 'official_site')),
  enabled boolean NOT NULL DEFAULT false,
  base_url text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'not_configured'
    CHECK (status IN ('not_configured', 'configured', 'not_implemented', 'error')),
  last_error text,
  last_tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_channel_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('boss', 'liepin', '51job', 'official_site')),
  external_job_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'published', 'paused', 'closed', 'failed')),
  request_payload_hash text,
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, provider)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_channel_external
  ON job_channel_publications(provider, external_job_id)
  WHERE external_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_job_channel_status
  ON job_channel_publications(provider, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS channel_resume_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('boss', 'liepin', '51job', 'official_site')),
  external_event_id text NOT NULL,
  external_resume_id text NOT NULL,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'completed', 'failed', 'ignored')),
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, external_event_id),
  UNIQUE (provider, external_resume_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_resume_events_status
  ON channel_resume_events(status, received_at);

CREATE TABLE IF NOT EXISTS channel_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('boss', 'liepin', '51job', 'official_site')),
  operation text NOT NULL CHECK (operation IN ('test', 'publish', 'pause', 'close', 'pull_resumes', 'sync_status', 'webhook')),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'not_configured', 'not_implemented')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_channel_sync_runs_provider
  ON channel_sync_runs(provider, started_at DESC);

DROP TRIGGER IF EXISTS channel_connections_set_updated_at ON channel_connections;
CREATE TRIGGER channel_connections_set_updated_at
  BEFORE UPDATE ON channel_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS job_channel_publications_set_updated_at ON job_channel_publications;
CREATE TRIGGER job_channel_publications_set_updated_at
  BEFORE UPDATE ON job_channel_publications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
