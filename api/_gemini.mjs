// 새 AI 기능 세 개(받아쓰기 · 대화 분석 · 동네 추천)가 함께 쓰는 도우미예요.
// 이름이 밑줄(_)로 시작해서 Vercel이 주소(/api/...)로 열지 않아요.
// 키는 Vercel 설정의 GEMINI_API_KEY에만 있어요. 키 값은 어디에도 적거나 남기지 않아요.
// 받은 글·녹음과 결과는 이 서버에 저장하지 않아요.

// 쓰는 모델: 메모 AI(api/ai.mjs)와 같은 모델이 기본이에요. Vercel 설정 GEMINI_MODEL로 바꿀 수 있어요.
export const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
// 녹음 받아쓰기 모델 (GEMINI_AUDIO_MODEL이 없으면 위와 같은 모델)
export const AUDIO_MODEL = process.env.GEMINI_AUDIO_MODEL || MODEL;

// 전화번호·주민등록번호·계좌번호·이메일처럼 보이는 글자를 가려요 (api/ai.mjs와 같은 규칙)
export function mask(s){
  return String(s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***')
    .replace(/\d{6}[-\s]?[1-8]\d{6}/g, '***')
    .replace(/0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}/g, '***')
    .replace(/\d(?:[-\s]?\d){9,}/g, '***');
}

// Vercel 로그에 한 줄만 남겨요 (키 값과 사용자가 보낸 글은 넣지 않아요)
export const logFail = (tag, why) => console.error(tag + ' 실패 · ' + String(why).replace(/\s+/g, ' ').slice(0, 160));

// 우리 사이트 화면에서 보낸 요청만 받아요 (다른 사이트가 우리 키로 AI를 부르지 못하게)
export function fromOurSite(req){
  const src = req.headers.origin || req.headers.referer || '';
  if(!src) return false;
  try { return new URL(src).host === req.headers.host; } catch(e) { return false; }
}

// 한 사람이 짧은 시간에 너무 많이 부르지 못하게 막아요.
// 서버가 켜져 있는 동안만 기억하는 간단한 방식이라 완벽하지는 않아요(돈이 새는 것을 줄이는 용도).
const hits = new Map();
export function tooMany(req, name, max, perMs){
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const key = name + '|' + ip, now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < perMs);
  list.push(now);
  hits.set(key, list);
  if(hits.size > 5000) hits.clear();
  return list.length > max;
}

// 요청 본문을 JSON으로 읽어요 (Vercel이 이미 읽어 둔 경우도 있어요)
export function jsonBody(req){
  let b = req.body;
  if(typeof b === 'string'){ try { b = JSON.parse(b); } catch(e) { b = null; } }
  return b && typeof b === 'object' ? b : null;
}

// 요청 본문을 그대로(바이트) 읽어요. limit보다 크면 null
export async function rawBody(req, limit){
  if(Buffer.isBuffer(req.body)) return req.body.length > limit ? null : req.body;
  const chunks = []; let size = 0;
  for await (const c of req){
    size += c.length;
    if(size > limit) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// Gemini를 불러요. schema를 주면 그 모양의 JSON으로 받아서 돌려줘요.
export async function gemini({model = MODEL, system, parts, schema, temperature = 0.2, timeout = 50000, tag = 'Gemini'}){
  const key = process.env.GEMINI_API_KEY;
  if(!key){ logFail(tag, 'GEMINI_API_KEY 없음'); throw new Error('no_key'); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const generationConfig = {temperature};
    if(schema){ generationConfig.responseMimeType = 'application/json'; generationConfig.responseSchema = schema; }
    const body = JSON.stringify({
      systemInstruction: system ? {parts: [{text: system}]} : undefined,
      contents: [{role: 'user', parts}],
      generationConfig
    });
    // Google 쪽이 잠깐 바쁠 때(500·503)는 조금 기다렸다가 두 번까지 다시 보내요 (2026-11-20 실제로 503 "high demand"를 봤어요)
    let r;
    for(let attempt = 0; ; attempt++){
      r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'x-goog-api-key': key},
        body,
        signal: ctrl.signal
      });
      if(r.ok || attempt >= 2 || (r.status !== 500 && r.status !== 503)) break;
      console.log(tag + ' 다시 보내기 · ' + r.status);
      await new Promise(ok => setTimeout(ok, 1200 * (attempt + 1)));
    }
    if(!r.ok){
      let msg = '';
      try { const e = (await r.json()).error || {}; msg = [e.status, e.message].filter(Boolean).join(': '); } catch(e) {}
      logFail(tag, r.status + (msg ? ' · ' + mask(msg).slice(0, 120) : ''));
      throw new Error('ai');
    }
    const data = await r.json();
    // "생각한 내용"(thought) 조각은 건너뛰고 진짜 답 조각만 읽어요
    const raw = (data?.candidates?.[0]?.content?.parts || [])
      .filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('');
    const u = data.usageMetadata || {};
    console.log(tag + ' 성공 · 보낸 토큰 ' + (u.promptTokenCount || 0) + ' · 받은 토큰 ' + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)));
    if(!schema) return raw;
    try { return JSON.parse(raw); } catch(e) { logFail(tag, 'JSON 아님'); throw new Error('ai'); }
  } catch(e) {
    if(e.name === 'AbortError'){ logFail(tag, '시간 초과'); throw new Error('ai'); }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 글자 길이를 자르고 앞뒤 빈칸을 지워요
export const cut = (s, n) => typeof s === 'string' ? mask(s.replace(/\*\*/g, '').trim()).slice(0, n) : '';
