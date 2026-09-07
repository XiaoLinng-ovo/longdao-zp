const STATE_KEY = 'smartrecruit-state';
const MAX_BODY_BYTES = 3 * 1024 * 1024;

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get('Origin') || '';
  const configuredOrigin = String(env.ALLOWED_ORIGIN || '').trim();
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': configuredOrigin || requestOrigin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS'
  };
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(request, env)
  });
}

function migrateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
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
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Array.isArray(value.jobs) && Array.isArray(value.cands) &&
    value.forms && typeof value.forms === 'object' && !Array.isArray(value.forms) &&
    value.scores && typeof value.scores === 'object' && !Array.isArray(value.scores) &&
    Array.isArray(value.interviews) &&
    value.offers && typeof value.offers === 'object' && !Array.isArray(value.offers) &&
    Array.isArray(value.chatLog);
}

async function readBody(request) {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    const error = new Error('Request body too large');
    error.status = 413;
    throw error;
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    const error = new Error('Request body too large');
    error.status = 413;
    throw error;
  }
  return text;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });

  const store = env.STATE_KV;
  if (!store) return json({ error: 'state_storage_not_configured' }, 500, request, env);

  if (request.method === 'GET') {
    const raw = await store.get(STATE_KEY);
    if (!raw) return json({ error: 'state_not_initialized' }, 404, request, env);
    try {
      const state = migrateState(JSON.parse(raw));
      if (!isValidState(state)) return json({ error: 'invalid_saved_state' }, 500, request, env);
      return json(state, 200, request, env);
    } catch {
      return json({ error: 'invalid_saved_state' }, 500, request, env);
    }
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    let state;
    try {
      state = migrateState(JSON.parse(await readBody(request)));
    } catch (error) {
      return json({ error: error.status === 413 ? error.message : 'invalid_json' }, error.status || 400, request, env);
    }
    if (!isValidState(state)) return json({ error: 'invalid_state_payload' }, 400, request, env);
    await store.put(STATE_KEY, JSON.stringify(state));
    return json({ ok: true, savedAt: new Date().toISOString() }, 200, request, env);
  }

  return json({ error: 'method_not_allowed' }, 405, request, env);
}
