// 계약 케어 알림 (2026-11-28 사용자와 정함, F단계 ①)
// GET  /api/push                      → 알림 받을 때 쓰는 공개 열쇠(VAPID 공개 키)를 돌려줘요.
// POST /api/push {action:'test', sub} → 그 알림 주소로 테스트 알림을 한 번 보내요.
// 키는 Vercel 설정 VAPID_PUBLIC_KEY·VAPID_PRIVATE_KEY(·VAPID_SUBJECT)에만 있어요. 이 단계에서는 받은 주소를 저장하지 않아요.
// 매일 아침 자동 알림(주소·날짜 목록 저장)은 F단계 ②에서 더해요.
import webpush from 'web-push';
import { fromOurSite, tooMany, jsonBody, logFail } from './_gemini.mjs';

const PUB = (process.env.VAPID_PUBLIC_KEY || '').trim();
const PRIV = (process.env.VAPID_PRIVATE_KEY || '').trim();
const SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:zipkokcheck@gmail.com').trim();

// 휴대폰·브라우저 회사의 알림 서버 주소만 받아요(다른 곳으로 요청을 보내게 하지 못하게)
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/, /^android\.googleapis\.com$/];
function okSub(s){
  if(!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1000 || !s.keys) return false;
  if(typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string' || s.keys.p256dh.length > 200 || s.keys.auth.length > 100) return false;
  try { const u = new URL(s.endpoint); return u.protocol === 'https:' && PUSH_HOSTS.some(r => r.test(u.hostname)); } catch(e) { return false; }
}

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  if(req.method === 'GET') return PUB ? res.status(200).json({key: PUB}) : res.status(503).json({error: 'no_key'});
  if(req.method !== 'POST'){ res.setHeader('Allow', 'GET, POST'); return res.status(405).json({error: 'method'}); }
  if(!fromOurSite(req)) return res.status(403).json({error: 'origin'});
  if(tooMany(req, 'push', 20, 10 * 60 * 1000)) return res.status(429).json({error: 'busy'});
  if(!PUB || !PRIV){ logFail('알림', 'VAPID 키 없음'); return res.status(503).json({error: 'no_key'}); }
  const b = jsonBody(req);
  if(!b || !okSub(b.sub)) return res.status(400).json({error: 'input'});
  if(b.action === 'test'){
    try {
      webpush.setVapidDetails(SUBJECT, PUB, PRIV);
      await webpush.sendNotification(
        {endpoint: b.sub.endpoint, keys: {p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth}},
        JSON.stringify({title: '집콕체크', body: '알림이 잘 와요. 할 일 전날과 당일 아침에 알려 드릴게요.', url: '/', tag: 'test'}),
        {TTL: 3600}
      );
      return res.status(200).json({ok: true});
    } catch(e) {
      logFail('알림 테스트', e && (e.statusCode || e.message));
      return res.status(502).json({error: 'send', code: (e && e.statusCode) || 0});
    }
  }
  return res.status(400).json({error: 'action'});
}
