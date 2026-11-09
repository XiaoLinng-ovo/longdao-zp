import { COMMON_CAPABILITY_DIMENSIONS } from '../src/interviews/question-generator.js';
import { EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer as createSmtpServer, type Server as SmtpServer } from 'node:net';
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
let csrfToken: string | undefined = undefined;
let csrfCookieHeader: string | undefined = undefined;
let smtpServer: SmtpServer;
const receivedSmtpMessages: string[] = [];
const previousAuthPath = process.env.AUTH_STORE_PATH;
const previousQuarantineRoot = process.env.RECRUITING_QUARANTINE_ROOT;
const previousNodeEnv = process.env.NODE_ENV;
const previousDingTalkToken = process.env.DINGTALK_INTEGRATION_TOKEN;
const previousPlatformBaseUrl = process.env.PLATFORM_BASE_URL;
const previousEnvFilePath = process.env.ENV_FILE_PATH;
const previousSmtp = Object.fromEntries(['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'].map(key => [key, process.env[key]]));

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const requestInstance = request(url, { method: 'GET', headers: { origin: baseUrl, ...authHeader, ...headers } }, (response) => {
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
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    const csrfHeaders = isWrite && csrfToken && csrfCookieHeader ? { 'x-csrf-token': csrfToken, cookie: csrfCookieHeader } : {}
    const requestInstance = request(url, {
      method,
      headers: { origin: baseUrl, ...authHeader, ...csrfHeaders, ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
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
  const cookies = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  const sessionCookie = cookies.find((item) => item?.startsWith('smartrecruit_session='))?.split(';')[0];
  const csrfCookie = cookies.find((item) => item?.startsWith('smartrecruit_csrf='))?.split(';')[0];
  assert.ok(sessionCookie, 'login must issue a session cookie');
  const token = decodeURIComponent(sessionCookie.slice('smartrecruit_session='.length));
  authHeader = { authorization: `Bearer ${token}` };
  csrfToken = csrfCookie ? decodeURIComponent(csrfCookie.slice('smartrecruit_csrf='.length)) : undefined;
  csrfCookieHeader = csrfCookie ? `${sessionCookie}; ${csrfCookie}` : undefined;
}

async function login(): Promise<void> {
  await loginAs('recruiter@smartrecruit.local', 'recruiter123');
}

async function passFinalInterview(applicationId: string): Promise<void> {
  const interviews = (await get('/api/v1/interviews?applicationId=' + applicationId)).body.data
  const currentInterviewerCanConclude = (item: any) => item.round === 2
    && item.participants.some((participant: any) => participant.userId === 'user-interviewer' && participant.role === 'interviewer')
  let final = interviews.find(currentInterviewerCanConclude)
  if (!final) {
    const created = await requestJson('POST', '/api/v1/interviews', { applicationId, round: 2, title: '复试', participants: [{ userId: 'user-interviewer', role: 'interviewer' }] })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    final = created.body.data
  }
  const requiredInterviewers = final.participants.filter((participant: any) => participant.required !== false && (participant.role ?? 'interviewer') === 'interviewer')
  for (const interviewer of requiredInterviewers) {
    assert.equal((await requestJson('POST', `/api/v1/interviews/${final.id}/feedback`, { interviewerId: interviewer.userId, overallScore: 90, recommendation: 'yes' })).status, 200)
    assert.equal((await requestJson('POST', `/api/v1/interviews/${final.id}/lock-feedback`, { interviewerId: interviewer.userId })).status, 200)
  }
  assert.equal((await requestJson('POST', `/api/v1/interviews/${final.id}/conclude`, { outcome: 'offer' })).status, 200)
}

async function sendOfferEmail(offerId: string, input: { to?: string; subject?: string; markdown?: string; html?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> {
  return requestJson('POST', `/api/v1/offers/${offerId}/send-email`, {
    to: 'offer-recipient@example.test',
    subject: 'Offer 通知',
    markdown: '欢迎加入。',
    ...input,
  })
}

async function resolveRequiredOnboardingRequirements(onboardingId: string): Promise<void> {
  const tasks = await get(`/api/v1/onboarding/${onboardingId}/tasks`)
  assert.equal(tasks.status, 200, JSON.stringify(tasks.body))
  for (const task of tasks.body.data) {
    if (!task.isRequired || ['completed', 'not_required'].includes(task.status)) continue
    const updated = await requestJson('PATCH', `/api/v1/onboarding/${onboardingId}/tasks/${task.id}`, { status: 'completed' })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
  }

  await loginAs('admin@smartrecruit.local', 'admin123')
  const materials = await get(`/api/v1/onboarding/${onboardingId}/materials`)
  assert.equal(materials.status, 200, JSON.stringify(materials.body))
  for (const material of materials.body.data) {
    if (!material.isRequired || ['verified', 'waived'].includes(material.status)) continue
    const updated = await requestJson('PATCH', `/api/v1/onboarding/${onboardingId}/materials/${material.id}`, { status: 'verified' })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
  }
  await login()
}

function createTestSmtpServer(): SmtpServer {
  return createSmtpServer(socket => {
    let buffer = ''
    let receivingMessage = false
    socket.write('220 localhost ESMTP\r\n')
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      while (buffer.length) {
        if (receivingMessage) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          receivedSmtpMessages.push(buffer.slice(0, end))
          buffer = buffer.slice(end + 5)
          receivingMessage = false
          socket.write('250 queued\r\n')
          continue
        }
        const end = buffer.indexOf('\r\n')
        if (end < 0) return
        const command = buffer.slice(0, end).toUpperCase()
        buffer = buffer.slice(end + 2)
        if (command.startsWith('EHLO') || command.startsWith('HELO')) socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n')
        else if (command.startsWith('AUTH')) socket.write('235 authenticated\r\n')
        else if (command.startsWith('MAIL FROM') || command.startsWith('RCPT TO')) socket.write('250 OK\r\n')
        else if (command === 'DATA') { receivingMessage = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n') }
        else if (command === 'QUIT') { socket.end('221 bye\r\n'); return }
        else socket.write('250 OK\r\n')
      }
    })
  })
}

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DINGTALK_INTEGRATION_TOKEN = 'test-dingtalk-token';
  process.env.PLATFORM_BASE_URL = 'https://recruit.example.test';
  testDirectory = await mkdtemp(join(tmpdir(), 'recruiting-api-test-'));
  process.env.AUTH_STORE_PATH = join(testDirectory, 'auth-sessions.json');
  process.env.RECRUITING_QUARANTINE_ROOT = join(testDirectory, 'resumes');
  process.env.ENV_FILE_PATH = join(testDirectory, 'smtp.env');
  smtpServer = createTestSmtpServer()
  await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', resolve))
  const smtpAddress = smtpServer.address()
  assert.ok(smtpAddress && typeof smtpAddress !== 'string')
  Object.assign(process.env, {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpAddress.port), SMTP_SECURE: 'false',
    SMTP_USER: 'test-user', SMTP_PASSWORD: 'test-password', SMTP_FROM: '招聘团队 <recruiting@example.test>',
  })
  const { createHttpServer } = await import('../src/server.js');
  server = createHttpServer(loadConfig({ NODE_ENV: 'test', PORT: '0' }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await new Promise<void>((resolve, reject) => smtpServer.close((error) => (error ? reject(error) : resolve())));
  if (previousAuthPath === undefined) delete process.env.AUTH_STORE_PATH; else process.env.AUTH_STORE_PATH = previousAuthPath;
  if (previousQuarantineRoot === undefined) delete process.env.RECRUITING_QUARANTINE_ROOT; else process.env.RECRUITING_QUARANTINE_ROOT = previousQuarantineRoot;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  if (previousDingTalkToken === undefined) delete process.env.DINGTALK_INTEGRATION_TOKEN; else process.env.DINGTALK_INTEGRATION_TOKEN = previousDingTalkToken;
  if (previousPlatformBaseUrl === undefined) delete process.env.PLATFORM_BASE_URL; else process.env.PLATFORM_BASE_URL = previousPlatformBaseUrl;
  if (previousEnvFilePath === undefined) delete process.env.ENV_FILE_PATH; else process.env.ENV_FILE_PATH = previousEnvFilePath;
  for (const [key, value] of Object.entries(previousSmtp)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(testDirectory, { recursive: true, force: true });
});

describe('Phase 1 API', { concurrency: false }, () => {
  it('serves original resume bytes privately and enforces candidate and department access', async () => {
    await login()
    const content = 'Original resume contents with all experience'
    const uploaded = await requestJson('POST', '/api/v1/resumes', { candidateId: 'candidate-8821', originalFilename: 'original.txt', mimeType: 'text/plain', content })
    assert.equal(uploaded.status, 201)
    const id = uploaded.body.data.resume.id
    const result = await get('/api/v1/candidates/candidate-8821/resumes/' + id + '/original')
    assert.equal(result.status, 200)
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.equal(Buffer.from(result.body.data.content, 'base64').toString(), content)
    assert.equal((await get('/api/v1/candidates/candidate-8814/resumes/' + id + '/original')).status, 404)
    await loginAs('manager@smartrecruit.local', 'manager123')
    assert.equal((await get('/api/v1/candidates/candidate-8814/resumes/' + id + '/original')).status, 403)
    assert.equal((await get('/api/v1/candidates/candidate-8821/resumes/' + id + '/original', { authorization: 'Bearer invalid' })).status, 401)
    await login()
  })
  it('deletes unused jobs and documents, but protects applications and checks write permissions', async () => {
    await login()
    const created = await requestJson('POST', '/api/v1/jobs', { title: '删除岗位接口测试', departmentId: 'dept-tech', headcount: 1, employmentType: 'full_time', workMode: 'onsite' })
    assert.equal(created.status, 201)
    const id = created.body.data.id
    await requestJson('POST', `/api/v1/jobs/${id}/spec`, { title: '说明书', summary: '摘要', responsibilities: [], requirements: [], skills: [] })
    await requestJson('POST', `/api/v1/jobs/${id}/jd`, { language: 'zh-CN', content: '岗位职责' })
    await loginAs('manager@smartrecruit.local', 'manager123')
    assert.equal((await requestJson('DELETE', `/api/v1/jobs/${id}`)).status, 403)
    assert.equal((await requestJson('DELETE', '/api/v1/jobs/job-106')).status, 403)
    await login()
    const protectedJob = await requestJson('DELETE', '/api/v1/jobs/job-108')
    assert.equal(protectedJob.status, 409)
    assert.equal(protectedJob.body.error.code, 'JOB_IN_USE')
    assert.equal((await get('/api/v1/jobs/job-108')).status, 200)
    const deleted = await requestJson('DELETE', `/api/v1/jobs/${id}`)
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.data.deleted, true)
    assert.equal((await get(`/api/v1/jobs/${id}`)).status, 404)
    assert.equal((await requestJson('DELETE', `/api/v1/jobs/${id}`)).status, 404)
  })
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
    const keys = ['FUNASR_BASE_URL', 'FASTER_WHISPER_BASE_URL', 'OCR_SERVICE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    try {
      const response = await get('/api/v1/ready');
      assert.equal(response.status, 200);
      assert.deepEqual(Object.keys(response.body.data.checks.externalServices).sort(), ['fasterWhisper', 'funasr', 'llm', 'ocr']);
      assert.equal(response.body.data.checks.externalServices.funasr, 'unavailable');
      assert.equal(response.body.data.checks.externalServices.fasterWhisper, 'not_configured');
      assert.equal(response.body.data.checks.externalServices.ocr, 'unavailable');
      // 语音与 OCR 均不可用时不能再对外宣称 ready，否则前端会把降级环境当正常环境使用。
      assert.equal(response.body.data.status, 'degraded');
      assert.ok(response.body.data.degradedReasons.some((reason: string) => reason.includes('语音转写')));
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] as string;
      }
    }
  });

  it('reports configured external services without degrading', async () => {
    const keys = ['OCR_SERVICE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.OCR_SERVICE_URL = 'http://127.0.0.1:9/ocr';
    process.env.OPENAI_BASE_URL = 'https://model.example.test/v1';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'test-model';
    try {
      const response = await get('/api/v1/ready');
      assert.equal(response.status, 200);
      assert.equal(response.body.data.checks.externalServices.llm, 'ok');
      assert.equal(response.body.data.checks.externalServices.ocr, 'ok');
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] as string;
      }
    }
  });

  it('returns a standardized 401 response for the unauthenticated me endpoint', async () => {
    const response = await get('/api/v1/me');
    assert.equal(response.status, 401);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(typeof response.body.requestId, 'string');
  });

  it('routes trial usage through authentication instead of returning not found', async () => {
    const response = await get('/api/v1/trial-usage', { authorization: 'Bearer invalid' });
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

  it('creates and publishes an independent job through HTTP without a recruitment request', async () => {
    await login();
    const before = (await get('/api/v1/recruitment-requests')).body.data;
    const created = await requestJson('POST', '/api/v1/jobs', {
      title: '独立人事岗位接口测试', departmentId: '人事部', headcount: 1, employmentType: 'full_time', workMode: 'onsite',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.recruitmentRequestId, '');
    const id = created.body.data.id;
    const premature = await requestJson('POST', `/api/v1/jobs/${id}/publish`, {});
    assert.equal(premature.body.error.code, 'JOB_DOCUMENT_NOT_CONFIRMED');
    assert.equal((await requestJson('POST', `/api/v1/jobs/${id}/spec`, { title: '人事专员', summary: '档案管理', responsibilities: [], requirements: [], skills: [] })).status, 200);
    assert.equal((await requestJson('POST', `/api/v1/jobs/${id}/jd`, { language: 'zh-CN', content: '档案管理' })).status, 200);
    assert.equal((await requestJson('POST', `/api/v1/jobs/${id}/confirm-spec`, {})).body.data.status, 'draft');
    assert.equal((await requestJson('POST', `/api/v1/jobs/${id}/confirm-jd`, {})).body.data.status, 'ready');
    assert.equal((await requestJson('POST', `/api/v1/jobs/${id}/publish`, {})).body.data.status, 'published');
    assert.deepEqual((await get('/api/v1/recruitment-requests')).body.data, before);
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

  it('generates advisory interview questions without changing application status', async t => {
    t.mock.method(EnterpriseAiStore.prototype, 'runtimeEnv', async () => ({ OPENAI_BASE_URL: 'https://tenant-model.example.test/v1', OPENAI_API_KEY: 'tenant-only-key', OPENAI_MODEL: 'tenant-only-model' }));
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

  it('persists the complete AI capability bank and preserves it on an invalid model response', async (t) => {
    t.mock.method(EnterpriseAiStore.prototype, 'runtimeEnv', async () => ({ OPENAI_BASE_URL: 'https://tenant-model.example.test/v1', OPENAI_API_KEY: 'tenant-only-key', OPENAI_MODEL: 'tenant-only-model' }));
    const interview = (await get('/api/v1/interviews')).body.data[0]; assert.ok(interview);
    const before = (await get('/api/v1/applications')).body.data.find((item: any) => item.id === interview.applicationId);
    const baseQuestion = { sourceEngine: 'llm' as const, category: 'experience', difficulty: 'medium', rationale: '能力考核', groundedIn: ['Java Spring Boot PostgreSQL'], scoringRubric: [{ criterion: '能力证据', points: 10 }] };
    const questions = [
      ...Array.from({ length: 10 }, (_, i) => ({ ...baseQuestion, group: 'ai', question: `简历证据核实 ${i + 1}` })),
      ...(['hr', 'department'] as const).flatMap(group => COMMON_CAPABILITY_DIMENSIONS[group].map(dimension => ({ ...baseQuestion, group, dimension: dimension.id, question: `${group}情境考核 ${dimension.id}`, scoringRubric: [{ criterion: dimension.focus, points: dimension.points }] }))),
    ];
    const originalFetch = globalThis.fetch;
    const requestGroups: string[] = [];
    let rateLimitedHr = false;
    try {
      globalThis.fetch = async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer tenant-only-key');
        const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
        assert.equal(input.questionCount, 5); assert.equal(input.includeCommonQuestions, true);
        requestGroups.push(input.requestedGroup);
        if (input.requestedGroup === 'hr' && !rateLimitedHr) {
          rateLimitedHr = true;
          return new Response('busy', { status: 429, headers: { 'Retry-After': '0' } });
        }
        const offset = Number(input.batchOffset ?? 0)
        const groupQuestions = questions.filter(question => question.group === input.requestedGroup)
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions: groupQuestions.slice(offset, offset + input.questionCount) }) } }] }), { status: 200 });
      };
      const path = `/api/v1/interviews/${interview.id}/questions`;
      assert.equal((await requestJson('POST', path, { questionCount: 10, includeCommonQuestions: 'true' })).status, 400);
      const response = await requestJson('POST', path, { questionCount: 10, includeCommonQuestions: true });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.engine, 'llm'); assert.deepEqual(response.body.data.questions, questions);
      assert.deepEqual(requestGroups, ['ai', 'ai', 'hr', 'hr', 'department']);
      const saved = await get(path); assert.equal(saved.status, 200); assert.deepEqual(saved.body.data.questions, questions); assert.ok(saved.body.data.updatedAt);
      globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"questions":[]}' } }] }), { status: 200 });
      const fallback = await requestJson('POST', path, { questionCount: 10, includeCommonQuestions: true });
      assert.equal(fallback.status, 502); assert.match(fallback.body.error.message, /已保留原题库/);
      assert.deepEqual((await get(path)).body.data.questions, questions);
      assert.equal((await get('/api/v1/applications')).body.data.find((item: any) => item.id === interview.applicationId).status, before.status);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('uses server round context for the second-round 25-question bank and persists it separately', async t => {
    t.mock.method(EnterpriseAiStore.prototype, 'runtimeEnv', async () => ({ OPENAI_BASE_URL: 'https://tenant-model.example.test/v1', OPENAI_API_KEY: 'tenant-only-key', OPENAI_MODEL: 'tenant-only-model' }));
    const initial = (await get('/api/v1/interviews')).body.data[0];
    const savedInitial = (await get('/api/v1/interviews/' + initial.id + '/questions')).body.data;
    const created = await requestJson('POST', '/api/v1/interviews', { applicationId: initial.applicationId, title: '第二轮复试测试', round: 2, participants: initial.participants });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const interview = created.body.data;
    const questions = [
      ...Array.from({ length: 10 }, (_, i) => ({ sourceEngine: 'llm' as const, group: 'ai', question: '复试简历核实 ' + i, category: 'experience', difficulty: 'hard', rationale: '核实证据', groundedIn: ['Java Spring Boot PostgreSQL'], scoringRubric: [{ criterion: '证据', points: 10 }] })),
      ...(['hr', 'department', 'boss'] as const).flatMap(group => COMMON_CAPABILITY_DIMENSIONS[group].map(dimension => ({ sourceEngine: 'llm' as const, group, dimension: dimension.id, question: group + '复试考核 ' + dimension.id, category: 'job_specific', difficulty: 'hard', rationale: dimension.focus, groundedIn: ['Java Spring Boot PostgreSQL'], scoringRubric: [{ criterion: dimension.focus, points: dimension.points }] }))),
    ];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (_url, init) => {
        const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
        assert.equal(input.stage, 'final');
        if (input.requestedGroup === 'boss') assert.equal(input.capabilityDimensions.boss.length, 5);
        const offset = Number(input.batchOffset ?? 0)
        const groupQuestions = questions.filter(question => question.group === input.requestedGroup)
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions: groupQuestions.slice(offset, offset + input.questionCount) }) } }] }), { status: 200 });
      };
      const path = '/api/v1/interviews/' + interview.id + '/questions';
      const result = await requestJson('POST', path, { questionCount: 10, includeCommonQuestions: true, stage: 'initial' });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.data.engine, 'llm');
      assert.equal(result.body.data.questions.length, 25);
      assert.deepEqual((await get(path)).body.data.questions, questions);
      assert.deepEqual((await get('/api/v1/interviews/' + initial.id + '/questions')).body.data, savedInitial);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('generates a job specification from the job title through the configured model', async (t) => {
    t.mock.method(EnterpriseAiStore.prototype, 'runtimeEnv', async () => ({ OPENAI_BASE_URL: 'https://tenant-model.example.test/v1', OPENAI_API_KEY: 'tenant-only-key', OPENAI_MODEL: 'tenant-only-model' }));
    const job = (await get('/api/v1/jobs')).body.data[0]
    assert.ok(job)
    const originalFetch = globalThis.fetch
    const previous = { baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }
    process.env.OPENAI_BASE_URL = 'https://model.example.test/v1'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'test-model'
    globalThis.fetch = async (_url, init) => { assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer tenant-only-key'); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      summary: '负责核心业务系统设计与开发。',
      responsibilities: ['负责核心服务设计', '推动工程质量建设'],
      requirements: [{ label: '三年以上开发经验', description: '具备复杂系统设计能力', required: true }],
      skills: ['Java', 'PostgreSQL'],
    }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }) }
    try {
      const response = await requestJson('POST', `/api/v1/jobs/${job.id}/spec/generate`, {})
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(response.body.data.spec.title, job.title)
      assert.equal(response.body.data.spec.summary, '负责核心业务系统设计与开发。')
      assert.equal(response.body.data.spec.confirmed, false)
      assert.deepEqual(response.body.data.spec.skills, ['Java', 'PostgreSQL'])
    } finally {
      globalThis.fetch = originalFetch
      if (previous.baseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous.baseUrl
      if (previous.apiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.apiKey
      if (previous.model === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = previous.model
    }
  })

  it('falls back to local job specification generation when the model is not configured', async (t) => {
    t.mock.method(EnterpriseAiStore.prototype, 'runtimeEnv', async () => ({}));
    const job = (await get('/api/v1/jobs')).body.data[0]
    assert.ok(job)
    const previous = { baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_MODEL
    try {
      const response = await requestJson('POST', `/api/v1/jobs/${job.id}/spec/generate`, {})
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(response.body.data.spec.generatedBy, 'local_fallback')
      assert.equal(response.body.data.spec.title, job.title)
      assert.ok(response.body.data.spec.summary)
      assert.ok(response.body.data.spec.responsibilities.length > 0)
      assert.ok(response.body.data.spec.skills.length > 0)
    } finally {
      if (previous.baseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous.baseUrl
      if (previous.apiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.apiKey
      if (previous.model === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = previous.model
    }
  })

  it('generates a JD through the configured model', async (t) => {
    t.mock.method(EnterpriseAiStore.prototype, 'runtimeEnv', async () => ({ OPENAI_BASE_URL: 'https://tenant-model.example.test/v1', OPENAI_API_KEY: 'tenant-only-key', OPENAI_MODEL: 'tenant-only-model' }));
    const job = (await get('/api/v1/jobs')).body.data[0]
    assert.ok(job)
    const originalFetch = globalThis.fetch
    const previous = { baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }
    process.env.OPENAI_BASE_URL = 'https://model.example.test/v1'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'test-model'
    globalThis.fetch = async (_url, init) => { assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer tenant-only-key'); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ content: `岗位名称：${job.title}\n\n岗位概述\n负责核心业务。\n\n主要职责\n1. 负责交付\n\n任职要求\n- 三年以上经验\n\n技能要求\nJava` }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }) }
    try {
      const response = await requestJson('POST', `/api/v1/jobs/${job.id}/jd/generate`, {})
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(response.body.data.jd.generatedBy, 'ai_assisted')
      assert.match(response.body.data.jd.content, /主要职责/)
      assert.equal(response.body.data.jd.confirmed, false)
    } finally {
      globalThis.fetch = originalFetch
      if (previous.baseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous.baseUrl
      if (previous.apiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.apiKey
      if (previous.model === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = previous.model
    }
  })

  it('falls back to local JD generation when the model is not configured', async (t) => {
    t.mock.method(EnterpriseAiStore.prototype, 'runtimeEnv', async () => ({}));
    const job = (await get('/api/v1/jobs')).body.data[0]
    assert.ok(job)
    const previous = { baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_MODEL
    try {
      const specResponse = await requestJson('POST', `/api/v1/jobs/${job.id}/spec/generate`, {})
      assert.equal(specResponse.status, 200, JSON.stringify(specResponse.body))
      const response = await requestJson('POST', `/api/v1/jobs/${job.id}/jd/generate`, {})
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(response.body.data.jd.generatedBy, 'local_fallback')
      assert.ok(response.body.data.spec)
      assert.equal(response.body.data.spec.generatedBy, 'local_fallback')
      assert.match(response.body.data.jd.content, /主要职责/)
      assert.match(response.body.data.jd.content, /技能要求/)
    } finally {
      if (previous.baseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous.baseUrl
      if (previous.apiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.apiKey
      if (previous.model === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = previous.model
    }
  })

  it('falls back to local interview questions when AI is unavailable and enforces interview roles', async t => {
    t.mock.method(EnterpriseAiStore.prototype, 'runtimeEnv', async () => ({}));
    const source = (await get('/api/v1/interviews')).body.data[0]
    assert.ok(source)
    const created = await requestJson('POST', '/api/v1/interviews', { applicationId: source.applicationId, title: '无模型参考题测试', round: 1, participants: source.participants })
    assert.equal(created.status, 201)
    const interview = created.body.data
    const previous = { baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }
    delete process.env.OPENAI_BASE_URL; delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_MODEL
    const unavailable = await requestJson('POST', `/api/v1/interviews/${interview.id}/questions`, { jobTitle: '工程师', jobRequirements: ['开发'], anonymizedResume: '匿名简历', analysisSummary: [], questionCount: 1 })
    assert.equal(unavailable.status, 200)
    assert.equal(unavailable.body.data.questions.length, 1)
    assert.equal(unavailable.body.data.engine, 'local_fallback')
    assert.match(unavailable.body.data.generationWarning, /当前企业未完整配置/)
    await loginAs('approver@smartrecruit.local', 'approver123')
    const forbidden = await requestJson('POST', `/api/v1/interviews/${interview.id}/questions`, { jobTitle: '工程师', jobRequirements: ['开发'], anonymizedResume: '匿名简历', analysisSummary: [], questionCount: 1 })
    assert.equal(forbidden.status, 403)
    await login()
    if (previous.baseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous.baseUrl
    if (previous.apiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.apiKey
    if (previous.model === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = previous.model
  })

  it('sends offers directly after email delivery, then completes onboarding archive', async () => {
    const application = (await get('/api/v1/applications')).body.data.find((item: any) => item.status === 'offer_approval')
    assert.ok(application)
    await passFinalInterview(application.id)
    const created = await requestJson('POST', '/api/v1/offers', { applicationId: application.id, positionTitle: '测试工程师', departmentId: '数据平台', employmentType: 'full_time', baseSalary: { amount: 20000, currency: 'CNY' }, content: '欢迎加入' })
    assert.equal(created.status, 201)
    const id = created.body.data.id
    assert.equal('approval' in created.body.data, false)
    const listed = await get('/api/v1/offers')
    assert.equal('approval' in listed.body.data.find((item: any) => item.id === id), false)
    const detailBeforeSend = await get(`/api/v1/offers/${id}`)
    assert.equal('approval' in detailBeforeSend.body.data, false)
    for (const action of ['submit-approval', 'approve', 'reject']) {
      const response = await requestJson('POST', `/api/v1/offers/${id}/${action}`, action === 'reject' ? { reason: '不再使用审批流程' } : {})
      assert.equal(response.status, 409)
      assert.equal(response.body.error.code, 'OFFER_APPROVAL_DISABLED')
    }
    const sent = await sendOfferEmail(id)
    assert.equal(sent.status, 200, JSON.stringify(sent.body))
    assert.equal(sent.body.data.status, 'sent')
    assert.equal('approval' in sent.body.data, false)
    const sentDetail = await get(`/api/v1/offers/${id}`)
    assert.equal(sentDetail.body.data.sentAt, sent.body.data.sentAt)
    assert.ok(sentDetail.body.data.currentVersionId)
    const applicationAfterSend = (await get('/api/v1/applications')).body.data.find((item: any) => item.id === application.id)
    assert.equal(applicationAfterSend.status, 'offer_sent')
    const accepted = await requestJson('POST', `/api/v1/offers/${id}/accept`, {})
    assert.equal(accepted.body.data.status, 'accepted')
    assert.equal('approval' in accepted.body.data, false)
    const applicationAfterAccept = (await get('/api/v1/applications')).body.data.find((item: any) => item.id === application.id)
    assert.equal(applicationAfterAccept.status, 'offer_accepted')
    const beforeAcceptedResendMessages = receivedSmtpMessages.length
    const acceptedResend = await sendOfferEmail(id, { subject: '已接受 Offer 补发', markdown: '补发已接受的 Offer。' })
    assert.equal(acceptedResend.status, 409, JSON.stringify(acceptedResend.body))
    assert.equal(acceptedResend.body.error.code, 'OFFER_EMAIL_NOT_READY')
    assert.equal(receivedSmtpMessages.length, beforeAcceptedResendMessages)
    const archived = await requestJson('POST', `/api/v1/offers/${id}/archive-onboarding`, { reason: '入职资料已归档' })
    assert.equal(archived.body.data.status, 'pending')
    const onboardingId = archived.body.data.id
    const defaultTasks = await get(`/api/v1/onboarding/${onboardingId}/tasks`)
    assert.equal(defaultTasks.status, 200, JSON.stringify(defaultTasks.body))
    assert.deepEqual([...new Set(defaultTasks.body.data.map((task: any) => task.category))].sort(), ['admin', 'candidate', 'hr', 'it', 'manager', 'training'])

    const arrangement = await requestJson('PATCH', `/api/v1/onboarding/${onboardingId}`, {
      plannedStartDate: '2026-11-03',
      plannedStartTime: '09:30',
      reportingMode: 'onsite',
      reportingLocation: 'A 座 12 层',
      reportingContactName: '刘敏',
      reportingContactPhone: '13800000000',
      hrOwnerName: '王 HR',
      hiringManagerName: '陈经理',
      riskNotes: '需在首日开通生产环境只读权限',
    })
    assert.equal(arrangement.status, 200, JSON.stringify(arrangement.body))
    assert.equal(arrangement.body.data.reportingLocation, 'A 座 12 层')
    assert.equal(arrangement.body.data.reportingMode, 'onsite')

    const prepared = await requestJson('POST', `/api/v1/onboarding/${onboardingId}/prepare`, {})
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
    assert.equal(prepared.body.data.status, 'preparing')
    const scheduled = await requestJson('POST', `/api/v1/onboarding/${onboardingId}/schedule`, {})
    assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body))
    assert.equal(scheduled.body.data.status, 'scheduled')

    const addedTask = await requestJson('POST', `/api/v1/onboarding/${onboardingId}/tasks`, { title: '开通 VPN 权限', category: 'it', ownerName: 'IT 服务台', dueDate: '2026-11-02' })
    assert.equal(addedTask.status, 201, JSON.stringify(addedTask.body))
    const blockedWithoutReason = await requestJson('PATCH', `/api/v1/onboarding/${onboardingId}/tasks/${addedTask.body.data.id}`, { status: 'blocked' })
    assert.equal(blockedWithoutReason.status, 400)
    const blockedTask = await requestJson('PATCH', `/api/v1/onboarding/${onboardingId}/tasks/${addedTask.body.data.id}`, { status: 'blocked', blockedReason: '等待网络审批' })
    assert.equal(blockedTask.status, 200, JSON.stringify(blockedTask.body))
    assert.equal(blockedTask.body.data.blockedReason, '等待网络审批')

    const beforeArchivedResendMessages = receivedSmtpMessages.length
    const archivedResend = await sendOfferEmail(id, { subject: '归档后 Offer 补发', markdown: '补发归档后的 Offer。' })
    assert.equal(archivedResend.status, 409, JSON.stringify(archivedResend.body))
    assert.equal(archivedResend.body.error.code, 'OFFER_EMAIL_NOT_READY')
    assert.equal(receivedSmtpMessages.length, beforeArchivedResendMessages)
    assert.equal((await get(`/api/v1/offers/${id}`)).body.data.onboarding.status, 'scheduled')
    const prematureCompletion = await requestJson('POST', `/api/v1/onboarding/${onboardingId}/complete`, {})
    assert.equal(prematureCompletion.status, 409, JSON.stringify(prematureCompletion.body))
    assert.equal(prematureCompletion.body.error.code, 'ONBOARDING_COMPLETION_BLOCKED')
    await resolveRequiredOnboardingRequirements(onboardingId)
    const completed = await requestJson('POST', `/api/v1/onboarding/${onboardingId}/complete`, {})
    assert.equal(completed.status, 200, JSON.stringify(completed.body))
    assert.equal(completed.body.data.status, 'completed')
  })

  it('allows resending cancelled offers while rejecting declined and expired offers', async () => {
    await login()
    for (const status of ['declined', 'cancelled', 'expired'] as const) {
      const candidate = await requestJson('POST', '/api/v1/candidates', { fullName: `可补发 Offer 候选人-${status}` })
      assert.equal(candidate.status, 201, JSON.stringify(candidate.body))
      const application = await requestJson('POST', '/api/v1/applications', { candidateId: candidate.body.data.id, jobId: 'job-108' })
      assert.equal(application.status, 201, JSON.stringify(application.body))
      await passFinalInterview(application.body.data.id)
      const created = await requestJson('POST', '/api/v1/offers', {
        applicationId: application.body.data.id,
        positionTitle: `Offer 补发-${status}`,
        departmentId: '技术中心',
        employmentType: 'full_time',
        baseSalary: { amount: 20000, currency: 'CNY' },
        content: 'Offer 补发测试',
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const offerId = created.body.data.id
      assert.equal((await sendOfferEmail(offerId)).body.data.status, 'sent')
      const terminal = status === 'expired'
        ? await requestJson('POST', `/api/v1/offers/${offerId}/expire`, {})
        : await requestJson('POST', `/api/v1/offers/${offerId}/${status === 'declined' ? 'decline' : 'cancel'}`, { reason: `测试${status}` })
      assert.equal(terminal.status, 200, JSON.stringify(terminal.body))
      assert.equal(terminal.body.data.status, status)
      const currentApplication = (await get('/api/v1/applications')).body.data.find((item: any) => item.id === application.body.data.id)
      assert.equal(currentApplication.status, `offer_${status}`)

      if (status === 'cancelled') {
        for (const action of ['resend-cancelled', 'resend_cancelled']) {
          const directResend = await requestJson('POST', `/api/v1/offers/${offerId}/${action}`, {})
          assert.equal(directResend.status, 409, JSON.stringify(directResend.body))
          assert.equal(directResend.body.error.code, 'OFFER_EMAIL_REQUIRED')
        }
        assert.equal((await get(`/api/v1/offers/${offerId}`)).body.data.status, 'cancelled')
      }

      const beforeResendMessages = receivedSmtpMessages.length
      const resent = await sendOfferEmail(offerId, { subject: `${status} Offer 补发`, markdown: '补发终态 Offer。' })
      if (status === 'cancelled') {
        assert.equal(resent.status, 200, JSON.stringify(resent.body))
        assert.equal(resent.body.data.status, 'sent')
        assert.equal(receivedSmtpMessages.length, beforeResendMessages + 1)
      } else {
        assert.equal(resent.status, 409, JSON.stringify(resent.body))
        assert.equal(resent.body.error.code, 'OFFER_EMAIL_NOT_READY')
        assert.equal(receivedSmtpMessages.length, beforeResendMessages)
      }
    }
  })

  it('delivers a complete Offer template body and resolves its template variables', async () => {
    await login()
    const candidate = await requestJson('POST', '/api/v1/candidates', {
      fullName: 'Offer Template Test Candidate',
      email: 'offer-template-candidate@example.test',
    })
    assert.equal(candidate.status, 201, JSON.stringify(candidate.body))
    const application = await requestJson('POST', '/api/v1/applications', {
      candidateId: candidate.body.data.id,
      jobId: 'job-108',
    })
    assert.equal(application.status, 201, JSON.stringify(application.body))
    await passFinalInterview(application.body.data.id)
    const created = await requestJson('POST', '/api/v1/offers', {
      applicationId: application.body.data.id,
      positionTitle: '模板验证工程师',
      departmentId: '数据平台',
      employmentType: 'full_time',
      startDate: '2026-11-15',
      reportingLocation: '滨江区江陵路88号A座1201',
      invoiceTitle: '测试<科技>有限公司',
      taxNumber: 'TEST9133',
      templateFields: { reportingTime: '09:30', supervisorName: '王经理', supervisorTitle: '研发总监', probationDuration: '3个月', probationSalaryMonths: '3', formalSalaryStartMonth: '4', payday: '15' },
      baseSalary: { amount: 18000, currency: 'CNY' },
      probationSalary: { amount: 15000, currency: 'CNY' },
      benefits: ['五险一金', '带薪年假'],
      materials: ['id_card', 'bank_card:招商银行', 'other:无犯罪记录证明'],
      content: '保存的完整 Offer 模板',
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))

    const messageCount = receivedSmtpMessages.length
    const unresolved = await sendOfferEmail(created.body.data.id, { html: '<p>{{未配置字段}}</p>' })
    assert.equal(unresolved.status, 400, JSON.stringify(unresolved.body))
    assert.equal(unresolved.body.error.code, 'OFFER_TEMPLATE_UNRESOLVED')
    assert.equal(receivedSmtpMessages.length, messageCount)
    await requestJson('PATCH', `/api/v1/offers/${created.body.data.id}`, { templateFields: { supervisorName: '' } })
    const empty = await sendOfferEmail(created.body.data.id, { html: '<p>{{直属上级姓名}}</p>' })
    assert.equal(empty.status, 400, JSON.stringify(empty.body))
    assert.equal(empty.body.error.code, 'OFFER_TEMPLATE_UNRESOLVED')
    assert.equal(receivedSmtpMessages.length, messageCount)
    await requestJson('PATCH', `/api/v1/offers/${created.body.data.id}`, { templateFields: { supervisorName: '王经理' } })
    const sent = await sendOfferEmail(created.body.data.id, {
      subject: '完整 Offer 模板验证 {{直属上级姓名}}',
      html: '<h1>Offer 通知</h1><p>模板正文标记：offer-template-body</p><p>{{报到日期}} {{报到时间}} 前，前往 杭州市余杭区城投未来之星C2幢21楼2105室 办理报到手续。</p><p>抬头：{{发票抬头}} / {{invoiceTitle}}</p><p>税号：{{企业税号}} / {{taxNumber}}</p><p>上级：{{直属上级姓名}}（{{直属上级职务}}）；试用期{{试用期时长}}；前{{试用期薪资适用月数}}个月；第{{转正后薪资生效月份}}个月起；每月{{发薪日}}日</p><ul><li>{{候选人姓名}}</li><li>{{岗位名称}}</li><li>{{试用期月薪}}</li><li>{{转正后月薪}}</li><li>{{其他福利或约定}}</li><li>{{入职材料}}</li><li>{{bankName}}</li></ul>',
    })
    assert.equal(sent.status, 200, JSON.stringify(sent.body))

    const delivered = receivedSmtpMessages.at(-1) ?? ''
    assert.match(delivered, /offer-template-body/u)
    const plainPart = delivered.match(/Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n----_NmP/)
    assert.ok(plainPart, '邮件应包含纯文本正文')
    const plainText = Buffer.from((plainPart?.[1] ?? '').replace(/\s/gu, ''), 'base64').toString('utf8')
    assert.match(plainText, /2026-11-15 09:30 前，前往 滨江区江陵路88号A座1201 办理报到手续/u)
    assert.doesNotMatch(plainText, /杭州市余杭区/u)
    assert.match(plainText, /抬头：测试<科技>有限公司 \/ 测试<科技>有限公司/u)
    assert.match(plainText, /税号：TEST9133 \/ TEST9133/u)
    assert.match(plainText, /上级：王经理（研发总监）；试用期3个月；前3个月；第4个月起；每月15日/u)
    assert.match(plainText, /模板验证工程师/u)
    assert.match(plainText, /15,000/u)
    assert.match(plainText, /18,000/u)
    assert.match(plainText, /无犯罪记录证明/u)
    assert.doesNotMatch(plainText, /other:/u)
    assert.doesNotMatch(delivered, /\{\{/u)
  })

  it('supports draft revision, skips approval, and expires a sent offer', async () => {
    const application = (await get('/api/v1/applications')).body.data.find((item: any) => item.status === 'interviewing')
    assert.ok(application)

    await passFinalInterview(application.id)
    const created = await requestJson('POST', '/api/v1/offers', { applicationId: application.id, positionTitle: '修订前岗位', departmentId: '数据平台', employmentType: 'full_time', baseSalary: { amount: 18000, currency: 'CNY' }, content: '初版内容' })
    assert.equal(created.status, 201)
    const id = created.body.data.id

    const revised = await requestJson('PATCH', `/api/v1/offers/${id}`, { positionTitle: '修订后岗位', content: '修订版内容' })
    assert.equal(revised.body.data.status, 'draft')
    assert.equal(revised.body.data.version, 2)
    const detail = await get(`/api/v1/offers/${id}`)
    assert.ok(detail.body.data.versions.length >= 2)

    const rejected = await requestJson('POST', `/api/v1/offers/${id}/reject`, { reason: '薪资需调整' })
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.error.code, 'OFFER_APPROVAL_DISABLED')

    assert.equal((await sendOfferEmail(id)).body.data.status, 'sent')
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
    const candidate = await requestJson('POST', '/api/v1/candidates', { fullName: '入职归档独立候选人' })
    assert.equal(candidate.status, 201)
    const applicationResponse = await requestJson('POST', '/api/v1/applications', { candidateId: candidate.body.data.id, jobId: 'job-108' })
    assert.equal(applicationResponse.status, 201)
    const application = applicationResponse.body.data
    const beforePass = await get('/api/v1/offers/eligible-applications')
    assert.equal(beforePass.status, 200)
    assert.ok(!beforePass.body.data.some((item: any) => item.id === application.id))
    const ineligibleOffer = await requestJson('POST', '/api/v1/offers', { applicationId: application.id, positionTitle: '入职归档岗位', departmentId: '技术中心', employmentType: 'full_time', baseSalary: { amount: 22000, currency: 'CNY' }, content: 'Offer 内容' })
    assert.equal(ineligibleOffer.status, 409)
    assert.equal(ineligibleOffer.body.error.code, 'OFFER_APPLICATION_INVALID')

    await passFinalInterview(application.id)
    const afterPass = await get('/api/v1/offers/eligible-applications')
    assert.equal(afterPass.status, 200)
    assert.ok(afterPass.body.data.some((item: any) => item.id === application.id))
    const created = await requestJson('POST', '/api/v1/offers', { applicationId: application.id, positionTitle: '入职归档岗位', departmentId: '技术中心', employmentType: 'full_time', startDate: '2026-10-08', baseSalary: { amount: 22000, currency: 'CNY' }, content: 'Offer 内容' })
    assert.equal(created.status, 201)
    let offerId = created.body.data.id

    const sent = await sendOfferEmail(offerId)
    assert.equal(sent.body.data.status, 'sent')
    const sentDetail = await get(`/api/v1/offers/${offerId}`)
    const sentAt = sentDetail.body.data.sentAt
    const sentVersion = sentDetail.body.data.version
    const currentVersionId = sentDetail.body.data.currentVersionId
    const documentVersion = sentDetail.body.data.versions.find((version: any) => version.id === currentVersionId)?.version
    const afterSend = await get('/api/v1/offers/eligible-applications')
    assert.equal(afterSend.status, 200)
    assert.ok(!afterSend.body.data.some((item: any) => item.id === application.id))
    const beforeResendMessages = receivedSmtpMessages.length
    const resent = await sendOfferEmail(offerId, { subject: 'Offer 再次通知', markdown: '这是重新发送的 Offer。' })
    assert.equal(resent.status, 200)
    assert.equal(resent.body.data.status, 'sent')
    assert.equal(receivedSmtpMessages.length, beforeResendMessages + 1)
    const resentDetail = await get(`/api/v1/offers/${offerId}`)
    assert.equal(resentDetail.body.data.version, sentVersion + 1)
    assert.equal(resentDetail.body.data.sentAt, sentAt)
    assert.equal(resentDetail.body.data.currentVersionId, currentVersionId)
    assert.equal(resentDetail.body.data.versions.find((version: any) => version.id === currentVersionId)?.version, documentVersion)
    const applicationAfterResend = (await get('/api/v1/applications')).body.data.find((item: any) => item.id === application.id)
    assert.equal(applicationAfterResend.status, 'offer_sent')

    const cancelled = await requestJson('POST', `/api/v1/offers/${offerId}/cancel`, { reason: '候选人暂缓入职' })
    assert.equal(cancelled.status, 200)
    const afterCancel = await get('/api/v1/offers/eligible-applications')
    assert.ok(afterCancel.body.data.some((item: any) => item.id === application.id))
    const originalResent = await sendOfferEmail(offerId, { subject: '取消后重新发送', markdown: '仅更新本次邮件正文。' })
    assert.equal(originalResent.status, 200)
    assert.equal(originalResent.body.data.status, 'sent')
    const cancelledAgain = await requestJson('POST', `/api/v1/offers/${offerId}/cancel`, { reason: '改为重新创建 Offer' })
    assert.equal(cancelledAgain.status, 200)
    const eligibleAgain = await get('/api/v1/offers/eligible-applications')
    assert.ok(eligibleAgain.body.data.some((item: any) => item.id === application.id))
    const recreated = await requestJson('POST', '/api/v1/offers', {
      applicationId: application.id,
      positionTitle: '入职归档岗位',
      departmentId: '技术中心',
      employmentType: 'full_time',
      startDate: '2026-10-08',
      baseSalary: { amount: 24000, currency: 'CNY' },
      materials: ['medical_report'],
      content: '重新创建的 Offer 内容',
    })
    assert.equal(recreated.status, 201)
    assert.notEqual(recreated.body.data.id, offerId)
    const conflictingResend = await sendOfferEmail(offerId, { subject: '不应发送', markdown: '已有新 Offer' })
    assert.equal(conflictingResend.status, 409)
    offerId = recreated.body.data.id
    const replacementSent = await sendOfferEmail(offerId)
    assert.equal(replacementSent.status, 200)
    assert.equal(replacementSent.body.data.status, 'sent')
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

    const patched = await requestJson('PATCH', `/api/v1/onboarding/${record.id}`, {
      plannedStartDate: '2026-10-21',
      plannedStartTime: '09:30',
      reportingMode: 'onsite',
      reportingLocation: 'A 座 12 层',
      reportingContactName: '刘敏',
      reportingContactPhone: '13800000000',
      notes: '准备入职资料',
    })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.data.plannedStartDate, '2026-10-21')
    assert.equal(patched.body.data.notes, '准备入职资料')

    const prepared = await requestJson('POST', `/api/v1/onboarding/${record.id}/prepare`, {})
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
    const scheduled = await requestJson('POST', `/api/v1/onboarding/${record.id}/schedule`, {})
    assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body))
    assert.equal(scheduled.body.data.status, 'scheduled')

    const prematureCompletion = await requestJson('POST', `/api/v1/onboarding/${record.id}/complete`, {})
    assert.equal(prematureCompletion.status, 409, JSON.stringify(prematureCompletion.body))
    await resolveRequiredOnboardingRequirements(record.id)
    const completed = await requestJson('POST', `/api/v1/onboarding/${record.id}/complete`, {})
    assert.equal(completed.status, 200, JSON.stringify(completed.body))
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

    const actedEvents = response.body.data.filter((item: any) => ['create', 'revise', 'send', 'accept', 'expire'].includes(item.action))
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
    await passFinalInterview(techApplicationId)
    await passFinalInterview(foreignApplicationId)
    const techOffer = await requestJson('POST', '/api/v1/offers', { applicationId: techApplicationId, ...offerBody('高级后端工程师', 'dept-tech', 40000) });
    const foreignOffer = await requestJson('POST', '/api/v1/offers', { applicationId: foreignApplicationId, ...offerBody('客户成功经理', 'dept-success', 20000) });
    assert.equal(techOffer.status, 201, JSON.stringify(techOffer.body));
    assert.equal(foreignOffer.status, 201, JSON.stringify(foreignOffer.body));

    const onboardingIds: string[] = [];
    for (const offerId of [techOffer.body.data.id, foreignOffer.body.data.id]) {
      const sent = await sendOfferEmail(offerId)
      assert.equal(sent.status, 200, `Offer 邮件发送失败：${JSON.stringify(sent.body)}`)
      const accepted = await requestJson('POST', `/api/v1/offers/${offerId}/accept`)
      assert.equal(accepted.status, 200, `Offer 接受失败：${JSON.stringify(accepted.body)}`)
      const archived = await requestJson('POST', `/api/v1/offers/${offerId}/archive-onboarding`)
      assert.equal(archived.status, 200, `Offer 入职归档失败：${JSON.stringify(archived.body)}`)
      onboardingIds.push(archived.body.data.id)
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

describe('resume import batches API', () => {
  it('creates a batch, uploads one file internally, keeps it after cancel and restores progress', async () => {
    await login()
    const created = await requestJson('POST', '/api/v1/resume-import-batches', {
      jobId: 'job-108',
      files: [
        { clientFileId: 'local-1', originalFilename: 'first.txt', mimeType: 'text/plain', sizeBytes: 27 },
        { clientFileId: 'local-2', originalFilename: 'second.txt', mimeType: 'text/plain', sizeBytes: 28 },
      ],
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const batch = created.body.data
    assert.equal(batch.items.length, 2)
    assert.equal(batch.items[0].status, 'pending_upload')

    const uploaded = await requestJson(
      'POST',
      `/api/v1/resume-import-batches/${batch.id}/items/${batch.items[0].id}/content`,
      { content: Buffer.from('Synthetic resume for batch').toString('base64'), encoding: 'base64' },
    )
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body))
    assert.equal(uploaded.body.data.status, 'queued')
    assert.ok(uploaded.body.data.candidateId)
    assert.ok(uploaded.body.data.applicationId)
    assert.ok(uploaded.body.data.analysisTaskId)

    const cancelled = await requestJson('POST', `/api/v1/resume-import-batches/${batch.id}/cancel`)
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
    assert.equal(cancelled.body.data.status, 'cancelled')
    assert.equal(cancelled.body.data.items[0].status, 'queued')
    assert.equal(cancelled.body.data.items[1].status, 'cancelled')

    const restored = await get(`/api/v1/resume-import-batches/${batch.id}`)
    assert.equal(restored.status, 200, JSON.stringify(restored.body))
    assert.equal(restored.body.data.items[0].candidateId, uploaded.body.data.candidateId)
    assert.equal(restored.body.data.items[1].status, 'cancelled')
  })
})

describe('candidate deletion API', () => {
  it('rejects invalid CSRF tokens without deleting the candidate', async () => {
    await login()
    const created = await requestJson('POST', '/api/v1/candidates', { fullName: 'CSRF 删除测试' })
    assert.equal(created.status, 201)
    const id = created.body.data.id
    const previousRequire = process.env.REQUIRE_CSRF
    const previousOrigins = process.env.ALLOWED_ORIGINS
    process.env.REQUIRE_CSRF = 'true'
    process.env.ALLOWED_ORIGINS = 'http://allowed.example.test'
    try {
      const invalid = await requestJson('DELETE', `/api/v1/candidates/${id}`, undefined, { origin: 'http://allowed.example.test', 'x-csrf-token': 'invalid-token' })
      assert.equal(invalid.status, 403)
      assert.equal(invalid.body.error.code, 'CSRF_TOKEN_INVALID')
      assert.equal((await get(`/api/v1/candidates/${id}`)).status, 200)
    } finally {
      if (previousRequire === undefined) delete process.env.REQUIRE_CSRF; else process.env.REQUIRE_CSRF = previousRequire
      if (previousOrigins === undefined) delete process.env.ALLOWED_ORIGINS; else process.env.ALLOWED_ORIGINS = previousOrigins
      assert.equal((await requestJson('DELETE', `/api/v1/candidates/${id}`)).status, 200)
    }
  })

  it('requires candidate-write permissions', async () => {
    await loginAs('manager@smartrecruit.local', 'manager123')
    const forbidden = await requestJson('DELETE', '/api/v1/candidates/candidate-8821')
    assert.equal(forbidden.status, 403)
    await login()
  })

  it('persists deletion and returns 404 for repeated deletes', async () => {
    await login()
    const created = await requestJson('POST', '/api/v1/candidates', { fullName: '删除测试候选人' })
    assert.equal(created.status, 201)
    const id = created.body.data.id
    assert.equal((await requestJson('DELETE', `/api/v1/candidates/${id}`)).status, 200)
    assert.equal((await get(`/api/v1/candidates/${id}`)).status, 404)
    const list = await get('/api/v1/candidates')
    assert.ok(!list.body.data.some((item: any) => item.id === id))
    assert.equal((await requestJson('DELETE', `/api/v1/candidates/${id}`)).status, 404)
  })
})
