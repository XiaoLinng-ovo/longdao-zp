import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuthCookie, buildCsrfCookie, readCookie } from '../src/auth/security.js';

let server: ReturnType<typeof import('../src/server.js').createHttpServer>;
let baseUrl: string;
let testDirectory: string;
let authHeader: Record<string, string> = {};
const previousQuarantineRoot = process.env.RECRUITING_QUARANTINE_ROOT;
const previousNodeEnv = process.env.NODE_ENV;
const previousDingTalkToken = process.env.DINGTALK_INTEGRATION_TOKEN;
const previousPlatformBaseUrl = process.env.PLATFORM_BASE_URL;

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const requestInstance = request(url, { method: 'GET', headers: { ...authHeader, ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: JSON.parse(text)
        });
      });
    });
    requestInstance.on('error', reject);
    requestInstance.end();
  });
}

function requestJson(method: string, path: string, payload?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const requestInstance = request(url, {
      method,
      headers: { ...authHeader, ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    requestInstance.on('error', reject)
    if (payload !== undefined) requestInstance.write(JSON.stringify(payload))
    requestInstance.end()
  })
}

async function loginAs(email: string, password: string): Promise<void> {
  const response = await requestJson('POST', '/api/v1/auth/login', { email, password });
  assert.equal(response.status, 200);
  const setCookie = response.headers['set-cookie'];
  const cookie = Array.isArray(setCookie) ? setCookie.join(';') : setCookie;
  const match = cookie?.split(';').find((item) => item.trim().startsWith('smartrecruit_session='));
  assert.ok(match);
  const token = decodeURIComponent(match.trim().slice('smartrecruit_session='.length));
  authHeader = { authorization: `Bearer ${token}` };
}

async function login(): Promise<void> {
  await loginAs('recruiter@smartrecruit.local', 'recruiter123');
}

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DINGTALK_INTEGRATION_TOKEN = 'test-dingtalk-token';
  process.env.PLATFORM_BASE_URL = 'https://recruit.example.test';
  testDirectory = await mkdtemp(join(tmpdir(), 'recruiting-api-test-'));
  process.env.RECRUITING_QUARANTINE_ROOT = join(testDirectory, 'resumes');
  const { createHttpServer } = await import('../src/server.js');
  server = createHttpServer(loadConfig({ NODE_ENV: 'test', PORT: '0' }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (previousQuarantineRoot === undefined) delete process.env.RECRUITING_QUARANTINE_ROOT; else process.env.RECRUITING_QUARANTINE_ROOT = previousQuarantineRoot;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  if (previousDingTalkToken === undefined) delete process.env.DINGTALK_INTEGRATION_TOKEN; else process.env.DINGTALK_INTEGRATION_TOKEN = previousDingTalkToken;
  if (previousPlatformBaseUrl === undefined) delete process.env.PLATFORM_BASE_URL; else process.env.PLATFORM_BASE_URL = previousPlatformBaseUrl;
  await rm(testDirectory, { recursive: true, force: true });
});

describe('Phase 1 API', { concurrency: false }, () => {
  it('accepts authenticated DingTalk job events and replays them idempotently', async () => {
    const event = { eventId: 'evt-api-001', externalJobId: 'ding-job-api-001', title: '高级后端工程师', departmentCode: 'dept-tech', headcount: 2, creatorUserId: 'ding-user-001' };

    const unauthorized = await requestJson('POST', '/api/v1/integrations/dingtalk/jobs', event, { authorization: 'Bearer wrong-token' });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error.code, 'DINGTALK_AUTH_REQUIRED');

    const malformed = await requestJson('POST', '/api/v1/integrations/dingtalk/jobs', { ...event, headcount: 0 }, { authorization: 'Bearer test-dingtalk-token' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'DINGTALK_JOB_INVALID');

    const created = await requestJson('POST', '/api/v1/integrations/dingtalk/jobs', event, { authorization: 'Bearer test-dingtalk-token' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'draft');
    assert.match(created.body.data.completeUrl, /^https:\/\/recruit\.example\.test\/jobs\//);

    const replayed = await requestJson('POST', '/api/v1/integrations/dingtalk/jobs', event, { authorization: 'Bearer test-dingtalk-token' });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.data.status, 'replayed');
    assert.equal(replayed.body.data.jobId, created.body.data.jobId);
  });
  it('limits hiring managers to recruiting data in their department', async () => {
    await loginAs('manager@smartrecruit.local', 'manager123');

    const candidates = await get('/api/v1/candidates');
    assert.equal(candidates.status, 200);
    assert.deepEqual(candidates.body.data.map((item: { id: string }) => item.id), ['candidate-8821']);

    const applications = await get('/api/v1/applications');
    assert.equal(applications.status, 200);
    assert.deepEqual(applications.body.data.map((item: { id: string }) => item.id), ['application-8821']);

    const foreignCandidate = await get('/api/v1/candidates/candidate-8814');
    assert.equal(foreignCandidate.status, 403);
    assert.equal(foreignCandidate.body.error.code, 'FORBIDDEN');

    const reports = await get('/api/v1/reports');
    assert.equal(reports.status, 200);
    assert.equal(reports.body.data.funnel[0].count, 1);
    assert.deepEqual(reports.body.data.jobFilling.map((item: { jobId: string }) => item.jobId), ['job-108']);

    await login();
  });

  it('paginates core recruiting lists while preserving unpaged array responses', async () => {
    await login();
    const paths = [
      '/api/v1/recruitment-requests',
      '/api/v1/jobs',
      '/api/v1/candidates',
      '/api/v1/applications',
      '/api/v1/offers',
    ];

    for (const path of paths) {
      const unpaged = await get(path);
      assert.equal(unpaged.status, 200);
      assert.ok(Array.isArray(unpaged.body.data));

      const paged = await get(`${path}?page=2&pageSize=1`);
      assert.equal(paged.status, 200);
      assert.deepEqual(paged.body.data, {
        items: unpaged.body.data.slice(1, 2),
        total: unpaged.body.data.length,
        page: 2,
        pageSize: 1,
      });
    }
  });

  it('authenticates with the session cookie, exposes /me, and invalidates it on logout', async () => {
    const previousAuth = authHeader;
    authHeader = {};
    const loginResponse = await requestJson('POST', '/api/v1/auth/login', {
      email: 'recruiter@smartrecruit.local',
      password: 'recruiter123',
    });
    assert.equal(loginResponse.status, 200);
    const setCookies = loginResponse.headers['set-cookie'];
    const cookies = Array.isArray(setCookies) ? setCookies : [setCookies];
    const sessionCookie = cookies.find((value) => value?.startsWith('smartrecruit_session='))?.split(';')[0];
    const csrfCookie = cookies.find((value) => value?.startsWith('smartrecruit_csrf='))?.split(';')[0];
    assert.ok(sessionCookie, 'login must issue a session cookie');
    assert.ok(csrfCookie, 'login must issue a CSRF cookie');

    const me = await get('/api/v1/me', { cookie: `${sessionCookie}; ${csrfCookie}` });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.email, 'recruiter@smartrecruit.local');
    assert.equal(me.body.data.method, 'session');

    const logout = await requestJson('POST', '/api/v1/auth/logout', undefined, { cookie: `${sessionCookie}; ${csrfCookie}` });
    assert.equal(logout.status, 200);
    assert.equal(logout.body.data.ok, true);

    const afterLogout = await get('/api/v1/me', { cookie: `${sessionCookie}; ${csrfCookie}` });
    assert.equal(afterLogout.status, 401);
    assert.equal(afterLogout.body.error.code, 'AUTHENTICATION_REQUIRED');
    authHeader = previousAuth;
  });

  it('uses __Host- cookies in production and parses their prefixed names', () => {
    const authCookie = buildAuthCookie('session-token', { production: true });
    const csrfCookie = buildCsrfCookie('csrf-token', { production: true });
    assert.match(authCookie, /^__Host-smartrecruit_session=session-token;/);
    assert.match(csrfCookie, /^__Host-smartrecruit_csrf=csrf-token;/);
    assert.equal(readCookie(`${authCookie}; ${csrfCookie}`, 'smartrecruit_session', { production: true }), 'session-token');
    assert.equal(readCookie(`${authCookie}; ${csrfCookie}`, 'smartrecruit_csrf', { production: true }), 'csrf-token');
  });

  it('enforces CSRF origin and token when REQUIRE_CSRF is enabled', async () => {
    const previousRequire = process.env.REQUIRE_CSRF;
    const previousOrigins = process.env.ALLOWED_ORIGINS;
    process.env.REQUIRE_CSRF = 'true';
    process.env.ALLOWED_ORIGINS = 'http://allowed.example.test';
    try {
      await login();
      const payload = { title: 'CSRF 测试岗位', departmentId: '数据平台', headcount: 1, employmentType: 'full_time', workMode: 'hybrid', justification: 'csrf' };

      const missingOrigin = await requestJson('POST', '/api/v1/recruitment-requests', payload);
      assert.equal(missingOrigin.status, 403);
      assert.equal(missingOrigin.body.error.code, 'CSRF_ORIGIN_MISMATCH');

      const csrf = await get('/api/v1/auth/csrf');
      assert.equal(csrf.status, 200);
      const token = String(csrf.body.data.token);
      const setCookie = csrf.headers['set-cookie'];
      const csrfCookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find((value) => value?.startsWith('smartrecruit_csrf='))?.split(';')[0];
      assert.ok(csrfCookie);

      const missingToken = await requestJson('POST', '/api/v1/recruitment-requests', payload, { origin: 'http://allowed.example.test', cookie: csrfCookie! });
      assert.equal(missingToken.status, 403);
      assert.equal(missingToken.body.error.code, 'CSRF_TOKEN_INVALID');

      const valid = await requestJson('POST', '/api/v1/recruitment-requests', payload, { origin: 'http://allowed.example.test', cookie: csrfCookie!, 'x-csrf-token': token });
      assert.equal(valid.status, 201);
    } finally {
      authHeader = {};
      if (previousRequire === undefined) delete process.env.REQUIRE_CSRF; else process.env.REQUIRE_CSRF = previousRequire;
      if (previousOrigins === undefined) delete process.env.ALLOWED_ORIGINS; else process.env.ALLOWED_ORIGINS = previousOrigins;
    }
  });
  it('returns a request id and health data', async () => {
    const response = await get('/api/v1/health', { 'x-request-id': 'test-request-001' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-request-id'], 'test-request-001');
    assert.deepEqual(response.body.ok, true);
    assert.equal(response.body.data.status, 'ok');
    assert.equal(response.body.requestId, 'test-request-001');
  });

  it('returns readiness data', async () => {
    const response = await get('/api/v1/ready');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'ready');
  });

  it('returns a standardized 401 response for the unauthenticated me endpoint', async () => {
    const response = await get('/api/v1/me');
    assert.equal(response.status, 401);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(typeof response.body.requestId, 'string');
  });

  it('returns a standardized 404 response', async () => {
    const response = await get('/api/v1/not-found');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });

  it('runs the local recruitment request and job transaction flow', async () => {
    await login();
    const created = await requestJson('POST', '/api/v1/recruitment-requests', {
      title: '测试数据工程师', departmentId: '数据平台', headcount: 1, employmentType: 'full_time', workMode: 'hybrid', justification: '验证事务链路'
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.data.status, 'draft')
    const id = created.body.data.id

    assert.equal((await requestJson('POST', `/api/v1/recruitment-requests/${id}/submit`, {})).body.data.status, 'pending_approval')
    const forbiddenApproval = await requestJson('POST', `/api/v1/recruitment-requests/${id}/approve`, {})
    assert.equal(forbiddenApproval.status, 403)
    await loginAs('approver@smartrecruit.local', 'approver123')
    assert.equal((await requestJson('POST', `/api/v1/recruitment-requests/${id}/approve`, {})).body.data.status, 'approved')
    await loginAs('recruiter@smartrecruit.local', 'recruiter123')
    const job = await requestJson('POST', '/api/v1/jobs', {
      title: '测试数据工程师', departmentId: '数据平台', recruitmentRequestId: id, headcount: 1, employmentType: 'full_time', workMode: 'hybrid'
    })
    assert.equal(job.status, 201)
    assert.equal(job.body.data.status, 'draft')
    const jobId = job.body.data.id
    await requestJson('POST', `/api/v1/jobs/${jobId}/spec`, { title: '测试数据工程师', summary: '负责数据服务', responsibilities: ['建设数据服务'], requirements: [], skills: ['SQL'] })
    await requestJson('POST', `/api/v1/jobs/${jobId}/jd`, { language: 'zh-CN', content: '负责数据服务建设' })
    const specVersions = await get(`/api/v1/jobs/${jobId}/spec-versions`)
    assert.equal(specVersions.status, 200)
    assert.equal(specVersions.body.data.length, 1)
    assert.equal(specVersions.body.data[0].version, 1)
    assert.equal(specVersions.body.data[0].jobId, jobId)
    const jdVersions = await get(`/api/v1/jobs/${jobId}/jd-versions`)
    assert.equal(jdVersions.status, 200)
    assert.equal(jdVersions.body.data.length, 1)
    assert.equal(jdVersions.body.data[0].version, 1)
    assert.equal(jdVersions.body.data[0].jobId, jobId)
    assert.equal((await requestJson('POST', `/api/v1/jobs/${jobId}/confirm-spec`, {})).body.data.status, 'draft')
    assert.equal((await requestJson('POST', `/api/v1/jobs/${jobId}/confirm-jd`, {})).body.data.status, 'ready')
    assert.equal((await requestJson('POST', `/api/v1/jobs/${jobId}/publish`, {})).body.data.status, 'published')
    const converted = await requestJson('POST', `/api/v1/recruitment-requests/${id}/convert`, {})
    assert.equal(converted.body.data.status, 'converted')
    assert.ok(converted.body.data.convertedJobIds.includes(jobId))
  })

  it('keeps approval instances, steps, and immutable records for recruitment requests', async () => {
    await loginAs('recruiter@smartrecruit.local', 'recruiter123')
    const created = await requestJson('POST', '/api/v1/recruitment-requests', { title: '审批实例测试岗位', departmentId: '数据平台', headcount: 2, employmentType: 'full_time', workMode: 'hybrid', justification: '验证审批实例历史' })
    assert.equal(created.status, 201)
    const id = created.body.data.id
    await requestJson('POST', '/api/v1/recruitment-requests/' + id + '/submit', {})

    const pendingApproval = await get('/api/v1/recruitment-requests/' + id + '/approval')
    assert.equal(pendingApproval.status, 200)
    assert.ok(pendingApproval.body.data.current)
    assert.equal(pendingApproval.body.data.current.version, 1)
    assert.equal(pendingApproval.body.data.steps.length, 1)
    assert.equal(pendingApproval.body.data.records.length, 0)

    await loginAs('approver@smartrecruit.local', 'approver123')
    await requestJson('POST', '/api/v1/recruitment-requests/' + id + '/reject', { reason: '预算需要调整' })

    const rejectedApproval = await get('/api/v1/recruitment-requests/' + id + '/approval')
    assert.equal(rejectedApproval.body.data.current.status, 'rejected')
    assert.equal(rejectedApproval.body.data.records.length, 1)
    const rejectedRecord = rejectedApproval.body.data.records[0]
    assert.equal(rejectedRecord.action, 'reject')
    assert.equal(rejectedRecord.comment, '预算需要调整')

    await loginAs('recruiter@smartrecruit.local', 'recruiter123')
    await requestJson('POST', '/api/v1/recruitment-requests/' + id + '/resubmit', {})
    const resubmittedApproval = await get('/api/v1/recruitment-requests/' + id + '/approval')
    assert.equal(resubmittedApproval.body.data.current.version, 2)
    assert.equal(resubmittedApproval.body.data.current.status, 'pending')
    assert.equal(resubmittedApproval.body.data.steps.filter((item: any) => item.instanceId === resubmittedApproval.body.data.current.id).length, 1)

    const history = await requestJson('GET', '/api/v1/recruitment-requests/' + id + '/approval')
    assert.equal(history.body.data.records.length, 1)
  })

  it('keeps candidates and applications separate', async () => {
    const candidates = await get('/api/v1/candidates')
    assert.equal(candidates.status, 200)
    assert.ok(Array.isArray(candidates.body.data))
    assert.ok(candidates.body.data[0].applications.length > 0)
    const applications = await get('/api/v1/applications')
    assert.equal(applications.status, 200)
    assert.ok(applications.body.data.every((item: any) => item.candidateId && item.jobId))
  })

  it('returns aggregated recruiting reports from persisted entities', async () => {
    const response = await get('/api/v1/reports')
    assert.equal(response.status, 200)
    assert.equal(response.body.data.funnel[0].count, response.body.data.summary[0].value)
    assert.equal(response.body.data.funnel[2].count, 1)
    assert.ok(response.body.data.jobFilling.some((item: any) => item.code === 'JOB-108'))
    assert.ok(response.body.data.channels.some((item: any) => item.channel === '内推'))
    assert.ok(response.body.data.statusStats.some((item: any) => item.entity === '申请' && item.status === 'human_review'))
    assert.ok(response.body.data.recruitmentCycle)
    assert.equal(typeof response.body.data.recruitmentCycle.hiredCount, 'number')
    assert.ok(response.body.data.feedbackCompletion)
    assert.equal(typeof response.body.data.feedbackCompletion.expected, 'number')
    assert.equal(typeof response.body.data.feedbackCompletion.locked, 'number')
    assert.ok(response.body.data.offerAcceptance)
    assert.equal(typeof response.body.data.offerAcceptance.sent, 'number')
    assert.equal(typeof response.body.data.offerAcceptance.accepted, 'number')
  })

  it('creates a clean resume and analyzes it without a scanner dependency', async () => {
    const candidates = await get('/api/v1/candidates')
    const candidate = candidates.body.data[0]
    const application = candidate.applications[0]
    const created = await requestJson('POST', '/api/v1/resumes', {
      candidateId: candidate.id,
      applicationId: application.id,
      originalFilename: 'resume.txt',
      mimeType: 'text/plain',
      content: `${candidate.fullName}\nJava Spring Boot PostgreSQL\n8 years experience`
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.data.resume.scanStatus, 'clean')
    assert.equal(created.body.data.task.status, 'queued')

    const binaryContent = '\u4f60\u597d123'
    const binaryCreated = await requestJson('POST', '/api/v1/resumes', {
      candidateId: candidate.id,
      originalFilename: 'resume.doc',
      mimeType: 'application/msword',
      content: Buffer.from(binaryContent, 'utf8').toString('base64'),
      encoding: 'base64'
    })
    assert.equal(binaryCreated.status, 201)
    assert.equal(binaryCreated.body.data.resume.sizeBytes, Buffer.byteLength(binaryContent, 'utf8'))
    assert.equal(binaryCreated.body.data.resume.mimeType, 'application/msword')
    assert.match(binaryCreated.body.data.resume.storageKey, /^[0-9a-f-]+\.doc$/)

    const processed = await requestJson('POST', '/api/v1/analysis-tasks/' + created.body.data.task.id, {})
    assert.equal(processed.status, 200)

    const detail = await get(`/api/v1/candidates/${candidate.id}`)
    assert.equal(detail.status, 200)
    assert.ok(Array.isArray(detail.body.data.analysisTasks))
    const detailTask = detail.body.data.analysisTasks.find((task: any) => task.id === created.body.data.task.id)
    assert.ok(detailTask)
    assert.equal(detailTask.status, 'completed')
  })

  it('rejects unsafe resume filenames before persisting the upload', async () => {
    const response = await requestJson('POST', '/api/v1/resumes', {
      candidateId: 'candidate-8821',
      originalFilename: '../resume.txt',
      mimeType: 'text/plain',
      content: 'unsafe filename',
    })
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'VALIDATION_ERROR')
  })

  it('runs the interview feedback lock and application advancement flow', async () => {
    const applications = await get('/api/v1/applications')
    const application = applications.body.data.find((item: any) => item.status === 'human_review')
    assert.ok(application)
    const created = await requestJson('POST', '/api/v1/interviews', { applicationId: application.id, title: '技术面', type: 'technical', participants: [{ userId: 'user-interviewer', name: '林晓', role: 'interviewer' }] })
    assert.equal(created.status, 201)
    const interviewId = created.body.data.id

    const detail = await get(`/api/v1/interviews/${interviewId}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.data.id, interviewId)
    assert.equal(detail.body.data.application.id, application.id)
    assert.equal(detail.body.data.feedbackStatus, 'pending')
    assert.deepEqual(detail.body.data.feedback, [])
    assert.equal((await requestJson('POST', `/api/v1/interviews/${interviewId}/feedback`, { interviewerId: 'user-interviewer', overallScore: 90, recommendation: 'yes' })).body.data.status, 'submitted')
    assert.equal((await requestJson('POST', `/api/v1/interviews/${interviewId}/lock-feedback`, { interviewerId: 'user-interviewer' })).body.data.status, 'locked')
    assert.equal((await requestJson('POST', `/api/v1/interviews/${interviewId}/conclude`, { outcome: 'offer' })).body.data.status, 'completed')
    const updated = await get('/api/v1/applications')
    assert.equal(updated.body.data.find((item: any) => item.id === application.id).status, 'offer_approval')
  })

  it('generates advisory interview questions without changing application status', async () => {
    const interview = (await get('/api/v1/interviews')).body.data[0]; assert.ok(interview)
    const application = (await get('/api/v1/applications')).body.data.find((item: any) => item.id === interview.applicationId); assert.ok(application)

    const originalFetch = globalThis.fetch
    const previous = { baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }
    process.env.OPENAI_BASE_URL = 'https://model.example.test/v1'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'test-model'
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions: [{ category: 'technical', difficulty: 'medium', question: '请说明如何设计幂等接口？', rationale: '验证岗位所需能力', groundedIn: ['岗位要求：接口设计'], scoringRubric: [{ criterion: '方案完整', points: 10 }] }] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    try {
      const response = await requestJson('POST', `/api/v1/interviews/${interview.id}/questions`, {
        jobTitle: '后端工程师', jobRequirements: ['接口设计'], anonymizedResume: '具有五年后端开发经验', analysisSummary: ['熟悉接口设计'], questionCount: 1,
      })
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(response.body.data.advisoryOnly, true)
      assert.equal(response.body.data.applicationStatusMutation, 'none')
      assert.equal(response.body.data.questions.length, 1)
      const after = (await get('/api/v1/applications')).body.data.find((item: any) => item.id === application.id)
      assert.equal(after.status, application.status)
    } finally {
      globalThis.fetch = originalFetch
      if (previous.baseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous.baseUrl
      if (previous.apiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.apiKey
      if (previous.model === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = previous.model
    }
  })

  it('standardizes interview question errors and enforces interview roles', async () => {
    const interview = (await get('/api/v1/interviews')).body.data[0]
    assert.ok(interview)
    const previous = { baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }
    delete process.env.OPENAI_BASE_URL; delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_MODEL
    const unavailable = await requestJson('POST', `/api/v1/interviews/${interview.id}/questions`, { jobTitle: '工程师', jobRequirements: ['开发'], anonymizedResume: '匿名简历', analysisSummary: [], questionCount: 1 })
    assert.equal(unavailable.status, 503)
    assert.equal(unavailable.body.error.code, 'AI_NOT_CONFIGURED')
    await loginAs('approver@smartrecruit.local', 'approver123')
    const forbidden = await requestJson('POST', `/api/v1/interviews/${interview.id}/questions`, { jobTitle: '工程师', jobRequirements: ['开发'], anonymizedResume: '匿名简历', analysisSummary: [], questionCount: 1 })
    assert.equal(forbidden.status, 403)
    await login()
    if (previous.baseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous.baseUrl
    if (previous.apiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.apiKey
    if (previous.model === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = previous.model
  })

  it('completes the offer approval, response, and onboarding archive flow', async () => {
    const application = (await get('/api/v1/applications')).body.data.find((item: any) => item.status === 'offer_approval')
    assert.ok(application)
    const created = await requestJson('POST', '/api/v1/offers', { applicationId: application.id, positionTitle: '测试工程师', departmentId: '数据平台', employmentType: 'full_time', baseSalary: { amount: 20000, currency: 'CNY' }, content: '欢迎加入' })
    assert.equal(created.status, 201)
    const id = created.body.data.id
    assert.equal((await requestJson('POST', `/api/v1/offers/${id}/submit-approval`, {})).body.data.status, 'pending_approval')
    assert.equal((await requestJson('POST', `/api/v1/offers/${id}/approve`, {})).body.data.status, 'approved')
    assert.equal((await requestJson('POST', `/api/v1/offers/${id}/send`, {})).body.data.status, 'sent')
    assert.equal((await requestJson('POST', `/api/v1/offers/${id}/accept`, {})).body.data.status, 'accepted')
    const archived = await requestJson('POST', `/api/v1/offers/${id}/archive-onboarding`, { reason: '入职资料已归档' })
    assert.equal(archived.body.data.status, 'pending')
    assert.equal((await get(`/api/v1/offers/${id}`)).body.data.onboarding.status, 'pending')
    assert.equal((await requestJson('POST', `/api/v1/onboarding/${archived.body.data.id}/complete`, {})).body.data.status, 'completed')
  })

  it('supports offer rejection, draft revision, and expiry', async () => {
    const application = (await get('/api/v1/applications')).body.data.find((item: any) => item.status === 'interviewing')
    assert.ok(application)

    const created = await requestJson('POST', '/api/v1/offers', { applicationId: application.id, positionTitle: '修订前岗位', departmentId: '数据平台', employmentType: 'full_time', baseSalary: { amount: 18000, currency: 'CNY' }, content: '初版内容' })
    assert.equal(created.status, 201)
    const id = created.body.data.id

    const revised = await requestJson('PATCH', `/api/v1/offers/${id}`, { positionTitle: '修订后岗位', content: '修订版内容' })
    assert.equal(revised.body.data.status, 'draft')
    assert.equal(revised.body.data.version, 2)
    const detail = await get(`/api/v1/offers/${id}`)
    assert.ok(detail.body.data.versions.length >= 2)

    await requestJson('POST', `/api/v1/offers/${id}/submit-approval`, {})
    const rejected = await requestJson('POST', `/api/v1/offers/${id}/reject`, { reason: '薪资需调整' })
    assert.equal(rejected.body.data.status, 'draft')
    assert.equal(rejected.body.data.approval.status, 'rejected')

    await requestJson('POST', `/api/v1/offers/${id}/submit-approval`, {})
    await requestJson('POST', `/api/v1/offers/${id}/approve`, {})
    await requestJson('POST', `/api/v1/offers/${id}/send`, {})
    const expired = await requestJson('POST', `/api/v1/offers/${id}/expire`, {})
    assert.equal(expired.body.data.status, 'expired')
  })

  it('exposes candidate, application, and interview workflow event subjects', async () => {
    const jobs = await get('/api/v1/jobs')
    const job = jobs.body.data.find((item: any) => item.status === 'published')
    assert.ok(job)

    const candidate = await requestJson('POST', '/api/v1/candidates', { fullName: '审计候选人', email: 'audit.candidate@example.com', source: '内部推荐' })
    assert.equal(candidate.status, 201)
    const candidateId = candidate.body.data.id

    const application = await requestJson('POST', '/api/v1/applications', { candidateId, jobId: job.id, source: '内部推荐' })
    assert.equal(application.status, 201)
    const applicationId = application.body.data.id

    assert.equal((await requestJson('POST', `/api/v1/applications/${applicationId}/status`, { status: 'analysis_queued' })).body.data.status, 'analysis_queued')
    assert.equal((await requestJson('POST', `/api/v1/applications/${applicationId}/status`, { status: 'human_review' })).body.data.status, 'human_review')

    const archivedCandidate = await requestJson("PATCH", `/api/v1/candidates/${candidateId}`, { status: 'archived', reason: '隐私保护' })
    assert.equal(archivedCandidate.status, 200)
    assert.equal(archivedCandidate.body.data.status, 'archived')

    const invalidStatus = await requestJson("PATCH", `/api/v1/candidates/${candidateId}`, { status: 'invalid_status' })
    assert.equal(invalidStatus.status, 400)

    const restoredCandidate = await requestJson("PATCH", `/api/v1/candidates/${candidateId}`, { status: 'active' })
    assert.equal(restoredCandidate.body.data.status, 'active')

    const candidateEvents = await get('/api/v1/workflow-events?subjectType=candidate&limit=20')
    assert.equal(candidateEvents.status, 200)
    const candidateCreated = candidateEvents.body.data.find((item: any) => item.subjectId === candidateId && item.action === 'create')
    assert.ok(candidateCreated)
    assert.equal(candidateCreated.subjectLabel, '审计候选人')
    const candidateStatusChanged = candidateEvents.body.data.find((item: any) => item.subjectId === candidateId && item.action === 'status_changed' && item.toStatus === 'archived')
    assert.ok(candidateStatusChanged)
    assert.equal(candidateStatusChanged.fromStatus, 'active')
    assert.equal(candidateStatusChanged.toStatus, 'archived')

    const applicationEvents = await get('/api/v1/workflow-events?subjectType=application&limit=20')
    assert.equal(applicationEvents.status, 200)
    assert.ok(applicationEvents.body.data.some((item: any) => item.subjectId === applicationId && item.action === 'create'))
    const statusChanged = applicationEvents.body.data.find((item: any) => item.subjectId === applicationId && item.action === 'status_changed')
    assert.ok(statusChanged)
    assert.equal(statusChanged.fromStatus, 'analysis_queued')
    assert.equal(statusChanged.toStatus, 'human_review')

    const interviewEvents = await get('/api/v1/workflow-events?subjectType=interview&limit=50')
    assert.equal(interviewEvents.status, 200)
    assert.ok(interviewEvents.body.data.some((item: any) => item.action === 'create'))
    assert.ok(interviewEvents.body.data.some((item: any) => item.action === 'feedback_submitted'))
    assert.ok(interviewEvents.body.data.some((item: any) => item.action === 'feedback_locked'))
    assert.ok(interviewEvents.body.data.some((item: any) => item.action === 'conclude'))
  })

  it('exposes job creation, spec, and JD workflow audit events', async () => {
    const response = await get('/api/v1/workflow-events?subjectType=job&limit=50')
    assert.equal(response.status, 200)
    assert.ok(Array.isArray(response.body.data))
    const expectedActions = ['create_job', 'spec_created', 'jd_created', 'confirm_spec', 'confirm_jd', 'publish']
    for (const action of expectedActions) {
      const event = response.body.data.find((item: any) => item.action === action)
      assert.ok(event, `missing job workflow event ${action}`)
      assert.equal(event.subjectType, 'job')
      assert.ok(event.subjectLabel)
    }
  })


  it('archives accepted offers into onboarding and lists onboarding records', async () => {
    const applications = await get('/api/v1/applications')
    const application = applications.body.data.find((item: any) => item.status === 'interviewing')
    assert.ok(application)

    const created = await requestJson('POST', '/api/v1/offers', { applicationId: application.id, positionTitle: '入职归档岗位', departmentId: '技术中心', employmentType: 'full_time', startDate: '2026-10-08', baseSalary: { amount: 22000, currency: 'CNY' }, content: 'Offer 内容' })
    assert.equal(created.status, 201)
    const offerId = created.body.data.id

    await requestJson('POST', `/api/v1/offers/${offerId}/submit-approval`, {})
    await requestJson('POST', `/api/v1/offers/${offerId}/approve`, {})
    await requestJson('POST', `/api/v1/offers/${offerId}/send`, {})
    const accepted = await requestJson('POST', `/api/v1/offers/${offerId}/accept`, {})
    assert.equal(accepted.body.data.status, 'accepted')

    const archived = await requestJson('POST', `/api/v1/offers/${offerId}/archive-onboarding`, {})
    assert.equal(archived.status, 200)
    assert.equal(archived.body.data.status, 'pending')

    const list = await get('/api/v1/onboarding')
    assert.equal(list.status, 200)
    const record = list.body.data.find((item: any) => item.offerId === offerId)
    assert.ok(record)
    assert.equal(record.applicationId, application.id)
    assert.equal(record.status, 'pending')

    const scheduled = await requestJson('POST', `/api/v1/onboarding/${record.id}/schedule`, {})
    assert.equal(scheduled.status, 200)
    assert.equal(scheduled.body.data.status, 'scheduled')

    const patched = await requestJson('PATCH', `/api/v1/onboarding/${record.id}`, { plannedStartDate: '2026-10-21', notes: '准备入职资料' })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.data.plannedStartDate, '2026-10-21')
    assert.equal(patched.body.data.notes, '准备入职资料')

    const completed = await requestJson('POST', `/api/v1/onboarding/${record.id}/complete`, {})
    assert.equal(completed.status, 200)
    assert.equal(completed.body.data.status, 'completed')
    assert.ok(completed.body.data.archivedAt)

    const applicationAfter = await get('/api/v1/applications')
    const hiredApplication = applicationAfter.body.data.find((item: any) => item.id === application.id)
    assert.equal(hiredApplication.status, 'onboarding_archived')

    const detail = await get(`/api/v1/onboarding/${record.id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.data.id, record.id)
    assert.equal(detail.body.data.status, 'completed')
  })
  it('exposes offer workflow events for audit views', async () => {
    const response = await get('/api/v1/workflow-events?subjectType=offer&limit=20')
    assert.equal(response.status, 200)
    assert.ok(Array.isArray(response.body.data))
    const event = response.body.data.find((item: any) => item.action === 'expire')
    assert.ok(event)
    assert.equal(event.subjectType, 'offer')
    assert.ok(event.subjectLabel)
    assert.ok(event.fromStatus)
    assert.ok(event.toStatus)

    const me = await get('/api/v1/me')
    assert.equal(me.status, 200)
    const expectedActorId = me.body.data.user.id
    assert.ok(expectedActorId)

    const createEvent = response.body.data.find((item: any) => item.action === 'create')
    assert.ok(createEvent, 'missing offer create audit event')
    assert.equal(createEvent.actorId, expectedActorId)
    assert.equal(createEvent.toStatus, 'draft')

    const actedEvents = response.body.data.filter((item: any) => ['create', 'revise', 'submit_approval', 'approve', 'send', 'accept', 'expire'].includes(item.action))
    assert.ok(actedEvents.length > 0)
    for (const item of actedEvents) {
      assert.equal(item.actorId, expectedActorId, `offer audit action ${item.action} should capture authenticated actor`)
    }
  })
  });

  it('rejects stale If-Match versions before mutating a recruitment request', async () => {
    await login();
    const requests = await get('/api/v1/recruitment-requests');
    const request = requests.body.data.find((item: any) => item.status === 'draft');
    assert.ok(request);

    const response = await requestJson(
      'PATCH',
      `/api/v1/recruitment-requests/${request.id}`,
      { title: '不应写入的并发修改' },
      { 'if-match': `"${request.version + 1}"` },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'VERSION_CONFLICT');
    const after = await get(`/api/v1/recruitment-requests/${request.id}`);
    assert.notEqual(after.body.data.title, '不应写入的并发修改');
  });

  it('returns pagination meta with totalPages and rejects invalid paging parameters', async () => {
    await login();
    const unpaged = await get('/api/v1/candidates');
    assert.equal(unpaged.status, 200);
    assert.ok(Array.isArray(unpaged.body.data), '未分页时 data 仍应是数组');
    assert.equal(unpaged.body.meta, undefined, '未分页时不应返回 meta');
    const total = unpaged.body.data.length;

    const firstPage = await get('/api/v1/candidates?page=1&pageSize=2');
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.data.page, 1);
    assert.equal(firstPage.body.data.pageSize, 2);
    assert.equal(firstPage.body.data.total, total);
    assert.deepEqual(firstPage.body.data.items, unpaged.body.data.slice(0, 2));
    assert.deepEqual(firstPage.body.meta.pagination, { page: 1, pageSize: 2, total, totalPages: Math.ceil(total / 2) });

    const secondPage = await get('/api/v1/candidates?page=2&pageSize=2');
    assert.deepEqual(secondPage.body.data.items, unpaged.body.data.slice(2, 4));
    assert.equal(secondPage.body.meta.pagination.page, 2);

    const beyond = await get(`/api/v1/candidates?page=${Math.ceil(total / 2) + 5}&pageSize=2`);
    assert.equal(beyond.status, 200);
    assert.deepEqual(beyond.body.data.items, [], '越界页应返回空数组而不是报错');
    assert.equal(beyond.body.meta.pagination.total, total);

    const sizeOnly = await get('/api/v1/candidates?pageSize=1');
    assert.equal(sizeOnly.body.data.page, 1, '只给 pageSize 时 page 默认 1');
    assert.equal(sizeOnly.body.data.items.length, Math.min(1, total));

    for (const query of ['page=0', 'page=-1', 'page=abc', 'page=1.5', 'pageSize=0', 'pageSize=101', 'pageSize=abc']) {
      const invalid = await get(`/api/v1/candidates?${query}`);
      assert.equal(invalid.status, 400, `${query} 应被拒绝`);
      assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('replays idempotent writes and rejects key reuse with a different payload', async () => {
    await login();
    const key = 'test-idem-key-0001';
    const payload = { fullName: '幂等候选人甲', email: 'idem-a@smartrecruit.local' };

    const first = await requestJson('POST', '/api/v1/candidates', payload, { 'idempotency-key': key });
    assert.equal(first.status, 201);
    assert.equal(first.headers['idempotency-replay'], undefined);

    const replay = await requestJson('POST', '/api/v1/candidates', payload, { 'idempotency-key': key });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers['idempotency-replay'], 'true', '重放必须标记 idempotency-replay');
    assert.deepEqual(replay.body.data, first.body.data, '重放必须返回与首次完全一致的资源');

    const list = await get('/api/v1/candidates');
    assert.equal(list.body.data.filter((item: any) => item.fullName === payload.fullName).length, 1, '重放不应重复写库');

    const reuse = await requestJson('POST', '/api/v1/candidates', { fullName: '幂等候选人乙' }, { 'idempotency-key': key });
    assert.equal(reuse.status, 409);
    assert.equal(reuse.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

    const invalidKey = await requestJson('POST', '/api/v1/candidates', payload, { 'idempotency-key': 'short' });
    assert.equal(invalidKey.status, 400);
    assert.equal(invalidKey.body.error.code, 'IDEMPOTENCY_KEY_INVALID');

    const retryKey = 'test-idem-retry-0002';
    const failed = await requestJson('POST', '/api/v1/candidates', { email: 'no-name@smartrecruit.local' }, { 'idempotency-key': retryKey });
    assert.equal(failed.status, 400);
    const retried = await requestJson('POST', '/api/v1/candidates', { fullName: '重试候选人', email: 'no-name@smartrecruit.local' }, { 'idempotency-key': retryKey });
    assert.equal(retried.status, 201, '失败响应不落幂等记录，同键可重试');
    assert.equal(retried.headers['idempotency-replay'], undefined);

    const plain = await requestJson('POST', '/api/v1/candidates', { fullName: '无幂等键候选人' });
    assert.equal(plain.status, 201, '不带幂等键的写请求不受影响');
  });

  it('scopes interviews, offers, and onboarding to the department for hiring managers', async () => {
    await login();
    // 两侧都新建候选人+申请，避免依赖前面用例对种子数据的改动
    const newApplication = async (fullName: string, jobId: string) => {
      const candidate = await requestJson('POST', '/api/v1/candidates', { fullName });
      assert.equal(candidate.status, 201, JSON.stringify(candidate.body));
      const application = await requestJson('POST', '/api/v1/applications', { candidateId: candidate.body.data.id, jobId });
      assert.equal(application.status, 201, JSON.stringify(application.body));
      return application.body.data.id as string;
    };
    const techApplicationId = await newApplication('部门范围候选人-技术', 'job-108');
    const foreignApplicationId = await newApplication('部门范围候选人-客户成功', 'job-107');

    // 安排面试会自动把申请从 pending_analysis 推进到 interviewing
    const techInterview = await requestJson('POST', '/api/v1/interviews', { applicationId: techApplicationId, title: '技术面', participants: [{ userId: 'interviewer-tech', role: 'interviewer' }] });
    const foreignInterview = await requestJson('POST', '/api/v1/interviews', { applicationId: foreignApplicationId, title: '客户成功面', participants: [{ userId: 'interviewer-success', role: 'interviewer' }] });
    assert.equal(techInterview.status, 201, JSON.stringify(techInterview.body));
    assert.equal(foreignInterview.status, 201, JSON.stringify(foreignInterview.body));

    // hiring_manager 可写面试：新建面试同样要受部门范围约束
    await loginAs('manager@smartrecruit.local', 'manager123');
    const foreignInterviewCreate = await requestJson('POST', '/api/v1/interviews', { applicationId: foreignApplicationId, title: '越权面试', participants: [{ userId: 'interviewer-hm', role: 'interviewer' }] });
    assert.equal(foreignInterviewCreate.status, 403, '跨部门新建面试必须被拒绝');
    const ownInterviewCreate = await requestJson('POST', '/api/v1/interviews', { applicationId: techApplicationId, title: '本部门补面', participants: [{ userId: 'interviewer-hm', role: 'interviewer' }] });
    assert.equal(ownInterviewCreate.status, 201, '本部门仍可正常新建面试');
    await login();

    const offerBody = (positionTitle: string, departmentId: string, amount: number) => ({ positionTitle, departmentId, employmentType: 'full_time', baseSalary: { amount, currency: 'CNY' }, content: 'Offer 正文' });
    const techOffer = await requestJson('POST', '/api/v1/offers', { applicationId: techApplicationId, ...offerBody('高级后端工程师', 'dept-tech', 40000) });
    const foreignOffer = await requestJson('POST', '/api/v1/offers', { applicationId: foreignApplicationId, ...offerBody('客户成功经理', 'dept-success', 20000) });
    assert.equal(techOffer.status, 201, JSON.stringify(techOffer.body));
    assert.equal(foreignOffer.status, 201, JSON.stringify(foreignOffer.body));

    const onboardingIds: string[] = [];
    for (const offerId of [techOffer.body.data.id, foreignOffer.body.data.id]) {
      for (const action of ['submit-approval', 'approve', 'send', 'accept', 'archive-onboarding']) {
        const acted = await requestJson('POST', `/api/v1/offers/${offerId}/${action}`);
        assert.equal(acted.status, 200, `Offer ${action} 失败：${JSON.stringify(acted.body)}`);
        if (action === 'archive-onboarding') onboardingIds.push(acted.body.data.id);
      }
    }
    const [techOnboardingId, foreignOnboardingId] = onboardingIds as [string, string];
    assert.ok(techOnboardingId && foreignOnboardingId);

    await loginAs('manager@smartrecruit.local', 'manager123');

    const interviews = await get('/api/v1/interviews');
    assert.equal(interviews.status, 200);
    assert.ok(interviews.body.data.some((item: any) => item.id === techInterview.body.data.id), '本部门面试应可见');
    assert.ok(!interviews.body.data.some((item: any) => item.id === foreignInterview.body.data.id), '跨部门面试不应可见');

    const offers = await get('/api/v1/offers');
    assert.ok(offers.body.data.some((item: any) => item.id === techOffer.body.data.id), '本部门 Offer 应可见');
    assert.ok(!offers.body.data.some((item: any) => item.id === foreignOffer.body.data.id), '跨部门 Offer 不应可见');

    const onboarding = await get('/api/v1/onboarding');
    assert.ok(onboarding.body.data.some((item: any) => item.id === techOnboardingId), '本部门入职归档应可见');
    assert.ok(!onboarding.body.data.some((item: any) => item.id === foreignOnboardingId), '跨部门入职归档不应可见');

    const foreignInterviewDetail = await get(`/api/v1/interviews/${foreignInterview.body.data.id}`);
    assert.equal(foreignInterviewDetail.status, 403);
    assert.equal(foreignInterviewDetail.body.error.code, 'FORBIDDEN');

    const foreignOfferDetail = await get(`/api/v1/offers/${foreignOffer.body.data.id}`);
    assert.equal(foreignOfferDetail.status, 403);
    assert.equal(foreignOfferDetail.body.error.code, 'FORBIDDEN');

    const foreignConclude = await requestJson('POST', `/api/v1/interviews/${foreignInterview.body.data.id}/conclude`, { outcome: 'pass' });
    assert.equal(foreignConclude.status, 403, '跨部门面试反馈/结论必须被拒绝');

    const foreignApplicationStatus = await requestJson('POST', `/api/v1/applications/${foreignApplicationId}/status`, { status: 'rejected', reason: '越权尝试' });
    assert.equal(foreignApplicationStatus.status, 403, '跨部门申请状态变更必须被拒绝');

    const foreignOnboardingComplete = await requestJson('POST', `/api/v1/onboarding/${foreignOnboardingId}/complete`);
    assert.equal(foreignOnboardingComplete.status, 403, '跨部门入职归档操作必须被拒绝');

    await login();
  });
