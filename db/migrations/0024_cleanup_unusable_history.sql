-- 清理由旧版本自由文本面试官写入、且无法进入反馈流程的无效面试。
-- 只删除同时满足以下条件的记录，避免误删历史业务：
-- 1. 至少有一名 interviewer 参与者；
-- 2. 所有 interviewer 的 userId 都不是 UUID；
-- 3. 该面试没有任何 interview_feedback。
DELETE FROM interviews i
WHERE NOT EXISTS (
  SELECT 1 FROM interview_feedback f WHERE f.interview_id = i.id
)
AND EXISTS (
  SELECT 1
  FROM jsonb_array_elements(i.participants) participant
  WHERE participant->>'role' = 'interviewer'
)
AND NOT EXISTS (
  SELECT 1
  FROM jsonb_array_elements(i.participants) participant
  WHERE participant->>'role' = 'interviewer'
    AND participant->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
);

-- ENOENT 表示简历对象在数据库记录后被外部删除，重试不会成功。
-- 保留模型超时、权限、解析格式等其他可恢复失败任务。
DELETE FROM analysis_tasks
WHERE status = 'failed'
  AND last_error ILIKE 'ENOENT:%';
