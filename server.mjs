import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const INDEX_FILE = path.join(ROOT, 'index.html');
const MAX_BODY_BYTES = 3 * 1024 * 1024;const MAX_RESUME_TEXT_CHARS = 24000;
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const LLM_TIMEOUT_MS = Math.min(Math.max(Number(process.env.LLM_TIMEOUT_MS || 30000), 1000), 60000);

const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
let stateWriteQueue = Promise.resolve();
function requestApiKey(req) {
  return normalizeText(req.headers['x-llm-api-key'], 400) || LLM_API_KEY;
}

function aiStatus(apiKey = LLM_API_KEY) {
  return { mode: apiKey ? 'model' : 'default', model: apiKey ? LLM_MODEL : null };
}

async function aiModels(apiKey = LLM_API_KEY) {
  if (!apiKey) return { mode: 'default', model: null, models: [] };
  try {
    const response = await fetch(`${LLM_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) throw new Error(`Model list failed with status ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload?.data)
      ? payload.data.map(item => normalizeText(item?.id, 120)).filter(Boolean).slice(0, 100)
      : [];
    if (!models.includes(LLM_MODEL)) models.unshift(LLM_MODEL);
    return { mode: 'model', model: LLM_MODEL, models };
  } catch (error) {
    return { mode: 'model', model: LLM_MODEL, models: [LLM_MODEL], reason: 'provider_unavailable' };
  }
}
function clampScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;
}

function normalizeText(value, maxLength = 800) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeList(value, maxItems = 6, maxLength = 160) {
  if (!Array.isArray(value)) return [];
  return value.map(item => normalizeText(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

function parseModelJson(content) {
  const source = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(source);
}

function normalizeAnalysis(value) {
  if (!value || typeof value !== 'object') throw new Error('Model response is not an object');
  const dims = value.dims && typeof value.dims === 'object' ? value.dims : value;
  const hard = clampScore(dims.hard ?? dims.hardMatch);
  const exp = clampScore(dims.exp ?? dims.experience);
  const skill = clampScore(dims.skill ?? dims.skills);
  const potential = clampScore(dims.potential);
  const score = clampScore(value.score ?? value.overallScore);
  if ([hard, exp, skill, potential, score].some(item => item === null)) {
    throw new Error('Model response has invalid scores');
  }
  return {
    dims: { hard, exp, skill, potential },
    score,
    summary: normalizeText(value.summary, 1200),
    strengths: normalizeList(value.strengths),
    risks: normalizeList(value.risks),
    interviewQuestions: normalizeList(value.interviewQuestions, 5, 240),
    skills: normalizeList(value.skills, 12, 48),
    profile: {
      education: normalizeText(value.profile?.education, 60),
      years: Math.max(0, Math.min(50, Number(value.profile?.years) || 0)),
      company: normalizeText(value.profile?.company, 120),
      lastTitle: normalizeText(value.profile?.lastTitle, 120)
    }
  };
}

function buildResumePrompt(job, resumeText) {
  const spec = job?.spec && typeof job.spec === 'object' ? job.spec : {};
  const jobContext = {
    title: normalizeText(job?.title, 120),
    department: normalizeText(job?.dept, 120),
    salary: normalizeText(job?.salary, 80),
    description: normalizeText(job?.desc, 2400),
    jd: normalizeText(job?.jd, 6000),
    requirements: Array.isArray(spec.reqs) ? spec.reqs.map(item => normalizeText(item, 240)).filter(Boolean).slice(0, 12) : []
  };
  return [
    '你是一名专业招聘顾问。仅基于提供的信息评估候选人与岗位的匹配度；不得编造候选人未提供的经历。',
    '请只返回 JSON，不要 Markdown 或额外说明。JSON 必须符合：',
    '{"dims":{"hard":0,"exp":0,"skill":0,"potential":0},"score":0,"summary":"","strengths":[""],"risks":[""],"interviewQuestions":[""],"skills":[""],"profile":{"education":"","years":0,"company":"","lastTitle":""}}',
    '所有分数为 0-100 整数；summary 使用中文，说明匹配结论；strengths、risks、interviewQuestions、skills 均为中文字符串数组。',
    `岗位信息：${JSON.stringify(jobContext)}`,
    `候选人简历文本：${resumeText}`
  ].join('\n\n');
}

async function analyzeResume(job, resumeText, requestedModel = '', apiKey = LLM_API_KEY) {
  if (!apiKey) return { mode: 'default', reason: 'not_configured' };
  const model = normalizeText(requestedModel, 120) || LLM_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是严谨的中文招聘评估助手，输出必须是有效 JSON。' },
          { role: 'user', content: buildResumePrompt(job, resumeText) }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Model request failed with status ${response.status}`);
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    return { mode: 'model', model, analysis: normalizeAnalysis(parseModelJson(content)) };
  } catch (error) {
    console.warn(`Resume analysis fallback: ${error.name === 'AbortError' ? 'timeout' : error.message}`);
    return { mode: 'default', reason: 'provider_unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (CORS_ORIGIN) res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.end(body);
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return migrateState(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function migrateState(value) {
  if (!value || typeof value !== 'object') return value;
  if (!Array.isArray(value.jobs)) value.jobs = [];
  if (!Array.isArray(value.cands)) value.cands = [];
  if (!value.forms || typeof value.forms !== 'object' || Array.isArray(value.forms)) value.forms = {};
  if (!value.scores || typeof value.scores !== 'object' || Array.isArray(value.scores)) value.scores = {};
  if (!Array.isArray(value.interviews)) value.interviews = [];
  if (!value.offers || typeof value.offers !== 'object' || Array.isArray(value.offers)) value.offers = {};
  if (!value.onboarding || typeof value.onboarding !== 'object' || Array.isArray(value.onboarding)) value.onboarding = {};
  if (!value.approvalHistory || typeof value.approvalHistory !== 'object' || Array.isArray(value.approvalHistory)) value.approvalHistory = {};
  if (!Array.isArray(value.chatLog)) value.chatLog = [];
  if (!Number.isFinite(Number(value.seq))) value.seq = value.cands.length;
  return value;
}

function isValidState(value) {
  return value && typeof value === 'object' &&
    Array.isArray(value.jobs) && Array.isArray(value.cands) &&
    value.forms && typeof value.forms === 'object' &&
    value.scores && typeof value.scores === 'object' &&
    Array.isArray(value.interviews) && value.offers && typeof value.offers === 'object' &&
    Array.isArray(value.chatLog);
}

async function writeState(state) {
  const normalized = migrateState(state);
  if (!isValidState(normalized)) {
    const error = new Error('Invalid state payload');
    error.statusCode = 400;
    throw error;
  }
  const operation = stateWriteQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tempFile = `${STATE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(normalized, null, 2), 'utf8');
    await fs.rename(tempFile, STATE_FILE);
  });
  stateWriteQueue = operation.catch(() => {});
  return operation;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveIndex(res) {
  const html = await fs.readFile(INDEX_FILE);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LLM-API-Key');
      if (CORS_ORIGIN) res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
      return res.end();
    }

    if (url.pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, service: 'smartrecruit-pro', timestamp: new Date().toISOString() });
    }

    if (url.pathname === '/api/ai/status' && req.method === 'GET') {
      return sendJson(res, 200, aiStatus(requestApiKey(req)));
    }

    if (url.pathname === '/api/ai/models' && req.method === 'GET') {
      return sendJson(res, 200, await aiModels(requestApiKey(req)));
    }

    if (url.pathname === '/api/resume-analysis' && req.method === 'POST') {
      const payload = JSON.parse(await readBody(req));
      const resumeText = normalizeText(payload?.resumeText, MAX_RESUME_TEXT_CHARS);
      if (!resumeText) {
        const error = new Error('resumeText is required');
        error.statusCode = 400;
        throw error;
      }
      return sendJson(res, 200, await analyzeResume(payload?.job || {}, resumeText, payload?.model, requestApiKey(req)));
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const state = await readState();
      return state ? sendJson(res, 200, state) : sendJson(res, 404, { error: 'state_not_initialized' });
    }

    if (url.pathname === '/api/state' && (req.method === 'PUT' || req.method === 'POST')) {
      const state = JSON.parse(await readBody(req));
      await writeState(state);
      return sendJson(res, 200, { ok: true, savedAt: new Date().toISOString() });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveIndex(res);
    }

    sendText(res, 404, 'Not Found');
  } catch (error) {
    const status = error.statusCode || (error instanceof SyntaxError ? 400 : 500);
    sendJson(res, status, { error: status === 500 ? 'internal_server_error' : error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SmartRecruit Pro listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`State file: ${STATE_FILE}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
