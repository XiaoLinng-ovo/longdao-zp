-- Idempotent development data for the PostgreSQL-backed local application.
WITH department AS (
  INSERT INTO departments (code, name) VALUES ('dept-tech', '技术中心')
  ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, is_active = true
  RETURNING id
), request AS (
  INSERT INTO recruitment_requests (request_no, title, department_id, headcount, budget_min, budget_max, reason, status)
  SELECT 'REQ-24018', '高级后端工程师', id, 2, 35000, 50000, '业务平台扩容，需要补充后端研发力量。', 'approved' FROM department
  ON CONFLICT (request_no) DO UPDATE SET title = EXCLUDED.title, department_id = EXCLUDED.department_id, status = EXCLUDED.status
  RETURNING id, department_id
), job AS (
  INSERT INTO jobs (job_no, recruitment_request_id, department_id, title, status, headcount)
  SELECT 'JOB-108', id, department_id, '高级后端工程师', 'published', 2 FROM request
  ON CONFLICT (job_no) DO UPDATE SET title = EXCLUDED.title, department_id = EXCLUDED.department_id, status = EXCLUDED.status
  RETURNING id, department_id
), candidate_seed(candidate_no, name, email, phone, source) AS (
  VALUES
    ('CAN-8821', '王思远', 'wang.siyuan@example.test', '13800008821', '内部推荐'),
    ('CAN-8814', '赵雨欣', 'zhao.yuxin@example.test', '13800008814', '招聘网站'),
    ('CAN-8802', '李哲', 'li.zhe@example.test', '13800008802', '官网投递')
), seeded_candidates AS (
  INSERT INTO candidates (candidate_no, name, email, phone, source, consent_status)
  SELECT candidate_no, name, email, phone, source, 'granted' FROM candidate_seed
  ON CONFLICT (candidate_no) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone, source = EXCLUDED.source
  RETURNING id, candidate_no, source
), application_seed(application_no, candidate_no, status) AS (
  VALUES
    ('APP-8821', 'CAN-8821', 'human_review'),
    ('APP-8814', 'CAN-8814', 'interviewing'),
    ('APP-8802', 'CAN-8802', 'analysis_queued')
), seeded_applications AS (
  INSERT INTO applications (application_no, candidate_id, job_id, status, source)
  SELECT s.application_no, c.id, j.id, s.status, c.source
  FROM application_seed s JOIN seeded_candidates c ON c.candidate_no = s.candidate_no CROSS JOIN job j
  ON CONFLICT (application_no) DO UPDATE SET status = EXCLUDED.status, job_id = EXCLUDED.job_id, source = EXCLUDED.source
  RETURNING id, application_no, candidate_id
), seeded_resumes AS (
  INSERT INTO resumes (candidate_id, application_id, storage_key, original_filename, mime_type, size_bytes, scan_status, parser_version, content_hash)
  SELECT a.candidate_id, a.id, 'demo/' || lower(a.application_no) || '.txt', a.application_no || '-resume.txt', 'text/plain', 128, 'clean', 'demo-seed-v1', encode(digest(a.application_no, 'sha256'), 'hex')
  FROM seeded_applications a
  ON CONFLICT (storage_key) DO UPDATE SET application_id = EXCLUDED.application_id, scan_status = 'clean'
  RETURNING id, application_id, storage_key
), seeded_tasks AS (
  INSERT INTO analysis_tasks (resume_id, application_id, status, attempts, idempotency_key, completed_at)
  SELECT r.id, r.application_id, 'completed', 1, 'demo-analysis:' || r.storage_key, now() FROM seeded_resumes r
  ON CONFLICT (idempotency_key) DO UPDATE SET status = 'completed', completed_at = now(), last_error = NULL
  RETURNING id, resume_id, application_id
)
INSERT INTO analysis_results (analysis_task_id, resume_id, application_id, result, model_provider, model_name, prompt_version, analyzer_version, input_hash, human_review_status)
SELECT t.id, t.resume_id, t.application_id,
       jsonb_build_object('assessment', jsonb_build_object(
         'score', CASE a.application_no WHEN 'APP-8821' THEN 92 WHEN 'APP-8814' THEN 86 ELSE 74 END,
         'recommendation', CASE a.application_no WHEN 'APP-8821' THEN '建议进入人工复核' WHEN 'APP-8814' THEN '建议继续面试' ELSE '等待人工复核' END,
         'strengths', jsonb_build_array('相关经验与岗位方向匹配'),
         'risks', jsonb_build_array('需由招聘人员核实经历细节')
       )),
       'demo', 'rule-based-demo', 'demo-v1', 'demo-seed-v1', encode(digest(a.application_no || ':analysis', 'sha256'), 'hex'), 'pending'
FROM seeded_tasks t JOIN applications a ON a.id = t.application_id
ON CONFLICT (analysis_task_id) DO UPDATE SET result = EXCLUDED.result, analyzer_version = EXCLUDED.analyzer_version;

INSERT INTO job_spec_versions (job_id, version, content)
SELECT j.id, 1, '{"title":"高级后端工程师","summary":"负责核心服务设计与研发","skills":["Java","PostgreSQL","微服务"]}'::jsonb
FROM jobs j WHERE j.job_no = 'JOB-108'
ON CONFLICT (job_id, version) DO NOTHING;

INSERT INTO job_description_versions (job_id, version, title, content, status)
SELECT j.id, 1, '高级后端工程师', '负责核心业务服务的设计、开发与持续优化。', 'confirmed'
FROM jobs j WHERE j.job_no = 'JOB-108'
ON CONFLICT (job_id, version) DO NOTHING;

-- The main CTE is intentionally safe on a partially seeded database. This pass
-- also backfills results for tasks that already existed before the script ran.
INSERT INTO analysis_results (analysis_task_id, resume_id, application_id, result, model_provider, model_name, prompt_version, analyzer_version, input_hash, human_review_status)
SELECT t.id, t.resume_id, t.application_id,
       jsonb_build_object('assessment', jsonb_build_object(
         'score', CASE a.application_no WHEN 'APP-8821' THEN 92 WHEN 'APP-8814' THEN 86 ELSE 74 END,
         'recommendation', CASE a.application_no WHEN 'APP-8821' THEN '建议进入人工复核' WHEN 'APP-8814' THEN '建议继续面试' ELSE '等待人工复核' END
       )),
       'demo', 'rule-based-demo', 'demo-v1', 'demo-seed-v1', encode(digest(a.application_no || ':analysis', 'sha256'), 'hex'), 'pending'
FROM analysis_tasks t JOIN applications a ON a.id = t.application_id
WHERE t.idempotency_key LIKE 'demo-analysis:%'
ON CONFLICT (analysis_task_id) DO UPDATE SET result = EXCLUDED.result, analyzer_version = EXCLUDED.analyzer_version;
