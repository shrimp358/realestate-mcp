const BASE = "https://new.land.naver.com/api";
const BROWSER_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  Origin: "https://new.land.naver.com",
  Referer: "https://new.land.naver.com/complexes",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};
const clean = value => String(value ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const normalized = value => clean(value).replace(/\s+/g, "").toLowerCase();

async function json(url, fetcher, timeoutMs = 6500) {
  const response = await fetcher(url, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(Math.max(100, timeoutMs)),
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
  const price = clean(item.prcInfo || item.hanPrc || item.prc || item.dealOrWarrantPrc || item.price);
  const exclusiveArea = areaValue(item.spc2 ?? item.exclusiveArea ?? item.area2);
  const supplyArea = areaValue(item.spc1 ?? item.supplyArea ?? item.area1);
  return {
    articleNo,
    price,
    priceManwon: priceInManwon(price),
    exclusiveArea,
    supplyArea,
    buildingName: clean(item.bildNm || item.buildingName),
    floorInfo: clean(item.flrInfo || item.floorInfo),
    direction: clean(item.direction),
    confirmDate: clean(item.atclCfmYmd || item.articleConfirmYmd || item.confirmDate),
    realtorName: clean(item.rltrNm || item.realtorName),
    feature: clean(item.atclFetrDesc || item.featureDesc),
    url: articleNo ? `https://fin.land.naver.com/articles/${encodeURIComponent(articleNo)}` : "https://land.naver.com/",
  };
}

export function createNaverListings({ fetcher = fetch } = {}) {
  const cache = new Map();
  const cachedJson = async (url, deadline, cacheTtlMs = 0) => {
    const key = String(url);
    const cached = cache.get(key);
    if (cacheTtlMs && cached && cached.expiresAt > Date.now()) return cached.value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DOMException("Naver lookup deadline exceeded", "TimeoutError");
    const value = await json(url, fetcher, Math.min(6500, remaining));
    if (cacheTtlMs) cache.set(key, { value, expiresAt: Date.now() + cacheTtlMs });
    return value;
  };
  return async function findListings({ regionCode, dong, name, minPrice, maxPrice, minArea = 0, maxArea }) {
    if (!/^\d{5}$/.test(regionCode) || !/^[가-힣A-Za-z0-9·. ]{1,50}$/.test(dong) || !name || name.length > 80) {
      throw new Error("지역·동·아파트 이름을 확인해 주세요.");
    }
    // Keep the full page request comfortably below common reverse-proxy timeouts.
    // Region and complex directories are stable enough to reuse briefly in memory.
    const deadline = Date.now() + 18000;
    const regionCortarNo = `${regionCode}00000`;
    const regionUrl = new URL(`${BASE}/regions/list`);
    regionUrl.searchParams.set("cortarNo", regionCortarNo);
    const regionData = await cachedJson(regionUrl, deadline, 30 * 60 * 1000);
    const dongRow = (regionData.regionList || []).find(row => normalized(row.cortarNm) === normalized(dong));
    if (!dongRow?.cortarNo) throw new Error("네이버 지역 목록에서 해당 동을 찾지 못했습니다.");

    const complexesUrl = new URL(`${BASE}/regions/complexes`);
    complexesUrl.searchParams.set("cortarNo", dongRow.cortarNo);
    complexesUrl.searchParams.set("realEstateType", "APT");
    const complexesData = await cachedJson(complexesUrl, deadline, 30 * 60 * 1000);
    const complexes = (complexesData.complexList || []).filter(row => normalized(row.complexName) === normalized(name));
    if (complexes.length !== 1) throw new Error(complexes.length ? "같은 이름의 단지가 여럿이라 정확한 매물을 고르지 못했습니다." : "네이버 단지 목록에서 일치하는 아파트를 찾지 못했습니다.");

    const complex = complexes[0];
    const listingsUrl = new URL(`${BASE}/articles/complex/${encodeURIComponent(complex.complexNo)}`);
    const listingParams = {
      realEstateType: "APT:ABYG:JGC", tradeType: "A1", tag: "::::::::",
      rentPriceMin: "0", rentPriceMax: "900000000", priceMin: "0", priceMax: "900000000",
      areaMin: "0", areaMax: "900000000", oldBuildYears: "", recentlyBuildYears: "",
      minHouseHoldCount: "", maxHouseHoldCount: "", showArticle: "false", sameAddressGroup: "false",
      minMaintenanceCost: "", maxMaintenanceCost: "", priceType: "RETAIL", directions: "",
      page: "1", complexNo: String(complex.complexNo), buildingNos: "", areaNos: "", type: "list", order: "rank",
    };
    for (const [key, value] of Object.entries(listingParams)) listingsUrl.searchParams.set(key, value);
    const allItems=[];let totalCount=0,more=false;
    // Two pages are enough for the price/area filters in this private tool while
    // preventing a busy complex from holding the user's request open indefinitely.
    for(let page=1;page<=2;page++){
      listingsUrl.searchParams.set("page", String(page));
      const listingData = await cachedJson(listingsUrl, deadline);
      const items=listingData.articleList || listingData.result?.list || listingData.list || [];
      if(!items.length)break;
      allItems.push(...items);totalCount=Number(listingData.totalCount || listingData.result?.totAtclCnt || allItems.length);more=Boolean(listingData.isMoreData || listingData.moreData || listingData.result?.moreDataYn==="Y");
      if(!more)break;
    }
    const rows = allItems.map(normalizeNaverListing).filter(row =>
      Number.isFinite(row.exclusiveArea) && row.exclusiveArea >= minArea && row.exclusiveArea <= maxArea &&
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
