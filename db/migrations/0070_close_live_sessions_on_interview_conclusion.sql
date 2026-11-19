-- 面试已结束（completed/cancelled）时，不允许残留 active/paused 的实时会话。
-- 迁移前遗留的会话会阻止摘要生成，也让旧页面可以继续往历史面试里写入。
-- 该语句与后端 concludeInterview 的关闭逻辑保持一致（completed 触发后处理队列，
-- 已取消的面试标记为 failed，避免为取消的面试消耗 AI 摘要额度）。

-- 修复历史遗留数据：旧版本允许在已结束的面试上再次开启会话，这些残留的
-- active/paused 会话既会阻止面试摘要生成，也会让旧页面继续往历史记录里写入。
UPDATE interview_live_sessions s
   SET status = CASE WHEN i.status = 'completed' THEN 'completed' ELSE 'failed' END,
       ended_at = COALESCE(s.ended_at, now()),
       updated_at = now()
  FROM interviews i
 WHERE i.id = s.interview_id
   AND i.status IN ('completed', 'cancelled')
   AND s.status IN ('active', 'paused');
