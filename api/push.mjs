// 계약 케어 알림 (2026-11-28 사용자와 정함, F단계 ①②)
// GET  /api/push                       → 알림 받을 때 쓰는 공개 열쇠(VAPID 공개 키)를 돌려줘요.
// POST /api/push {action:'sync', sub, items} → 알림 주소와 날짜·종류 목록을 저장해요(Upstash Redis). items = [{d:'2026-12-05', k:'rent'}]
// POST /api/push {action:'off', sub}         → 그 알림 주소의 기록을 지워요.
// POST /api/push {action:'now', sub, items}  → 오늘·내일 할 일 알림을 지금 한 번 보내 봐요(없으면 "알림이 잘 와요").
// 저장하는 것은 알림 주소와 날짜·종류뿐이에요. 집 이름·금액·메모·사진·내가 쓴 일정 제목은 받지도 저장하지도 않아요.
// 키: Vercel 설정 VAPID_PUBLIC_KEY·VAPID_PRIVATE_KEY(·VAPID_SUBJECT), 저장소는 Vercel이 넣어 준 KV_REST_API_URL·KV_REST_API_TOKEN
// (또는 UPSTASH_REDIS_REST_URL·UPSTASH_REDIS_REST_TOKEN). 매일 아침 보내기는 api/push-cron.mjs.
import webpush from 'web-push';
import crypto from 'node:crypto';
import { fromOurSite, tooMany, jsonBody, logFail } from './_gemini.mjs';

const PUB = (process.env.VAPID_PUBLIC_KEY || '').trim();
const PRIV = (process.env.VAPID_PRIVATE_KEY || '').trim();
const SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:zipkokcheck@gmail.com').trim();
const RURL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/$/, '');
const RTOK = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const KEEP_DAYS = 400; // 앱을 오래 안 열면 저절로 지워져요

// 알림 종류 이름 (앱 index.html의 자동 일정 id와 같아야 해요)
export const KNAME = {reg:'등기부 다시 떼기', movein:'전입신고', fixdate:'확정일자 받기', report:'전월세 신고', photo:'입주 사진 찍기',
  renew:'재계약할지 생각하기', notice3:'나갈지 미리 알리기', notice2:'나갈지 알리기 마감', end:'계약 끝나는 날', rent:'월세 내는 날', fee:'관리비 내는 날', own:'내 일정'};

// Upstash Redis REST: 명령 하나를 보내요
export async function redis(cmd){
  if(!RURL || !RTOK) throw new Error('no_redis');
  const r = await fetch(RURL, {method:'POST', headers:{Authorization:'Bearer ' + RTOK, 'Content-Type':'application/json'}, body:JSON.stringify(cmd)});
  const j = await r.json().catch(()=>({error:'bad_json'}));
  if(!r.ok || j.error) throw new Error('redis ' + (j.error || r.status));
  return j.result;
}
export const idOf = sub => crypto.createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 32);

// 휴대폰·브라우저 회사의 알림 서버 주소만 받아요(다른 곳으로 요청을 보내게 하지 못하게)
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/, /^android\.googleapis\.com$/];
export function okSub(s){
  if(!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1000 || !s.keys) return false;
  if(typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string' || s.keys.p256dh.length > 200 || s.keys.auth.length > 100) return false;
  try { const u = new URL(s.endpoint); return u.protocol === 'https:' && PUSH_HOSTS.some(r => r.test(u.hostname)); } catch(e) { return false; }
}
const cleanSub = s => ({endpoint: s.endpoint, keys: {p256dh: s.keys.p256dh, auth: s.keys.auth}});
function cleanItems(list){
  if(!Array.isArray(list)) return null;
  const out = [];
  for(const x of list.slice(0, 300)){
    if(!x || typeof x.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.d) || !KNAME[x.k]) continue;
    out.push({d: x.d, k: x.k});
  }
  return out;
}

// 한국 날짜 'YYYY-MM-DD' (오늘, 내일)
export function kstDays(){
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return {today: now.toISOString().slice(0, 10), tomorrow: new Date(now.getTime() + 864e5).toISOString().slice(0, 10), hour: now.getUTCHours()};
}
// 오늘·내일 할 일 한 통으로 묶기 (없으면 null)
export function digest(items, today, tomorrow){
  const names = d => [...new Set(items.filter(x => x.d === d).map(x => KNAME[x.k]))];
  const t = names(today), m = names(tomorrow);
  if(!t.length && !m.length) return null;
  return {title: '집콕체크 · 할 일 알림', body: [t.length ? '오늘: ' + t.join(' · ') : '', m.length ? '내일: ' + m.join(' · ') : ''].filter(Boolean).join('\n'), url: '/', tag: 'care-' + today};
}
// 알림 한 통 보내기. 주소가 없어졌으면 'gone'
export async function sendPush(sub, payload){
  webpush.setVapidDetails(SUBJECT, PUB, PRIV);
  try { await webpush.sendNotification(cleanSub(sub), JSON.stringify(payload), {TTL: 6 * 3600}); return 'ok'; }
  catch(e) { if(e && (e.statusCode === 404 || e.statusCode === 410)) return 'gone'; logFail('알림 보내기', e && (e.statusCode || e.message)); return 'fail'; }
}
export const pushReady = () => !!(PUB && PRIV);

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  if(req.method === 'GET') return PUB ? res.status(200).json({key: PUB, store: !!(RURL && RTOK)}) : res.status(503).json({error: 'no_key'});
  if(req.method !== 'POST'){ res.setHeader('Allow', 'GET, POST'); return res.status(405).json({error: 'method'}); }
  if(!fromOurSite(req)) return res.status(403).json({error: 'origin'});
  if(tooMany(req, 'push', 60, 10 * 60 * 1000)) return res.status(429).json({error: 'busy'});
  if(!pushReady()){ logFail('알림', 'VAPID 키 없음'); return res.status(503).json({error: 'no_key'}); }
  const b = jsonBody(req);
  if(!b || !okSub(b.sub)) return res.status(400).json({error: 'input'});
  const id = idOf(b.sub);
  try {
    if(b.action === 'sync'){
      const items = cleanItems(b.items); if(!items) return res.status(400).json({error: 'input'});
      await redis(['SET', 'push:' + id, JSON.stringify({sub: cleanSub(b.sub), items}), 'EX', String(KEEP_DAYS * 86400)]);
      await redis(['SADD', 'push:all', id]);
      return res.status(200).json({ok: true, n: items.length});
    }
    if(b.action === 'off'){
      await redis(['DEL', 'push:' + id]);
      await redis(['SREM', 'push:all', id]);
      return res.status(200).json({ok: true});
    }
    if(b.action === 'now' || b.action === 'test'){
      const {today, tomorrow} = kstDays();
      const d = digest(cleanItems(b.items) || [], today, tomorrow) || {title: '집콕체크', body: '알림이 잘 와요. 할 일 전날과 당일 아침에 알려 드릴게요.', url: '/', tag: 'test'};
      const r = await sendPush(b.sub, d);
      return r === 'ok' ? res.status(200).json({ok: true, digest: d.tag !== 'test'}) : res.status(502).json({error: 'send'});
    }
  } catch(e) {
    logFail('알림 저장', e && e.message);
    return res.status(503).json({error: String(e && e.message).startsWith('no_redis') ? 'no_store' : 'store'});
  }
  return res.status(400).json({error: 'action'});
}
