-- 幂等记录不再依赖硬编码的“历史迁移工作空间”默认值。
-- 原因：
--   1) 默认值会把所有企业的幂等记录都归到同一个历史工作空间，租户归属错误；
--   2) 每家公司独立库/独立 schema 时该默认企业并不存在，写入会直接违反外键，
--      表现为写接口返回 500（例如创建 Offer、候选人幂等重放）。
-- 应用层现在显式传入当前企业的 organization_id。
ALTER TABLE idempotency_records ALTER COLUMN organization_id DROP DEFAULT;
ALTER TABLE idempotency_records ALTER COLUMN organization_id DROP NOT NULL;
