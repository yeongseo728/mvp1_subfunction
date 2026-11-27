// 계약 케어 매일 아침 알림 (2026-11-28 사용자와 정함, F단계 ②)
// vercel.json의 crons가 매일 세계 표준시 0시(한국 시간 아침 9시쯤, 무료 요금제는 9~10시 사이)에 이 주소를 불러요.
// 저장된 알림 주소마다 오늘·내일 할 일이 있으면 한 통으로 묶어 보내요(전날 + 당일).
// 같은 날 두 번 보내지 않게 'sent:주소id:날짜'를 하루 남짓 기억해요. 그래서 누가 이 주소를 여러 번 불러도 알림이 쏟아지지 않아요.
// 한국 시간 아침 7~12시에만 보내요(밤에 알림이 가지 않게). 없어진 알림 주소(404·410)는 지워요.
import { redis, digest, sendPush, kstDays, pushReady } from './push.mjs';
import { logFail } from './_gemini.mjs';

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  const {today, tomorrow, hour} = kstDays();
  if(hour < 7 || hour >= 12) return res.status(200).json({ok: true, skipped: 'hour', hour});
  if(!pushReady()) return res.status(503).json({error: 'no_key'});
  let ids;
  try { ids = (await redis(['SMEMBERS', 'push:all'])) || []; } catch(e) { return res.status(503).json({error: 'no_store'}); }
  let sent = 0, none = 0, gone = 0, fail = 0;
  for(const id of ids){
    try {
      const raw = await redis(['GET', 'push:' + id]);
      if(!raw){ await redis(['SREM', 'push:all', id]); continue; }
      const v = JSON.parse(raw);
      const d = digest(v.items || [], today, tomorrow);
      if(!d){ none++; continue; }
      const first = await redis(['SET', 'sent:' + id + ':' + today, '1', 'NX', 'EX', '129600']);
      if(first !== 'OK') continue;
      const r = await sendPush(v.sub, d);
      if(r === 'ok') sent++;
      else if(r === 'gone'){ gone++; await redis(['DEL', 'push:' + id]); await redis(['SREM', 'push:all', id]); }
      else fail++;
    } catch(e) { fail++; logFail('매일 알림', e && e.message); }
  }
  return res.status(200).json({ok: true, today, people: ids.length, sent, none, gone, fail});
}
