-- 0009: 对齐 applications 状态机（默认值与状态 CHECK）
-- 背景：0001 建表时 applications.status 默认 'new'，与设计文档的申请状态机（pending_analysis 起）不一致，
--      且 applications 是全库唯一缺少状态 CHECK 的聚合表。本迁移回填历史值并补齐约束。
-- 幂等：重复执行安全（DROP CONSTRAINT IF EXISTS + 条件回填）。

UPDATE applications SET status = 'pending_analysis'
 WHERE status NOT IN ('pending_analysis','analysis_queued','human_review','interviewing','offer_approval','offer_sent',
                      'offer_accepted','onboarding_archived','rejected','offer_declined','offer_cancelled','offer_expired');

ALTER TABLE applications ALTER COLUMN status SET DEFAULT 'pending_analysis';

ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check CHECK (status IN (
  'pending_analysis','analysis_queued','human_review','interviewing','offer_approval','offer_sent',
  'offer_accepted','onboarding_archived','rejected','offer_declined','offer_cancelled','offer_expired'
));

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
