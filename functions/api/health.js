function headers(request, env) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || request.headers.get('Origin') || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
}

export function onRequest({ request, env }) {
  const responseHeaders = headers(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: responseHeaders });
  return new Response(JSON.stringify({ ok: true, service: 'smartrecruit-pro-pages', timestamp: new Date().toISOString() }), {
    status: 200,
    headers: responseHeaders
  });
}
