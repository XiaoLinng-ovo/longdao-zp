const allowedHosts = new Set(['api.deepseek.com', 'api.uselunora.com', 'api.openai.com']);

function cors(origin) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-LLM-API-Key, X-LLM-Base-URL',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status, headers: cors(origin) });
}

function providerBase(request, env) {
  const candidate = (request.headers.get('X-LLM-Base-URL') || env.LLM_BASE_URL || '').trim().replace(/\/$/, '');
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'https:' && (allowedHosts.has(host) || host.endsWith('.openai.com'))) return url.toString().replace(/\/$/, '');
  } catch {}
  return '';
}


function specPrompt(job) {
  const context = {
    title: String(job?.title || '').slice(0, 120),
    department: String(job?.dept || '').slice(0, 120),
    salary: String(job?.salary || '').slice(0, 80),
    description: String(job?.desc || '').slice(0, 2400),
    requirements: Array.isArray(job?.spec?.reqs) ? job.spec.reqs.slice(0, 12) : []
  };
  return [
    '你是一名专业招聘顾问，请根据招聘需求生成岗位说明书。',
    '只返回 JSON，不要 Markdown。JSON 格式：',
    '{"focus":"","duties":[],"reqs":[],"profile":{"age":"","edu":"","exp":"","traits":[],"plus":[]}}',
    'duties 和 reqs 各返回 5-7 条中文字符串；profile 的 traits 和 plus 各返回 3 条中文字符串。',
    '岗位需求：' + JSON.stringify(context)
  ].join('\n\n');
}
function normalizeSpec(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid_spec');
  const list = (v, max) => Array.isArray(v) ? v.map(item => String(item || '').trim()).filter(Boolean).slice(0, max) : [];
  const profile = value.profile && typeof value.profile === 'object' ? value.profile : {};
  const duties = list(value.duties, 8);
  const reqs = list(value.reqs || value.requirements, 8);
  if (duties.length < 2 || reqs.length < 2) throw new Error('invalid_spec');
  return {
    focus: String(value.focus || '').trim().slice(0, 120),
    duties,
    reqs,
    profile: {
      age: String(profile.age || '').trim().slice(0, 80),
      edu: String(profile.edu || profile.education || '').trim().slice(0, 120),
      exp: String(profile.exp || profile.experience || '').trim().slice(0, 240),
      traits: list(profile.traits, 8),
      plus: list(profile.plus, 8)
    }
  };
}


function normalizeDemoResume(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid_demo_resume');
  const profile = value.profile && typeof value.profile === 'object' ? value.profile : value;
  const scoreValue = value => { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0; };
  const list = (value, max) => Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean).slice(0, max) : [];
  const dims = value.dims && typeof value.dims === 'object' ? value.dims : {};
  const name = String(profile.name || value.name || '').trim().slice(0, 60);
  if (!name) throw new Error('invalid_demo_resume');
  return {
    name,
    age: scoreValue(profile.age || value.age),
    gender: String(profile.gender || value.gender || '未填写').trim().slice(0, 20),
    edu: String(profile.edu || value.edu || '').trim().slice(0, 60),
    school: String(profile.school || value.school || '').trim().slice(0, 100),
    major: String(profile.major || value.major || '').trim().slice(0, 100),
    years: scoreValue(profile.years || value.years),
    company: String(profile.company || value.company || '').trim().slice(0, 120),
    lastTitle: String(profile.lastTitle || value.lastTitle || '').trim().slice(0, 120),
    skills: list(profile.skills || value.skills, 12),
    stability: scoreValue(profile.stability || value.stability),
    exp: String(profile.exp || value.exp || '').trim().slice(0, 800),
    dims: { hard: scoreValue(dims.hard), exp: scoreValue(dims.exp), skill: scoreValue(dims.skill), potential: scoreValue(dims.potential) },
    score: scoreValue(value.score)
  };
}
function demoResumePrompt(job) {
  return [
    '你是一名专业招聘顾问，请基于岗位需求生成一份合理的模拟候选人简历，用于招聘系统演示。',
    '候选人必须与岗位相关，但不要生成真实个人隐私或真实公司名称。',
    '只返回 JSON，不要 Markdown。JSON 格式：',
    '{"name":"","age":30,"gender":"未填写","edu":"","school":"","major":"","years":5,"company":"","lastTitle":"","skills":[],"stability":3,"exp":"","dims":{"hard":0,"exp":0,"skill":0,"potential":0},"score":0}',
    '分数为 0-100 整数，skills 返回 4-8 个中文或技术技能，exp 返回简短经历摘要。',
    '岗位需求：' + JSON.stringify({ title: job?.title, dept: job?.dept, salary: job?.salary, desc: job?.desc, spec: job?.spec || null })
  ].join('\n\n');
}

export async function onRequest(context) {
  const { request, env } = context;
  const origin = env.ALLOWED_ORIGIN || request.headers.get('Origin') || '*';
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  const path = new URL(request.url).pathname;
  const base = providerBase(request, env);
  const key = env.LLM_API_KEY || request.headers.get('X-LLM-API-Key') || '';
  const model = env.LLM_MODEL || 'deepseek-chat';
  if (path === '/api/ai/status' && request.method === 'GET') return json({ mode: key && base ? 'model' : 'default', model: key && base ? model : null }, 200, origin);
  if (path === '/api/ai/models' && request.method === 'GET') {
    if (!key || !base) return json({ mode: 'default', model: null, models: [], reason: 'not_configured' }, 200, origin);
    const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) return json({ error: 'provider_models_failed', status: response.status }, response.status, origin);
    const payload = await response.json();
    const models = Array.isArray(payload?.data) ? payload.data.map(item => item?.id).filter(Boolean).slice(0, 100) : [];
    if (!models.includes(model)) models.unshift(model);
    return json({ mode: 'model', model, models }, 200, origin);
  }

  if (path === '/api/job-spec' && request.method === 'POST') {
    if (!key || !base) return json({ mode: 'default', reason: 'not_configured' }, 200, origin);
    const payload = await request.json();
    const selectedModel = String(payload?.model || model).trim() || model;
    try {
      const response = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: '你是严谨的中文招聘岗位分析助手，输出必须是有效 JSON。' },
            { role: 'user', content: specPrompt(payload?.job || {}) }
          ]
        })
      });
      if (!response.ok) return json({ mode: 'default', reason: 'provider_unavailable', status: response.status }, 200, origin);
      const result = await response.json();
      let content = String(result?.choices?.[0]?.message?.content || '').trim();
      const fence = String.fromCharCode(96);
      content = content.split(fence).join('').trim();
      return json({ mode: 'model', model: selectedModel, spec: normalizeSpec(JSON.parse(content)) }, 200, origin);
    } catch {
      return json({ mode: 'default', reason: 'invalid_model_response' }, 200, origin);
    }
  }


  if (path === '/api/demo-resume' && request.method === 'POST') {
    if (!key || !base) return json({ mode: 'default', reason: 'not_configured' }, 200, origin);
    const payload = await request.json();
    const selectedModel = String(payload?.model || model).trim() || model;
    try {
      const response = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          temperature: 0.7,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: '你是严谨的中文招聘模拟简历生成助手，输出必须是有效 JSON。' },
            { role: 'user', content: demoResumePrompt(payload?.job || {}) }
          ]
        })
      });
      if (!response.ok) return json({ mode: 'default', reason: 'provider_unavailable', status: response.status }, 200, origin);
      const result = await response.json();
      let content = String(result?.choices?.[0]?.message?.content || '').trim();
      const fence = String.fromCharCode(96);
      content = content.split(fence).join('').trim();
      return json({ mode: 'model', model: selectedModel, resume: normalizeDemoResume(JSON.parse(content)) }, 200, origin);
    } catch {
      return json({ mode: 'default', reason: 'invalid_model_response' }, 200, origin);
    }
  }

  if (path === '/api/resume-analysis' && request.method === 'POST') {
    if (!key || !base) return json({ mode: 'default', reason: 'not_configured' }, 200, origin);
    const payload = await request.json();
    const resumeText = String(payload?.resumeText || '').trim().slice(0, 24000);
    if (!resumeText) return json({ error: 'resumeText is required' }, 400, origin);
    const selectedModel = String(payload?.model || model).trim() || model;
    const prompt = ['你是一名专业招聘顾问。仅基于提供的信息评估候选人与岗位的匹配度。请只返回 JSON，不要 Markdown。JSON 格式：', '{"dims":{"hard":0,"exp":0,"skill":0,"potential":0},"score":0,"summary":"","strengths":[],"risks":[],"interviewQuestions":[],"skills":[],"profile":{"education":"","years":0,"company":"","lastTitle":""}}', '所有分数为 0-100 整数，数组内容使用中文。岗位信息：' + JSON.stringify(payload?.job || {}), '候选人简历文本：' + resumeText].join('\n\n');
    const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: selectedModel, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: '你是严谨的中文招聘评估助手，输出必须是有效 JSON。' }, { role: 'user', content: prompt }] }) });
    if (!response.ok) return json({ mode: 'default', reason: 'provider_unavailable', status: response.status }, 200, origin);
    const result = await response.json();
    let content = String(result?.choices?.[0]?.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return json({ mode: 'model', model: selectedModel, analysis: JSON.parse(content) }, 200, origin); } catch { return json({ mode: 'default', reason: 'invalid_model_response' }, 200, origin); }
  }
  return json({ error: 'Not Found' }, 404, origin);
}
