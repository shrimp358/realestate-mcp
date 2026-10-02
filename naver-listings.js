const BASE = "https://new.land.naver.com/api";
const MOBILE = "https://m.land.naver.com";
const clean = value => String(value ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const normalized = value => clean(value).replace(/\s+/g, "").toLowerCase();

async function json(url, fetcher) {
  const response = await fetcher(url, {
    headers: { Accept: "application/json, text/plain, */*", "User-Agent": "HomeSearch-private/1.0" },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`네이버 매물 조회 응답 오류 (${response.status})`);
  return response.json();
}

function priceInManwon(value) {
  const text = clean(value).replace(/,/g, "");
  const eok = text.match(/(\d+)\s*억/);
  let result=eok ? Number(eok[1])*10000 : 0;
  let rest=eok ? text.slice(eok.index+eok[0].length) : text;
  const thousand=rest.match(/(\d+)\s*천/);
  if(thousand){result+=Number(thousand[1])*1000;rest=rest.replace(thousand[0],"");}
  const digits=rest.replace(/[^\d]/g,"");
  if(digits)result+=Number(digits);
  return result||NaN;
}

function areaValue(value) {
  const match=String(value??"").replace(/,/g,"").match(/\d+(?:\.\d+)?/);
  const parsed = match ? Number(match[0]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN;
}

export function normalizeNaverListing(item) {
  const articleNo = clean(item.atclNo || item.articleNo);
  const price = clean(item.prcInfo || item.hanPrc || item.prc || item.price);
  const exclusiveArea = areaValue(item.spc2 ?? item.exclusiveArea);
  const supplyArea = areaValue(item.spc1 ?? item.supplyArea);
  return {
    articleNo,
    price,
    priceManwon: priceInManwon(price),
    exclusiveArea,
    supplyArea,
    buildingName: clean(item.bildNm || item.buildingName),
    floorInfo: clean(item.flrInfo || item.floorInfo),
    direction: clean(item.direction),
    confirmDate: clean(item.atclCfmYmd || item.confirmDate),
    realtorName: clean(item.rltrNm || item.realtorName),
    feature: clean(item.atclFetrDesc || item.featureDesc),
    url: articleNo ? `https://fin.land.naver.com/articles/${encodeURIComponent(articleNo)}` : "https://land.naver.com/",
  };
}

export function createNaverListings({ fetcher = fetch } = {}) {
  return async function findListings({ regionCode, dong, name, minPrice, maxPrice, maxArea }) {
    if (!/^\d{5}$/.test(regionCode) || !/^[가-힣A-Za-z0-9·. ]{1,50}$/.test(dong) || !name || name.length > 80) {
      throw new Error("지역·동·아파트 이름을 확인해 주세요.");
    }
    const regionCortarNo = `${regionCode}00000`;
    const regionUrl = new URL(`${BASE}/regions/list`);
    regionUrl.searchParams.set("cortarNo", regionCortarNo);
    const regionData = await json(regionUrl, fetcher);
    const dongRow = (regionData.regionList || []).find(row => normalized(row.cortarNm) === normalized(dong));
    if (!dongRow?.cortarNo) throw new Error("네이버 지역 목록에서 해당 동을 찾지 못했습니다.");

    const complexesUrl = new URL(`${BASE}/regions/complexes`);
    complexesUrl.searchParams.set("cortarNo", dongRow.cortarNo);
    complexesUrl.searchParams.set("realEstateType", "APT");
    const complexesData = await json(complexesUrl, fetcher);
    const complexes = (complexesData.complexList || []).filter(row => normalized(row.complexName) === normalized(name));
    if (complexes.length !== 1) throw new Error(complexes.length ? "같은 이름의 단지가 여럿이라 정확한 매물을 고르지 못했습니다." : "네이버 단지 목록에서 일치하는 아파트를 찾지 못했습니다.");

    const complex = complexes[0];
    const listingsUrl = new URL(`${MOBILE}/complex/getComplexArticleList`);
    listingsUrl.searchParams.set("hscpNo", complex.complexNo);
    listingsUrl.searchParams.set("tradTpCd", "A1");
    listingsUrl.searchParams.set("order", "prc_");
    listingsUrl.searchParams.set("showR0", "N");
    listingsUrl.searchParams.set("page", "1");
    const allItems=[];let totalCount=0,more=false;
    for(let page=1;page<=5;page++){
      listingsUrl.searchParams.set("page", String(page));
      const listingData = await json(listingsUrl, fetcher);
      const result = listingData.result || {};
      const items=result.list||[];
      if(!items.length)break;
      allItems.push(...items);totalCount=Number(result.totAtclCnt||allItems.length);more=result.moreDataYn==="Y";
      if(!more)break;
      if(page<5)await new Promise(resolve=>setTimeout(resolve,1100));
    }
    const rows = allItems.map(normalizeNaverListing).filter(row =>
      Number.isFinite(row.exclusiveArea) && row.exclusiveArea <= maxArea &&
      Number.isFinite(row.priceManwon) && row.priceManwon >= minPrice * 10000 && row.priceManwon <= maxPrice * 10000
    );
    return {
      complexName: clean(complex.complexName),
      address: clean(complex.cortarAddress || complex.detailAddress),
      checkedAt: new Date().toISOString(),
      totalCount,
      more,
      rows,
      source: `https://fin.land.naver.com/complexes/${encodeURIComponent(complex.complexNo)}`,
      disclaimer: "네이버 부동산의 비공식 내부 API 조회 결과입니다. 등록·노출 상태와 호가는 바뀔 수 있어 매물 원문을 확인하세요. 이 응답은 서버에 저장하지 않습니다. API 변경 또는 제한 시 조회가 중단될 수 있습니다.",
    };
  };
}
