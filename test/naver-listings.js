import assert from 'node:assert/strict';
import {createNaverListings, normalizeNaverListing} from '../naver-listings.js';

const calls=[];
const fetcher=async(url,options)=>{
  const parsed=new URL(url);calls.push({url:parsed,options});
  if(parsed.pathname==='/api/regions/list')return Response.json({regionList:[{cortarNm:'봉천동',cortarNo:'1162010100'}]});
  if(parsed.pathname==='/api/regions/complexes')return Response.json({complexList:[{complexNo:'12345',complexName:'검증 아파트',cortarAddress:'서울 관악구 봉천동'}]});
  if(parsed.pathname==='/api/articles/complex/12345')return Response.json({totalCount:3,isMoreData:false,articleList:[
    {articleNo:'1',dealOrWarrantPrc:'9억 5,000',area2:84,area1:110,buildingName:'101동',floorInfo:'중/20',articleConfirmYmd:'20261001'},
    {articleNo:'2',dealOrWarrantPrc:'9억 5,000',area2:59.9,area1:80},
    {articleNo:'3',dealOrWarrantPrc:'10억',area2:70,area1:95},
  ]});
  throw new Error(`unexpected endpoint: ${parsed.pathname}`);
};

const findListings=createNaverListings({fetcher});
const result=await findListings({regionCode:'11620',dong:'봉천동',name:'검증 아파트',minPrice:9,maxPrice:11,minArea:70,maxArea:84});
assert.equal(result.rows.length,2);
assert.deepEqual(result.rows.map(row=>row.exclusiveArea),[84,70]);
assert.equal(result.rows[0].priceManwon,95000);
assert.equal(result.rows[0].buildingName,'101동');
assert.equal(result.rows[0].confirmDate,'20261001');
const articleRequest=calls.find(call=>call.url.pathname==='/api/articles/complex/12345');
assert.ok(articleRequest);
assert.equal(articleRequest.url.searchParams.get('tradeType'),'A1');
assert.equal(articleRequest.options.headers.Referer,'https://new.land.naver.com/complexes');
assert.match(articleRequest.options.headers['User-Agent'],/^Mozilla\//);
assert.equal(normalizeNaverListing({articleNo:'a',dealOrWarrantPrc:'10억',area2:'84.5'}).exclusiveArea,84.5);
await findListings({regionCode:'11620',dong:'봉천동',name:'검증 아파트',minPrice:9,maxPrice:11,minArea:70,maxArea:84});
assert.equal(calls.filter(call=>call.url.pathname==='/api/regions/list').length,1,'region directory should be reused from the short-lived cache');
assert.equal(calls.filter(call=>call.url.pathname==='/api/regions/complexes').length,1,'complex directory should be reused from the short-lived cache');
assert.equal(calls.filter(call=>call.url.pathname==='/api/articles/complex/12345').length,2,'live listing response should be fetched again, not cached');
console.log('PASS: Naver listing endpoint, field normalization, headers, and minimum/maximum area filters; fixture only, no live calls.');
