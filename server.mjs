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
const MAX_BODY_BYTES = 3 * 1024 * 1024;

const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
let stateWriteQueue = Promise.resolve();

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
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (CORS_ORIGIN) res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
      return res.end();
    }

    if (url.pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, service: 'smartrecruit-pro', timestamp: new Date().toISOString() });
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
