const json = (payload, status = 200, origin = '*') => new Response(JSON.stringify(payload), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, X-LLM-API-Key, X-LLM-Base-URL',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  }
});

function corsOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  return env.ALLOWED_ORIGIN || origin || '*';
}

function providerConfig(request, env) {
  const key = env.LLM_API_KEY || request.headers.get('X-LLM-API-Key') || '';
  const requestedBase = (request.headers.get('X-LLM-Base-URL') || '').trim().replace(/\/$/, '');
  let base = (env.LLM_BASE_URL || '').replace(/\/$/, '');
  if (requestedBase) {
    try {
      const parsed = new URL(requestedBase);
      const host = parsed.hostname.toLowerCase();
      const allowed = parsed.protocol === 'https:' && (host === 'api.deepseek.com' || host === 'api.uselunora.com' || host === 'api.openai.com' || host.endsWith('.openai.com'));
      if (allowed) base = parsed.toString().replace(/\/$/, '');
    } catch {}
  }
  const model = env.LLM_MODEL || 'deepseek-chat';
  return { key, base, model };
}

export default {
  async fetch(request, env) {
    const origin = corsOrigin(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, X-LLM-API-Key, X-LLM-Base-URL', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
    const url = new URL(request.url);
    const { key, base, model } = providerConfig(request, env);
    if (url.pathname === '/api/health') return json({ ok: true, service: 'smartrecruit-ai-proxy' }, 200, origin);
    if (url.pathname === '/api/ai/status') return json({ mode: key && base ? 'model' : 'default', model: key && base ? model : null }, 200, origin);
    if (url.pathname === '/api/ai/models' && request.method === 'GET') {
      if (!key || !base) return json({ mode: 'default', model: null, models: [], reason: 'not_configured' }, 200, origin);
      const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
      if (!response.ok) return json({ error: 'provider_models_failed', status: response.status }, response.status, origin);
      const payload = await response.json();
      const models = Array.isArray(payload?.data) ? payload.data.map(item => item?.id).filter(Boolean).slice(0, 100) : [];
      if (!models.includes(model)) models.unshift(model);
      return json({ mode: 'model', model, models }, 200, origin);
    }
    if (url.pathname === '/api/resume-analysis' && request.method === 'POST') {
      if (!key || !base) return json({ mode: 'default', reason: 'not_configured' }, 200, origin);
      const payload = await request.json();
      const resumeText = String(payload?.resumeText || '').trim().slice(0, 24000);
      if (!resumeText) return json({ error: 'resumeText is required' }, 400, origin);
      const selectedModel = String(payload?.model || model).trim() || model;
      const job = payload?.job || {};
      const prompt = ['你是一名专业招聘顾问。仅基于提供的信息评估候选人与岗位的匹配度。请只返回 JSON，不要 Markdown。JSON 格式：', '{"dims":{"hard":0,"exp":0,"skill":0,"potential":0},"score":0,"summary":"","strengths":[],"risks":[],"interviewQuestions":[],"skills":[],"profile":{"education":"","years":0,"company":"","lastTitle":""}}', '所有分数为 0-100 整数，数组内容使用中文。岗位信息：' + JSON.stringify(job), '候选人简历文本：' + resumeText].join('\n\n');
      const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: selectedModel, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: '你是严谨的中文招聘评估助手，输出必须是有效 JSON。' }, { role: 'user', content: prompt }] }) });
      if (!response.ok) return json({ mode: 'default', reason: 'provider_unavailable', status: response.status }, 200, origin);
      const result = await response.json();
      let content = String(result?.choices?.[0]?.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      try { return json({ mode: 'model', model: selectedModel, analysis: JSON.parse(content) }, 200, origin); } catch { return json({ mode: 'default', reason: 'invalid_model_response' }, 200, origin); }
    }
    return json({ error: 'Not Found' }, 404, origin);
  }
};
