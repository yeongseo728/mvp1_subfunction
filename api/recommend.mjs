// 동네 추천: 사용자가 "추천받기"를 누르면, 고른 조건과 앱이 실거래 자료로 미리 계산한 동네별 요약(후보)만
// Gemini에 보내고, 조건에 잘 맞는 동네 3곳과 이유를 돌려줘요.
// 실제 매물은 추천하지 않아요(공개된 매물 자료가 없어요). 받은 값과 결과는 이 서버에 저장하지 않아요.
import {gemini, fromOurSite, tooMany, jsonBody, cut} from './_gemini.mjs';

const MAX_CANDS = 12;

const SYSTEM = [
  '너는 서울에서 처음 자취방을 구하는 대학생·사회초년생에게 동네를 추천하는 도우미야.',
  '[조건]은 사용자가 고른 조건이고, [후보]는 국토교통부 실거래가(최근 3달)로 계산한 동네별 요약이야.',
  '후보 가운데 조건에 가장 잘 맞는 동네를 최대 3곳 골라 줘. 후보에 없는 동네는 절대 고르지 마.',
  '- key: 후보의 key를 그대로.',
  '- why: 왜 이 동네가 조건에 맞는지 2문장 이내. 예산 안 거래 수, 가운데 값, 면적, 지은 해 같은 후보 숫자를 근거로 써.',
  '- tip: 이 동네에서 방을 볼 때 확인할 점 한 문장(예: 오래된 다가구가 많으면 선순위 보증금 확인).',
  '- note: 전체에 대한 한 문장 안내(예: 예산이 빠듯하면 어떤 점을 바꿔 보라는 제안).',
  '규칙: 후보 숫자 말고 다른 시세·통계를 지어내지 마. 지하철역·학교까지 거리처럼 후보에 없는 정보는 단정하지 마.',
  '쉬운 한국어 존댓말(-요)로 짧게 써. 마크다운 기호는 쓰지 마.'
].join('\n');

const S = d => ({type: 'STRING', description: d});
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    picks: {type: 'ARRAY', items: {type: 'OBJECT', properties: {key: S('후보 key'), why: S('이유'), tip: S('확인할 점')}, required: ['key', 'why', 'tip']}},
    note: S('전체 안내 한 문장')
  },
  required: ['picks', 'note']
};

const n = (v, max) => { const x = Number(v); return Number.isFinite(x) && x >= 0 && x <= max ? Math.round(x * 10) / 10 : null; };

export default async function handler(req, res){
  if(req.method !== 'POST'){ res.setHeader('Allow', 'POST'); return res.status(405).json({error: 'method'}); }
  if(!fromOurSite(req)) return res.status(403).json({error: 'origin'});
  if(tooMany(req, 'recommend', 15, 10 * 60 * 1000)) return res.status(429).json({error: 'busy'});

  const b = jsonBody(req) || {};
  const p = b.prefs && typeof b.prefs === 'object' ? b.prefs : {};
  const prefs = {
    거래: p.deal === 'jeonse' ? '전세' : '월세',
    '보증금 최대(만 원)': n(p.depMax, 300000),
    '월세 최대(만 원)': p.deal === 'jeonse' ? null : n(p.rentMax, 1000),
    '건물 종류': cut(p.typeName, 20) || '상관없음',
    '찾는 곳': cut(p.near, 40),
    '원하는 점': (Array.isArray(p.wants) ? p.wants : []).slice(0, 6).map(w => cut(w, 20)).filter(Boolean),
    '하고 싶은 말': cut(p.note, 200)
  };
  const cands = (Array.isArray(b.cands) ? b.cands : []).slice(0, MAX_CANDS).map(c => ({
    key: cut(c && c.key, 40), 구: cut(c && c.gu, 10), 동: cut(c && c.dong, 20),
    '예산 안 거래 수': n(c && c.n, 100000), '예산 안 거래 비율(%)': n(c && c.share, 100),
    '보증금 가운데 값(만 원)': n(c && c.dep, 300000), '월세 가운데 값(만 원)': n(c && c.rent, 1000),
    '면적 가운데 값(㎡)': n(c && c.area, 1000), '지은 해 가운데 값': n(c && c.built, 2100),
    '많은 건물 종류': cut(c && c.types, 30)
  })).filter(c => c.key && c.동);
  if(!cands.length) return res.status(400).json({error: 'empty'});

  try {
    const r = await gemini({tag: '동네 추천', system: SYSTEM, schema: SCHEMA, timeout: 40000,
      parts: [{text: '[조건]\n' + JSON.stringify(prefs) + '\n\n[후보]\n' + JSON.stringify(cands)}]});
    const keys = new Set(cands.map(c => c.key)), seen = new Set();
    const picks = (Array.isArray(r.picks) ? r.picks : []).slice(0, 3)
      .map(x => ({key: String(x && x.key || '').trim(), why: cut(x && x.why, 300), tip: cut(x && x.tip, 200)}))
      .filter(x => keys.has(x.key) && !seen.has(x.key) && seen.add(x.key) && x.why);
    if(!picks.length) return res.status(502).json({error: 'ai'});
    return res.status(200).json({picks, note: cut(r.note, 240)});
  } catch(e) {
    return res.status(502).json({error: 'ai'});
  }
}
