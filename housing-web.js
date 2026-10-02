import express from "express";
import { createHash, createHmac, scryptSync, timingSafeEqual, randomBytes } from "node:crypto";
import { LAWD_CODES } from "./lawd-codes.js";
import { monthsBefore } from "./lib.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const regions = LAWD_CODES.filter(r => /^(서울특별시|경기도) /.test(r.name));
const regionChoices = [
  {code:"SEOUL_ALL",name:"서울 전체"},
  ...regions.filter(r => r.name.startsWith("서울특별시 ")),
  {code:"GYEONGGI_ALL",name:"경기 전체"},
  ...regions.filter(r => r.name.startsWith("경기도 "))
];
const allRegionGroups = {
  SEOUL_ALL: regions.filter(r => r.name.startsWith("서울특별시 ")),
  GYEONGGI_ALL: regions.filter(r => r.name.startsWith("경기도 ")).filter(r => !regions.some(child => child.code !== r.code && child.name.startsWith(r.name + " ")))
};
const css = `*{box-sizing:border-box}body{margin:0;background:#f5f4ef;color:#163c39;font:16px/1.6 system-ui,sans-serif}a{color:#176b5b}header{background:#143e38;color:#fff;padding:20px max(24px,calc((100vw - 1160px)/2));display:flex;align-items:center;justify-content:space-between;gap:16px}header a{color:#fff;text-decoration:none;font-weight:750}header small{color:#c2d7cd}main{max-width:1208px;margin:auto;padding:42px 24px 70px}.eyebrow{font-size:12px;letter-spacing:2px;color:#607b70;font-weight:750}h1{font-size:clamp(28px,4vw,44px);line-height:1.25;letter-spacing:-1.5px;margin:12px 0}h2{font-size:21px;margin:0 0 16px}.sub{color:#66746c;max-width:680px}.chips{display:flex;flex-wrap:wrap;gap:8px;margin:24px 0}.chip{border:1px solid #d0dbd0;border-radius:30px;padding:6px 15px;font-size:14px;background:#fff}.layout{display:grid;grid-template-columns:320px 1fr;gap:24px;align-items:start}.card{background:#fff;border:1px solid #e0e5db;border-radius:20px;padding:24px;box-shadow:0 6px 22px #29443805}.filters label{display:block;margin:14px 0 5px;font-size:14px;font-weight:650}input,select{width:100%;border:1px solid #ccd6cc;border-radius:9px;background:white;padding:11px;font:inherit;color:#193c35}.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}button{cursor:pointer;font:inherit;font-weight:700;border:0;border-radius:10px;padding:12px 18px;background:#176b5b;color:white}.primary{width:100%;margin-top:22px}button:hover{background:#125747}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid #d6a958;outline-offset:3px}.logout{background:transparent;border:1px solid #72958b;padding:6px 12px;font-size:13px}.note{font-size:13px;color:#6b796e;margin:14px 0 0}.empty{text-align:center;padding:60px 18px;color:#687b6e}.empty b{display:block;font-size:23px;color:#284e41;margin:12px 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:14px}th{text-align:left;color:#64796b;font-size:12px;border-bottom:2px solid #e3e9df;padding:12px 10px}td{padding:16px 10px;border-bottom:1px solid #edf0e9}td:first-child{white-space:normal;min-width:145px}td strong{display:block}td small{color:#6a7b71}.price{font-weight:750;color:#176b5b}.status{padding:12px 16px;border-radius:10px;background:#f0f5ed;color:#45684d;font-size:14px;margin-bottom:20px}.error{background:#fff0e9;color:#8b3627;padding:14px;border-radius:10px;margin-bottom:18px}.login{max-width:460px;margin:40px auto}.login .card{padding:32px}.foot{margin-top:24px;border-top:1px solid #dce3d7;padding-top:20px;font-size:13px;color:#718072}.foot a{margin-right:18px}@media(max-width:800px){.layout{grid-template-columns:1fr}main{padding-top:28px}.card{padding:20px}header small{display:none}h1{letter-spacing:-1px}}`;
const shell = (body, logged = false) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>집의 기준 · 서울·경기 아파트 실거래가</title><style>${css}</style></head><body><header><a href="/housing">집의 기준 <small>SEOUL · GYEONGGI</small></a>${logged ? '<form method="post" action="/housing/logout"><button class="logout">로그아웃</button></form>' : '<small>나만의 아파트 실거래가 조회</small>'}</header><main>${body}<footer class="foot">자료: 국토교통부 아파트 매매 실거래가 · 실시간 매물 호가와 다릅니다.<br>최근 거래는 신고·정정으로 달라질 수 있습니다. <a href="https://www.data.go.kr/data/15126468/openapi.do" target="_blank" rel="noopener noreferrer">데이터 출처</a></footer></main></body></html>`;
const loginPage = error => shell(`<div class="login"><div class="eyebrow">YOUR PRIVATE HOME SEARCH</div><h1>내 집 찾기,<br>나의 기준으로.</h1><p class="sub">ChatGPT 계정 없이 사용하세요.<br>설정하신 개인 비밀번호로 조회 화면에 들어갑니다.</p><section class="card">${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}<form method="post" action="/housing/login"><label for="password">개인 비밀번호</label><input id="password" name="password" type="password" required autocomplete="current-password" maxlength="256"><button class="primary">조회 화면 열기</button></form><p class="note">공공데이터 인증키는 입력하지 않습니다.</p></section></div>`);
const currentMonth = () => new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Seoul", year:"numeric", month:"2-digit"}).format(new Date()).replace(/[^0-9]/g, "");
const defaults = () => ({region:"11620", month:monthsBefore(currentMonth(), 1), months:1, min:9, max:11, area:84, name:"", dong:""});
const money = n => `${(n / 10000).toLocaleString("ko-KR", {maximumFractionDigits:4})}억원`;
function searchPage(values = defaults(), result, error) {
  const options = regionChoices.map(r => `<option value="${r.code}" ${r.code === values.region ? 'selected' : ''}>${esc(r.name.replace('서울특별시 ', '서울 ').replace('경기도 ', '경기 '))}</option>`).join('');
  const output = result ? `<div class="status" role="status">조건에 맞는 거래 <strong>${result.rows.length.toLocaleString()}건</strong> · ${esc(result.period)}<br>공공데이터 새 조회 ${result.calls}회 · 저장된 자료 ${result.cached}개월 사용${result.truncated ? '<br>거래가 많은 월은 최대 5,000건까지 확인했습니다. 전체를 확인하려면 다른 기간으로 나눠 조회하세요.' : ''}</div>${result.rows.length ? `<div class="table-wrap"><table><thead><tr><th>아파트 / 동</th><th>매매가</th><th>전용면적</th><th>층 / 건축</th><th>계약일</th><th>위치 / 생활환경</th></tr></thead><tbody>${result.rows.slice(0, 500).map(r => `<tr><td><strong>${esc(r.아파트명)}</strong><small>${esc(r.regionNames?.[r.지역코드]||result.regionName)} ${esc(r.법정동)}</small></td><td class="price">${money(r.거래금액만원)}</td><td>${esc(r.전용면적)}㎡</td><td>${esc(r.층 ?? '-')}층 / ${esc(r.건축년도 ?? '-')}년</td><td>${esc(r.계약일)}</td><td><a target="_blank" rel="noopener noreferrer" href="https://map.naver.com/p/search/${encodeURIComponent((r.regionNames?.[r.지역코드]||result.regionName)+' '+r.법정동+' '+r.아파트명)}">지도 보기 ↗</a><br><a target="_blank" rel="noopener noreferrer" href="https://map.naver.com/p/directions/-/14142918.664335111,4509592.668072284,선릉역,,SUBWAY_STATION/-/transit">선릉역 대중교통 길찾기 ↗</a><form method="post" action="/housing/listings"><input type="hidden" name="region" value="${esc(r.지역코드)}"><input type="hidden" name="dong" value="${esc(r.법정동)}"><input type="hidden" name="name" value="${esc(r.아파트명)}"><input type="hidden" name="min" value="${esc(values.min)}"><input type="hidden" name="max" value="${esc(values.max)}"><input type="hidden" name="area" value="${esc(values.area)}"><button style="margin-top:8px;padding:7px 10px;font-size:12px">현재 등록 매물 확인</button></form><form method="post" action="/housing/insights"><input type="hidden" name="region" value="${esc(r.지역코드)}"><input type="hidden" name="dong" value="${esc(r.법정동)}"><input type="hidden" name="name" value="${esc(r.아파트명)}"><input type="hidden" name="jibun" value="${esc(r.지번)}"><button style="margin-top:8px;padding:7px 10px;font-size:12px">교통·정비사업 확인</button></form></td></tr>`).join('')}</tbody></table></div>${result.rows.length > 500 ? '<p class="note">최신 500건을 표시합니다. 단지명이나 동으로 범위를 좁혀 주세요.</p>' : ''}` : '<div class="empty"><b>조건에 맞는 거래가 없습니다.</b>다른 월이나 지역으로 조회해 보세요.</div>'}` : '<div class="empty"><div class="eyebrow">A HOME THAT FITS YOUR LIFE</div><b>원하는 집의 기준을 골라주세요.</b>조회 버튼을 눌러야 거래 자료를 가져옵니다.<br>같은 지역·월 자료는 6시간 동안 다시 사용합니다.</div>';
  return shell(`<div class="eyebrow">APARTMENT TRANSACTIONS</div><h1>숫자로 살펴보는, 다음 집.</h1><p class="sub">서울·경기 아파트의 신고된 매매 가격을 비교하세요. 마음에 드는 단지는 지도에서 위치를 살펴볼 수 있습니다.</p><div class="chips"><span class="chip">서울 · 경기</span><span class="chip">기본 예산 9~11억원</span><span class="chip">기본 전용 84㎡ 이하</span><span class="chip">선릉역 출퇴근 70분 목표</span></div><div class="layout"><section class="card filters"><h2>내 집의 조건</h2><form method="post" action="/housing/search"><label for="region">지역</label><select id="region" name="region">${options}</select><div class="pair"><div><label for="month">기준 거래월</label><input type="month" id="month" name="month" value="${esc(values.month.slice(0,4)+'-'+values.month.slice(4))}" required></div><div><label for="months">조회 기간</label><select id="months" name="months">${[1,2,3].map(n=>`<option value="${n}" ${Number(values.months)===n?'selected':''}>최근 ${n}개월</option>`).join('')}</select></div></div><label>매매가 (억원)</label><div class="pair"><input aria-label="최저 매매가 (억원)" name="min" type="number" min="0" max="1000" step="0.1" value="${esc(values.min)}" required><input aria-label="최고 매매가 (억원)" name="max" type="number" min="0" max="1000" step="0.1" value="${esc(values.max)}" required></div><label for="area">최대 전용면적 (㎡)</label><input name="area" id="area" type="number" min="1" max="500" step="0.01" value="${esc(values.area)}" required><label for="name">아파트명 (선택)</label><input id="name" name="name" value="${esc(values.name)}" maxlength="80" placeholder="예: 래미안"><label for="dong">동 이름 (선택)</label><input id="dong" name="dong" value="${esc(values.dong)}" maxlength="50" placeholder="예: 봉천동"><button class="primary">실거래가 조회</button></form><p class="note">전체 지역은 조회량이 커서 경기 전체는 최대 2개월, 서울 전체는 최대 3개월까지 조회할 수 있습니다. 같은 지역·월 자료는 6시간 저장해 재사용합니다.</p></section><section class="card"><h2>매매 거래 내역</h2>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}${output}<p class="note">‘선릉역 대중교통 길찾기’를 열면 출발지에 해당 아파트를 입력해 경로를 확인할 수 있습니다. ‘교통·정비사업 확인’은 같은 동의 공식 사업 현황을 보여줍니다.</p></section></div>`, true);
}

function insightPage(data) {
  const c=data.commute,r=data.redevelopment;
  const commute=c.routes?.length ? `<p class="status">가장 빠른 예상 경로 <strong>${esc(c.routes[0].minutes)}분</strong> · ${c.routes[0].within70?'70분 이내 후보':'70분 초과'}</p><p class="note">출발 주소: ${esc(c.origin)} / 도착: 선릉역</p>${c.routes.map(route=>`<details class="card" style="margin:12px 0"><summary>${esc(route.minutes)}분 · 환승 ${esc(route.transfers)}회 · 도보 ${esc(route.walkingMeters)}m</summary><ol>${route.steps.map(step=>`<li>${esc(step)}</li>`).join('')}</ol></details>`).join('')}<p class="note">${esc(c.note)}</p>` : `<p class="status">${esc(c.status)}</p><p>${esc(c.message||'출발 위치를 확인하지 못했습니다.')}</p><p class="note">ODsay·카카오 키는 서버에만 저장하며, 개인 비밀번호로 접속한 뒤 버튼을 눌러야 조회됩니다.</p><a href="https://lab.odsay.com/user/join" target="_blank" rel="noopener noreferrer">ODsay 발급 시작 ↗</a> · <a href="https://developers.kakao.com/console/app" target="_blank" rel="noopener noreferrer">카카오 앱 설정 ↗</a>`;
  const projects=r.status==='조회 완료' ? `<p class="note">확인일: ${esc(r.checkedAt)} · ${esc(r.coverage)}</p>${r.truncated?'<p class="error">일부 후보만 확인했습니다. 전체 현황은 공식 자료에서 확인해 주세요.</p>':''}${r.rows.length? r.rows.map(p=>`<article class="card" style="margin:12px 0"><h2>${esc(p.name)}</h2><p>${esc(p.type)}</p><p class="status"><strong>${esc(p.assessment?.category||'공식 단계 확인 필요')}</strong></p><p>공식 진행 단계: <strong>${esc(p.stage||'미공개')}</strong></p><p class="note">${esc(p.address)}<br>${p.distance===null?'거리 미확인':`대표 주소 사이 직선거리 ${esc(p.distance)}m`}</p><p><strong>단계 해석(참고)</strong><br>${esc(p.interpretation)}</p><a href="${esc(p.source)}" target="_blank" rel="noopener noreferrer">공식 현황 원문 확인 ↗</a></article>`).join(''):'<p>같은 동 후보가 검색되지 않았습니다. 주변 사업이 없다는 뜻은 아닙니다.</p>'}<p class="note">${esc(r.disclaimer)}</p>` : `<p class="error">${esc(r.message)}</p>`;
  return shell(`<a href="/housing">← 검색 화면</a><div class="eyebrow" style="margin-top:24px">COMMUTE & NEIGHBORHOOD</div><h1>${esc(data.name||'관심 단지')}</h1><p class="sub">${esc(data.address)}</p><div class="layout" ><section class="card"><h2>선릉역 출퇴근</h2>${commute}<p class="note">powered by www.ODsay.com · 주소: Kakao Local</p></section><section class="card"><h2>주변 정비사업 진행상황</h2><p class="note">공식 단계가 앞선 사업부터 표시합니다. ‘기대’는 절차 진척에 대한 참고 해석이며 가격 상승이나 완공을 보장하지 않습니다.</p>${projects}<p><a href="${esc(r.source||'https://cleanup.seoul.go.kr/')}" target="_blank" rel="noopener noreferrer">공식 정비사업 전체 현황 ↗</a></p></section></div>`,true);
}

function listingPage(data) {
  const rows=data.rows.length ? `<div class="table-wrap"><table><thead><tr><th>전용 / 공급면적</th><th>매매가</th><th>동 / 층</th><th>향</th><th>확인일</th><th>매물</th></tr></thead><tbody>${data.rows.map(row=>`<tr><td>${esc(row.exclusiveArea)}㎡ / ${Number.isFinite(row.supplyArea)?`${esc(row.supplyArea)}㎡`:'-'}</td><td class="price">${esc(row.price||'-')}</td><td>${esc(row.buildingName||'동 미표시')} / ${esc(row.floorInfo||'층 미표시')}</td><td>${esc(row.direction||'-')}</td><td>${esc(row.confirmDate||'-')}</td><td><a href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">네이버 매물 원문 ↗</a></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><b>조건에 맞는 현재 매물이 없습니다.</b>아파트 이름이 같고 면적·가격 정보가 공개된 매물만 표시합니다.</div>';
  return shell(`<a href="/housing">← 실거래 검색으로 돌아가기</a><div class="eyebrow" style="margin-top:24px">CURRENT NAVER LISTINGS</div><h1>${esc(data.complexName)} 현재 매물</h1><p class="sub">${esc(data.address||'')} · 확인 ${esc(data.checkedAt)} · 등록 ${Number(data.totalCount).toLocaleString()}건 중 조건 일치 ${data.rows.length.toLocaleString()}건 표시</p><div class="card">${rows}${data.more?'<p class="note">네이버에 더 많은 매물이 있습니다. 이 화면은 최대 5페이지까지만 조회했으니 단지 전체 매물은 원문에서 확인하세요.</p>':''}<p class="note">${esc(data.disclaimer)}</p><p class="note">매물의 동·층 정보는 제공되는 경우에만 표시합니다. 호수는 비공식 MCP의 공개 응답 필드에서 확인할 수 없어 표시하지 않습니다. 원문 페이지에서 최신 내용을 확인하세요.</p><a href="${esc(data.source)}" target="_blank" rel="noopener noreferrer">네이버페이 부동산 단지 매물 전체 보기 ↗</a></div>`,true);
}

export function installHousingWeb(app, {password, publicUrl, fetchTrades, insights, findListings}) {
  if (typeof password !== 'string' || [...password].length < 12) throw new Error('개인 비밀번호 설정이 필요합니다.');
  const origin = new URL(publicUrl).origin;
  const secure = origin.startsWith('https:');
  const key = scryptSync(password, `housing-web:${origin}`, 32);
  const digest = value => createHash('sha256').update(value).digest();
  const sign = value => createHmac('sha256', key).update(value).digest('base64url');
  const session = () => { const value = `${Date.now()+8*3600000}.${randomBytes(24).toString('base64url')}`; return `${value}.${sign(value)}`; };
  const authenticated = req => {
    const cookie = (req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith('housing_session='))?.slice(16);
    if (!cookie || cookie.length > 256) return false;
    const parts = cookie.split('.');
    if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || Number(parts[0]) <= Date.now()) return false;
    return timingSafeEqual(digest(sign(parts.slice(0,2).join('.'))), digest(parts[2]));
  };
  const cookieOptions = {httpOnly:true, secure, sameSite:'strict', path:'/housing', maxAge:8*3600000};
  let attempts = {count:0, reset:0};
  let searches = {count:0, reset:0};
  let budget = {day:'', count:0};
  const cache = new Map();
  const inflight = new Map();
  app.use('/housing', (_req,res,next)=>{ res.set({'Cache-Control':'no-store','Referrer-Policy':'strict-origin','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}); next(); });
  const sameOrigin = (req,res,next) => req.get('origin') === origin ? next() : res.status(403).type('html').send(loginPage('접속한 사이트에서 다시 로그인해 주세요.'));
  const requireSession = (req,res,next) => authenticated(req) ? next() : res.redirect(303,'/housing');
  app.get('/housing', (req,res)=>res.type('html').send(authenticated(req) ? searchPage() : loginPage()));
  app.post('/housing/login', sameOrigin, express.urlencoded({extended:false,limit:'4kb'}), (req,res)=>{
    if (attempts.reset <= Date.now()) attempts = {count:0,reset:Date.now()+15*60000};
    if (attempts.count >= 30) return res.status(429).type('html').send(loginPage('시도가 너무 많습니다. 15분 뒤 다시 시도해 주세요.'));
    attempts.count++;
    if (!timingSafeEqual(digest(typeof req.body.password === 'string' ? req.body.password : ''), digest(password))) return res.status(401).type('html').send(loginPage('비밀번호가 일치하지 않습니다.'));
    res.cookie('housing_session',session(),cookieOptions).redirect(303,'/housing');
  });
  app.post('/housing/logout', sameOrigin, (req,res)=>{res.clearCookie('housing_session',{...cookieOptions,maxAge:undefined}).redirect(303,'/housing');});
  async function load(region, month, counters) {
    const id = `${region}:${month}`;
    const saved = cache.get(id);
    if (saved && saved.expires > Date.now()) {counters.cached++;return saved.data;}
    if (inflight.has(id)) {counters.cached++;return inflight.get(id);}
    const job = (async()=>{
      let rows = [], totalCount = 0;
      for (let pageNo=1;pageNo<=5;pageNo++) {
        const day = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
        if (budget.day !== day) budget = {day,count:0};
        if (budget.count >= 120) throw new Error('오늘 웹사이트 새 조회 제한에 도달했습니다. 저장된 자료 또는 내일 조회를 이용해 주세요.');
        budget.count++; counters.calls++;
        const data = await fetchTrades(region, month, {pageNo,numOfRows:1000});
        rows.push(...data.rows); totalCount = data.totalCount;
        if (!data.rows.length || rows.length >= totalCount) break;
      }
      const data = {rows, truncated:rows.length<totalCount};
      if (cache.size >= 300) cache.delete(cache.keys().next().value);
      cache.set(id,{data,expires:Date.now()+6*3600000});
      return data;
    })();
    inflight.set(id,job);
    try {return await job;} finally {inflight.delete(id);}
  }
  let insightHits={count:0,reset:0};
  let listingHits={count:0,reset:0};
  app.post('/housing/insights', sameOrigin, requireSession, express.urlencoded({extended:false,limit:'4kb'}), async(req,res)=>{
    if(insightHits.reset<=Date.now())insightHits={count:0,reset:Date.now()+60000};
    if(insightHits.count>=6)return res.status(429).type('html').send(shell('<p class="error">추가 조회가 많습니다. 1분 뒤 다시 이용해 주세요.</p><a href="/housing">검색으로 돌아가기</a>',true));
    insightHits.count++;
    try{
      if(!insights)throw new Error('연결 준비 중입니다.');
      const data=await insights.inspect({region:String(req.body.region||''),dong:String(req.body.dong||''),name:String(req.body.name||''),jibun:String(req.body.jibun||'')});
      res.type('html').send(insightPage(data));
    }catch{res.status(400).type('html').send(shell('<p class="error">단지 주소를 확인하지 못했습니다. 검색 결과에서 다시 시도해 주세요.</p><a href="/housing">검색으로 돌아가기</a>',true));}
  });
  app.post('/housing/listings', sameOrigin, requireSession, express.urlencoded({extended:false,limit:'4kb'}), async(req,res)=>{
    if(listingHits.reset<=Date.now())listingHits={count:0,reset:Date.now()+60000};
    if(listingHits.count>=5)return res.status(429).type('html').send(shell('<p class="error">매물 조회가 많습니다. 1분 뒤 다시 이용해 주세요.</p><a href="/housing">검색으로 돌아가기</a>',true));
    listingHits.count++;
    try{
      if(!findListings)throw new Error('매물 연결 준비 중입니다.');
      const regionCode=String(req.body.region||''),dong=String(req.body.dong||''),name=String(req.body.name||'').trim().slice(0,80);
      const minPrice=Number(req.body.min),maxPrice=Number(req.body.max),maxArea=Number(req.body.area);
      if(![minPrice,maxPrice,maxArea].every(Number.isFinite)||minPrice<0||maxPrice<minPrice||maxPrice>1000||maxArea<=0||maxArea>500)throw new Error('검색 가격·면적을 확인해 주세요.');
      const data=await findListings({regionCode,dong,name,minPrice,maxPrice,maxArea});
      res.type('html').send(listingPage(data));
    }catch(error){
      const message=String(error?.message||'').slice(0,180);
      res.status(400).type('html').send(shell(`<a href="/housing">← 실거래 검색으로 돌아가기</a><p class="error">현재 매물을 가져오지 못했습니다. ${esc(message||'네이버 응답 또는 검색 조건을 확인해 주세요.')}</p><p class="note">비공식 API는 네이버 서비스 변경이나 요청 제한에 따라 중단될 수 있습니다.</p>`,true));
    }
  });
  app.post('/housing/search', sameOrigin, requireSession, express.urlencoded({extended:false,limit:'8kb'}), async(req,res)=>{
    let values = defaults();
    try {
      const b=req.body;
      values={region:String(b.region||''),month:String(b.month||'').replace('-',''),months:Number(b.months),min:Number(b.min),max:Number(b.max),area:Number(b.area),name:String(b.name||'').trim().slice(0,80),dong:String(b.dong||'').trim().slice(0,50)};
      const region=regionChoices.find(r=>r.code===values.region);
      const selectedRegions=allRegionGroups[values.region]||regions.filter(r=>r.code===values.region);
      if (!region || !selectedRegions.length || !/^\d{4}(0[1-9]|1[0-2])$/.test(values.month) || values.month<'200601' || values.month>currentMonth() || ![1,2,3].includes(values.months) || ![values.min,values.max,values.area].every(Number.isFinite) || values.min<0 || values.max<values.min || values.max>1000 || values.area<=0 || values.area>500) throw new Error('지역·거래월·가격·면적을 확인해 주세요.');
      if (selectedRegions.length * values.months > 100) return res.status(400).type('html').send(searchPage(values,null,'선택한 전체 지역과 기간은 조회량이 큽니다. 경기 전체는 최근 2개월까지, 서울 전체는 최근 3개월까지 선택해 주세요.'));
      if (searches.reset <= Date.now()) searches={count:0,reset:Date.now()+60000};
      if (searches.count >= 10) return res.status(429).type('html').send(searchPage(values,null,'조회가 많습니다. 1분 뒤 다시 시도해 주세요.'));
      searches.count++;
      const counters={calls:0,cached:0}; let rows=[],truncated=false;
      const regionNames=Object.fromEntries(selectedRegions.map(r=>[r.code,r.name.replace('서울특별시 ','서울 ').replace('경기도 ','경기 ')]));
      for(const selected of selectedRegions) for(let i=0;i<values.months;i++){const data=await load(selected.code,monthsBefore(values.month,i),counters);rows.push(...data.rows.map(row=>({...row,지역코드:selected.code,regionNames})));truncated ||= data.truncated;}
      rows=rows.filter(r=>!r.해제여부 && r.거래금액만원>=values.min*10000 && r.거래금액만원<=values.max*10000 && r.전용면적>0 && r.전용면적<=values.area && r.아파트명?.includes(values.name) && r.법정동?.includes(values.dong));
      rows.sort((a,b)=>Date.parse(b.계약일)-Date.parse(a.계약일));
      res.type('html').send(searchPage(values,{rows,regionName:region.name,period:`${monthsBefore(values.month,values.months-1)} ~ ${values.month}`,...counters,truncated}));
    } catch {res.status(400).type('html').send(searchPage(values,null,'조회하지 못했습니다. 입력 조건과 날짜를 확인하고 잠시 후 다시 시도해 주세요. 계속되면 공공데이터 서비스 상태를 확인해 주세요.'));}
  });
}
