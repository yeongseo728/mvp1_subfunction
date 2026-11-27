// 동네 전월세 시세: 국토교통부 전월세 실거래가(공공데이터포털)를 받아 data/rent/구코드.json 으로 저장해요.
// GitHub Actions(.github/workflows/rent.yml)가 매일 한 번 돌려요. 국토교통부 실거래가는 이 파일에서만 불러요.
// 보내는 값은 인증키, 구 코드, 몇 년 몇 월, 쪽 번호뿐이에요. 사용자 답·메모·금액은 쓰지 않아요.
// 키는 GitHub 저장소 설정(Secrets)의 RENT_KEY에만 있어요. 키 값과 키가 든 주소는 어디에도 남기지 않아요.
//
// 저장 모양: {code, gu, updated, from, to, items:[[종류, 동, 면적㎡, 층, 지은 해, 보증금(만 원), 월세(만 원, 전세는 0), 계약일, 신규·갱신]]}
// 종류: sh 단독·다가구, rh 빌라(연립·다세대), offi 오피스텔, apt 아파트

import { mkdir, writeFile, rename } from 'node:fs/promises';

// 예전 저장소에서 쓰던 이름(MOLIT_KEY)도 읽어요 (2026-11-20)
const KEY = (process.env.RENT_KEY || process.env.MOLIT_KEY || '').trim();
const BASE = process.env.RENT_API_BASE || 'https://apis.data.go.kr/1613000'; // 시험할 때만 바꿔요
const OUT = 'data/rent';
const MONTHS = 3;        // 최근 3달
const ROWS = 1000;       // 한 번에 받는 줄 수
const PARALLEL = 4;      // 동시에 묻는 수

const SEOUL_GU = [['11110','종로구'],['11140','중구'],['11170','용산구'],['11200','성동구'],['11215','광진구'],['11230','동대문구'],['11260','중랑구'],['11290','성북구'],['11305','강북구'],['11320','도봉구'],['11350','노원구'],['11380','은평구'],['11410','서대문구'],['11440','마포구'],['11470','양천구'],['11500','강서구'],['11530','구로구'],['11545','금천구'],['11560','영등포구'],['11590','동작구'],['11620','관악구'],['11650','서초구'],['11680','강남구'],['11710','송파구'],['11740','강동구']];
const ALL_TYPES = [
  ['sh', 'RTMSDataSvcSHRent/getRTMSDataSvcSHRent'],
  ['rh', 'RTMSDataSvcRHRent/getRTMSDataSvcRHRent'],
  ['offi', 'RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent'],
  ['apt', 'RTMSDataSvcAptRent/getRTMSDataSvcAptRent']
];
// 활용신청한 자료만 받을 수 있게 RENT_TYPES(예: sh,rh,offi)로 고를 수 있어요. 없으면 4가지 모두 받아요
const PICK = (process.env.RENT_TYPES || '').split(',').map(t=>t.trim()).filter(Boolean);
const TYPES = PICK.length ? ALL_TYPES.filter(t=>PICK.includes(t[0])) : ALL_TYPES;

if(!KEY){ console.error('RENT_KEY가 없어요. GitHub 저장소 설정(Secrets)에 인증키를 넣어 주세요.'); process.exit(1); }

// 한국 시간 기준 오늘과 최근 3달(이번 달 포함)
const now = new Date(Date.now() + 9 * 3600 * 1000);
const today = now.toISOString().slice(0, 10);
const months = [];
for(let i = MONTHS - 1; i >= 0; i--){
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
  months.push(d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0'));
}

// 공공데이터포털 키는 이미 바뀐 모양(%가 든 Encoding 키)일 수도 있어서 두 번 바꾸지 않아요
const keyParam = KEY.includes('%') ? KEY : encodeURIComponent(KEY);

// ---------- XML 읽기 (외부 라이브러리 없이) ----------
const unxml = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>')); return m ? unxml(m[1]) : ''; };
// 항목 이름이 바뀌어도 읽을 수 있게 새 이름(영문)과 예전 이름(한글)을 함께 봐요
const pick = (xml, names) => { for(const n of names){ const v = tag(xml, n); if(v !== '') return v; } return ''; };
const num = s => { const v = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return Number.isFinite(v) ? v : null; };

function shape(type, it){
  const dong = pick(it, ['umdNm', '법정동']);
  const area = num(pick(it, type === 'sh' ? ['totalFloorAr', '계약면적', 'excluUseAr'] : ['excluUseAr', '전용면적']));
  const floor = type === 'sh' ? null : num(pick(it, ['floor', '층']));
  const built = num(pick(it, ['buildYear', '건축년도']));
  const deposit = num(pick(it, ['deposit', '보증금액', '보증금']));
  const rent = num(pick(it, ['monthlyRent', '월세금액', '월세'])) || 0;
  const y = pick(it, ['dealYear', '년']), m = pick(it, ['dealMonth', '월']), d = pick(it, ['dealDay', '일']);
  const kind = pick(it, ['contractType', '계약구분']);
  if(!dong || deposit == null || !y || !m || !d) return null;
  const date = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  return [type, dong, area == null ? 0 : Math.round(area * 100) / 100, floor, built, deposit, rent, date, kind === '신규' || kind === '갱신' ? kind : ''];
}

// 키가 틀렸거나 막히면 더 묻지 않고 바로 멈춰요 (공공데이터포털 오류 코드 20·22·30·31·32)
const FATAL = /SERVICE_KEY|SERVICE_ACCESS_DENIED|LIMITED_NUMBER|DEADLINE_HAS_EXPIRED|UNREGISTERED_IP/i;
let stopAll = '';
class Fatal extends Error {}

async function ask(path, code, ym, page){
  if(stopAll) throw new Fatal(stopAll);
  const url = BASE + '/' + path + '?serviceKey=' + keyParam + '&LAWD_CD=' + code + '&DEAL_YMD=' + ym + '&pageNo=' + page + '&numOfRows=' + ROWS;
  for(let tryNo = 1; tryNo <= 3; tryNo++){
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(30000)});
      const xml = await r.text();
      if(!r.ok) throw new Error('응답 ' + r.status);
      const auth = tag(xml, 'returnAuthMsg') + ' ' + tag(xml, 'resultMsg');
      if(FATAL.test(auth) || /^(20|22|30|31|32)$/.test(tag(xml, 'resultCode')) || /^(20|22|30|31|32)$/.test(tag(xml, 'returnReasonCode'))) throw new Fatal('인증키 문제 · ' + auth.trim().slice(0, 80));
      const rc = tag(xml, 'resultCode');
      if(rc && rc !== '00' && rc !== '000') throw new Error('결과 코드 ' + rc + ' ' + tag(xml, 'resultMsg').slice(0, 60));
      return {items: [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>m[1]), total: num(tag(xml, 'totalCount')) || 0};
    } catch(e){
      if(e instanceof Fatal){ stopAll = stopAll || e.message; throw e; }
      // 주소에 키가 들어 있어서 주소는 남기지 않아요
      if(tryNo === 3) throw new Error(String(e.message || e).replace(KEY, '***').replace(keyParam, '***'));
      await new Promise(res=>setTimeout(res, 1500 * tryNo));
    }
  }
}

async function oneGu([code, gu]){
  const items = []; let ok = 0, bad = 0;
  for(const [type, path] of TYPES){
    for(const ym of months){
      try {
        let page = 1, got = 0, total = 0;
        do {
          const r = await ask(path, code, ym, page);
          total = r.total; got += r.items.length;
          r.items.forEach(it=>{ const x = shape(type, it); if(x) items.push(x); });
          page++;
          if(!r.items.length) break;
        } while(got < total && page <= 20);
        ok++;
      } catch(e){ bad++; if(!(e instanceof Fatal)) console.error(gu + ' ' + type + ' ' + ym + ' 실패: ' + e.message); }
    }
  }
  return {code, gu, items, ok, bad};
}

const results = [];
for(let i = 0; i < SEOUL_GU.length; i += PARALLEL){
  results.push(...await Promise.all(SEOUL_GU.slice(i, i + PARALLEL).map(oneGu)));
}

if(stopAll){ console.error('멈췄어요: ' + stopAll + '. 파일은 바꾸지 않았어요. 인증키와 활용신청 승인을 확인해 주세요.'); process.exit(1); }
const asked = results.reduce((s, r)=>s + r.ok + r.bad, 0), failed = results.reduce((s, r)=>s + r.bad, 0);
// 절반 넘게 실패하면(키 문제·접속 막힘 등) 예전 파일을 그대로 두고 멈춰요
if(failed * 2 > asked){ console.error('요청 ' + asked + '번 중 ' + failed + '번 실패해서 파일을 바꾸지 않았어요.'); process.exit(1); }

await mkdir(OUT, {recursive: true});
const from = months[0].slice(0, 4) + '-' + months[0].slice(4) + '-01';
let saved = 0;
for(const r of results){
  if(r.bad && !r.items.length){ console.error(r.gu + ': 자료를 못 받아서 예전 파일을 그대로 둬요.'); continue; }
  const items = r.items.filter(x=>x[7] >= from && x[7] <= today).sort((a, b)=>b[7].localeCompare(a[7]));
  const body = JSON.stringify({code: r.code, gu: r.gu, updated: today, from, to: today, items});
  const file = OUT + '/' + r.code + '.json';
  await writeFile(file + '.tmp', body);
  await rename(file + '.tmp', file);
  saved++;
  console.log(r.gu + ': ' + items.length + '건' + (r.bad ? ' (일부 실패 ' + r.bad + '번)' : ''));
}
console.log('저장 ' + saved + '개 구 · 요청 ' + asked + '번 중 실패 ' + failed + '번 · ' + months.join(', '));
