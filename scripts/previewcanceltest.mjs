// Top-comment previews must stop fetching when their cards go away.
//
// The preview fetch waits on a cross-card concurrency slot, so a deep feed builds a long queue. The
// queue had no cancellation and `inView` is a one-way latch, so navigating away left it draining:
// requests kept going out for cards that were no longer mounted. React Query aborts a query's signal
// when its last observer unsubscribes, so consuming that signal is what stops the backlog.
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4173/';
const now=Math.floor(Date.now()/1000);
const IDS=Array.from({length:90},(_,i)=>1000+i);
const mk=id=>({id,type:'story',by:`u${id}`,title:`Story ${id}`,url:`https://ex${id%7}.com/x`,score:100,descendants:12,time:now-3600,kids:[id*10+1,id*10+2,id*10+3]});
const b=await chromium.launch({headless:true});
const ctx=await b.newContext({viewport:{width:1280,height:800}});
const page=await ctx.newPage();
let itemReqs=0, counting=false;
await page.route(/hacker-news\.firebaseio\.com/, async r=>{
  const u=r.request().url();
  const j=x=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(x)});
  if(/(top|best|new)stories/.test(u))return j(IDS);
  if(/(ask|show|job)stories/.test(u))return j([]);
  const m=u.match(/item\/(\d+)/);
  if(m){ if(counting) itemReqs++; const id=Number(m[1]);
    if(id>9999) { await new Promise(s=>setTimeout(s,120)); return j({id,type:'comment',by:'c',text:'This is a genuinely substantive top-level comment with enough length and detail to be worth previewing to a reader scanning the feed.',time:now-100}); }
    return j(mk(id)); }
  return j(null);
});
await page.route(/hn\.algolia\.com/, r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({hits:[],children:[]})}));
await page.goto(`${BASE}#/?feed=top`,{waitUntil:'domcontentloaded'});
await page.waitForSelector('article',{timeout:20000});
for(let i=0;i<12;i++){ await page.mouse.wheel(0,2000); await page.waitForTimeout(250); }
await page.waitForTimeout(1200);
const mounted=await page.evaluate(()=>document.querySelectorAll('article').length);
const previewsBeforeNav = await page.evaluate(() =>
  [...document.querySelectorAll('article')].filter((a) => /\S/.test(a.querySelector('.sc-topcomment')?.textContent || '')).length);
counting=true;
await page.evaluate(()=>{location.hash='#/settings';});
await page.waitForTimeout(700);
const stillMounted=await page.evaluate(()=>document.querySelectorAll('article').length);
await page.waitForTimeout(9000);
// Return to the feed and confirm previews still render — proves the slot was released on the abort.
await page.evaluate(()=>{location.hash='#/?feed=top';});
await page.waitForSelector('article',{timeout:20000});
await page.waitForTimeout(3000);
const previewsAfterReturn = await page.evaluate(() =>
  [...document.querySelectorAll('article')].filter((a) => /\S/.test(a.querySelector('.sc-topcomment')?.textContent || '')).length);
await b.close();

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};
check(`PRECONDITION: previews actually rendered before navigating (previewsBeforeNav=${previewsBeforeNav})`, previewsBeforeNav > 0, `previewsBeforeNav=${previewsBeforeNav}`);
check('PRECONDITION: a deep feed was built and then fully unmounted', mounted >= 30 && stillMounted === 0, `before=${mounted} after=${stillMounted}`);
// Requests already IN FLIGHT when the reader navigates still land: the abort stops work that has not
// started, it does not cancel an open socket. The invariant is that the QUEUE stops draining, so the
// ceiling is the module's own cross-card concurrency (2 cards x 3 kids = 6), NOT a number that grows
// with how deep the feed was. Before the abort was consumed this figure tracked the queue depth.
const IN_FLIGHT_CEILING = 6;
check('the preview backlog stops once the cards are gone (only in-flight requests land)', itemReqs <= IN_FLIGHT_CEILING, `itemRequestsAfterNav=${itemReqs} ceiling=${IN_FLIGHT_CEILING}`);
// Stopping is only half of it: the abort happens AFTER a concurrency slot is acquired, so a slot
// leaked on that path would starve every later preview and still satisfy the assertion above.
check('previews still load after navigating back (no leaked concurrency slot)', previewsAfterReturn > 0, `previewsAfterReturn=${previewsAfterReturn}`);

console.log(`\n${fails.length === 0 ? 'RESULT: PREVIEW CANCEL PASS \u2713' : `RESULT: ${fails.length} FAILED \u2717`}`);
process.exit(fails.length ? 1 : 0);
