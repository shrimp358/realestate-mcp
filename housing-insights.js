import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LAWD_CODES } from './lawd-codes.js';

const SEOUL = 'https://cleanup.seoul.go.kr/cleanup/bsnssttus/lscrMainIndx.do';
const GYEONGGI = 'https://www.gg.go.kr/onnuri/view.do?no=109';
const clean = s => String(s ?? '').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
export function parseSeoul(html) {
  const table = html.match(/<table\b[^>]*class="board-list-tbl[^>]*>([\s\S]*?)<\/table>/)?.[1];
  if (!table) throw new Error('공식 자료 형식이 바뀌어 확인할 수 없습니다.');
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].flatMap(m=>{
    const cells=[...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(t=>clean(t[1]));
    if(cells.length<6) return [];
    const cafe=m[1].match(/cafeOpenPopup\('([\w-]+)'\)/)?.[1];
    return [{district:cells[1],type:cells[2],name:cells[3],address:cells[4],stage:cells[5],source:cafe ? `https://cleanup.seoul.go.kr/sures/assc/scrin/index.do?cafeId=${encodeURIComponent(cafe)}` : SEOUL}];
  });
}
export function parseGyeonggi(html) {
  const list=html.match(/var bizaraList\s*=\s*\[([\s\S]*?)\];/)?.[1];
  if(!list) throw new Error('공식 자료 형식이 바뀌어 확인할 수 없습니다.');
  return [...list.matchAll(/\{([^{}]+)\}/g)].flatMap(m=>{
    const value=k=>clean(m[1].match(new RegExp(k+":\\s*'([^']*)'"))?.[1]);
    if(!value('bizaraId') || !value('bizaraNm')) return [];
    return [{district:value('sigunSeNm'),type:value('bizTypeNm'),name:value('bizaraNm'),address:value('addr'),stage:value('bizaraStepNm'),source:GYEONGGI}];
  });
}
export function interpretation(stage) {
  if(/해산|준공/.test(stage)) return '완료·해산 단계: 이미 반영된 변화인지 확인해야 합니다. 새 미래 호재로 단정하지 않습니다.';
  if(/관리처분|사업시행|착공/.test(stage)) return '사업 진행에 따른 주거환경 개선 가능성(추정). 공사 소음·이주·추가 공급과 일정 지연도 확인해야 합니다.';
  return '초기 또는 세부 단계 미확인: 환경 개선 가능성(추정)은 있으나 인허가·동의율·사업성·기간을 추가 확인해야 합니다.';
}
export function distanceMeters(a,b) {
  const rad=n=>n*Math.PI/180, dlat=rad(b.y-a.y),dlon=rad(b.x-a.x);
  const h=Math.sin(dlat/2)**2+Math.cos(rad(a.y))*Math.cos(rad(b.y))*Math.sin(dlon/2)**2;
  return Math.round(6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h)));
}
export function routeSummary(data) {
  const result=data.result;
  if(!result || Number(result.searchType)!==0 || !Array.isArray(result.path)) throw new Error('완전한 수도권 통근 경로를 확인하지 못했습니다.');
  const routes=result.path.filter(p=>Number.isFinite(Number(p.info?.totalTime)) && Number(p.info.totalTime)>0).map(p=>({
    minutes:Number(p.info.totalTime),within70:Number(p.info.totalTime)<=70,
    transfers:Math.max(0,Number(p.info.busTransitCount||0)+Number(p.info.subwayTransitCount||0)-1),
    walkingMeters:Number(p.info.totalWalk||0),
    steps:(p.subPath||[]).map(s=>`${s.trafficType===3?'도보':(s.lane||[]).map(l=>l.name||l.busNo).filter(Boolean).join(' / ') || '대중교통'} ${s.startName||''} → ${s.endName||''} (${s.sectionTime}분)`)
  })).sort((a,b)=>a.minutes-b.minutes).slice(0,3);
  if(!routes.length) throw new Error('경로가 없어 통근 시간을 판정하지 못했습니다.');
  return routes;
}
export function createHousingInsights({env=process.env,fetcher=fetch,routeFetcher}={}) {
  const cache=new Map(),pending=new Map(); let counts={day:'',odsay:0,kakao:0};
  const cached=async(id,ttl,fn)=>{
    const hit=cache.get(id); if(hit && hit.until>Date.now()) return hit.data;
    if(pending.has(id)) return pending.get(id);
    const job=(async()=>{const data=await fn();if(cache.size>=1000)cache.delete(cache.keys().next().value);cache.set(id,{data,until:Date.now()+ttl});return data;})();
    pending.set(id,job);try{return await job;}finally{pending.delete(id);}
  };
  const use=kind=>{const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());if(counts.day!==day)counts={day,odsay:0,kakao:0};if(counts[kind]>=(kind==='odsay'?40:160))throw new Error('오늘 추가 조회 제한에 도달했습니다. 저장된 결과 또는 내일 이용해 주세요.');counts[kind]++;};
  const request=async(url,options={})=>{const res=await fetcher(url,{...options,signal:AbortSignal.timeout(20000)});if(!res.ok)throw new Error('외부 서비스가 응답하지 않습니다.');return res;};
  async function geocode(query,keyword=false) {
    if(!env.KAKAO_REST_API_KEY) throw new Error('카카오 주소 검색 키 연결 대기');
    return cached(`geo:${keyword}:${query}`,24*3600000,async()=>{
      use('kakao');const url=new URL(`https://dapi.kakao.com/v2/local/search/${keyword?'keyword':'address'}.json`);url.searchParams.set('query',query);
      const data=await (await request(url,{headers:{Authorization:`KakaoAK ${env.KAKAO_REST_API_KEY}`}})).json();
      const docs=(data.documents||[]).filter(d=>!keyword || (d.place_name==='선릉역 2호선' || d.place_name==='선릉역 수인분당선' || d.place_name==='선릉역') && /강남구/.test(d.address_name));
      const d=docs[0];if(!d || (!keyword && docs.length!==1))throw new Error('주소가 없거나 여러 위치가 검색되어 거리를 확정하지 못했습니다.');
      const point={x:Number(d.x),y:Number(d.y),address:d.address_name};
      if(!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.x<124||point.x>132||point.y<33||point.y>39)throw new Error('주소 좌표를 확인하지 못했습니다.');
      return point;
    });
  }
  async function odsay(a,b) {
    if(!env.ODSAY_API_KEY)throw new Error('ODsay 대중교통 키 연결 대기');
    return cached(`route:${a.x}:${a.y}:${b.x}:${b.y}`,6*3600000,async()=>{
      use('odsay');
      if(routeFetcher)return routeSummary(await routeFetcher(a,b));
      const client=new Client({name:'private-housing',version:'1.0.0'});
      const transport=new StreamableHTTPClientTransport(new URL('https://mcp.odsay.com/mcp'),{requestInit:{headers:{'ARO-API-Key':env.ODSAY_API_KEY}},fetch:(url,opts)=>fetcher(url,{...opts,signal:AbortSignal.timeout(20000)})});
      try{
        await client.connect(transport);
        const {tools}=await client.listTools();
        const tool=tools.find(t=>/searchPubTransPath/i.test(t.name) && ['SX','SY','EX','EY'].every(k=>Object.keys(t.inputSchema.properties||{}).some(p=>p.toUpperCase()===k)));
        if(!tool)throw new Error('ODsay MCP 경로 도구의 형식을 확인해야 합니다.');
        const known={SX:a.x,SY:a.y,EX:b.x,EY:b.y,OPT:0,SEARCHTYPE:0,SEARCHPATHTYPE:0,LANG:0,OUTPUT:'json'},args={};
        for(const [k,s] of Object.entries(tool.inputSchema.properties||{})){if(Object.hasOwn(known,k.toUpperCase()))args[k]=s.type==='string'?String(known[k.toUpperCase()]):known[k.toUpperCase()];}
        if((tool.inputSchema.required||[]).some(k=>!(k in args)))throw new Error('ODsay MCP 필수 입력 형식을 확인해야 합니다.');
        const response=await client.callTool({name:tool.name,arguments:args},undefined,{timeout:20000});
        if(response.isError)throw new Error('ODsay 경로 조회 실패: 키·허용 IP·사용량을 확인해 주세요.');
        let data=response.structuredContent;
        if(!data?.result){for(const c of response.content||[]){if(c.type==='text'){try{const json=JSON.parse(c.text);if(json.result){data=json;break;}}catch{}}}}
        return routeSummary(data||{});
      }finally{await client.close().catch(()=>{});}
    });
  }
  async function projects(region) {
    return cached(`projects:${region.code}`,6*3600000,async()=>{
      const checkedAt=new Date().toISOString();
      if(region.name.startsWith('경기도 ')){
        const html=await (await request(GYEONGGI)).text();
        const city=region.name.replace('경기도 ','');
        return {rows:parseGyeonggi(html).filter(r=>r.district===city || r.district.startsWith(city+' ')),checkedAt,source:GYEONGGI,truncated:false};
      }
      let rows=[],truncated=false;
      for(let page=1;page<=10;page++){
        const url=new URL(SEOUL);url.searchParams.set('scupBsnsSttus.signguCode',region.code);url.searchParams.set('cpage',page);url.searchParams.set('pageSize','10');
        const html=await (await request(url)).text(), parsed=parseSeoul(html);
        if(parsed.some(r=>r.district!==region.name.replace('서울특별시 ','')))throw new Error('공식 지역 필터를 확인하지 못했습니다.');
        rows.push(...parsed);
        const pages=[...html.matchAll(/cpage=(\d+)/g)].map(m=>Number(m[1]));
        const hasMore=pages.some(p=>p>page);
        if(!hasMore||parsed.length<10)break;
        if(page===10)truncated=true;
      }
      return {rows,checkedAt,source:SEOUL,truncated};
    });
  }
  async function inspect({region:code,dong,name='',jibun=''}) {
    const region=LAWD_CODES.find(r=>r.code===code && /^(서울특별시|경기도) /.test(r.name));
    if(!region || !/^[가-힣A-Za-z0-9·. ]{1,50}$/.test(dong)||name.length>80||jibun.length>40||!/^[-0-9산 ]*$/.test(jibun))throw new Error('서울·경기 지역과 법정동·지번을 확인해 주세요.');
    const address=`${region.name} ${dong} ${jibun}`.trim();
    const output={name,address,commute:{status:'미확인'},redevelopment:{status:'미확인'}};
    let point;
    if(env.KAKAO_REST_API_KEY && jibun){try{point=await geocode(address);}catch(e){output.commute.message=e.message;}}
    if(!env.KAKAO_REST_API_KEY || !env.ODSAY_API_KEY)output.commute.message='대중교통 자동 계산은 ODsay 키와 카카오 주소 검색 키 발급 후 사용할 수 있습니다.';
    else if(point){try{output.commute={status:'조회 완료',routes:await odsay(point,await geocode('선릉역',true)),origin:point.address,destination:'선릉역',note:'ODsay 예상 소요시간입니다. 출근 시간대 대기·혼잡·아파트 출입구 이동과 역 이후 회사까지의 이동은 별도로 확인해 주세요.'};}catch(e){output.commute.message=e.message;}}
    else if(!jibun)output.commute.message='정확한 출발 위치를 계산하려면 지번이 필요합니다.';
    try{
      const data=await projects(region);
      const matches=data.rows.filter(r=>r.address.includes(dong));
      const rows=matches.slice(0,10).map(r=>({...r,interpretation:interpretation(r.stage),distance:null}));
      if(point){for(const row of rows){try{const normalized=row.address.replace(/\([^)]*\)/g,'').replace(/번지.*$/,'').trim();const p=await geocode(normalized.startsWith('서울')||normalized.startsWith('경기')?normalized:`${region.name} ${normalized}`);row.distance=distanceMeters(point,p);}catch{}}}
      output.redevelopment={status:'조회 완료',rows,checkedAt:data.checkedAt,source:data.source,coverage:'같은 법정동 이름이 주소에 포함된 사업 후보입니다. 인접 동·다른 이름·미등록 사업은 포함되지 않을 수 있습니다. 거리는 대표 주소 사이 직선거리입니다.',truncated:data.truncated||matches.length>10,disclaimer:'진행 단계는 공식 공개 현황이고 해석은 추정입니다. 가격 상승 여부·수익을 보장하지 않습니다. 경기도의 조합(시행자) 표시는 세부 인허가 단계를 뜻하지 않습니다.'};
    }catch{output.redevelopment={status:'조회 실패',message:'공식 현황을 불러오지 못했습니다. 사업이 없다는 뜻이 아닙니다.',source:region.name.startsWith('서울')?SEOUL:GYEONGGI};}
    return output;
  }
  return {inspect};
}
