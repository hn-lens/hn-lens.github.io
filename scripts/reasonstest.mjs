// Reasons-wording test — a card's "why recommended" chip must not OVERCLAIM.
//
// authorAffinity/domainAffinity = tanh(score/5). A single strong action (a save is
// score 2 → 0.38) used to clear the 0.3 "often" threshold, so a one-off read as a
// HABIT: "You often engage with X". "Often" now needs enough accumulated affinity to
// reflect repeated engagement (author > 0.55, domain > 0.5); a lone engagement gets a
// softer, honest reason ("…whom you've read" / "…which you've read"). Drives the REAL
// strategies module via window.__hnlens so the wording is asserted against live code.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const page = (await b.newContext({ viewport: { width: 1000, height: 800 } })).pages()[0] || (await b.newPage());
await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.strategies && window.__hnlens.prefs, null, { timeout: 20000 });

const r = await page.evaluate(async () => {
  const strategies = await window.__hnlens.strategies();
  const prefs = window.__hnlens.prefs.getState();
  // No follows / boost keywords so affinity is the ONLY reason source.
  prefs.set({ followedDomains: [], followedUsers: [], keywordsBoost: [], mutedDomains: [], mutedUsers: [], keywordsMute: [] });
  const p = window.__hnlens.prefs.getState();
  // score = affinity magnitude, count = distinct engaged items with that author/domain.
  const mk = (score, count) =>
    strategies.makeContext(p, {
      domains: { 'ex.com': score }, authors: { alice: score },
      domainCounts: { 'ex.com': count }, authorCounts: { alice: count },
    });
  // Old, score-less item so recency/popularity don't dominate — affinity is the top
  // driver, which is exactly when a soft affinity chip is honest to show.
  const oldTime = Math.floor(Date.now() / 1000) - 20 * 86400;
  const item = { id: 1, title: 'A perfectly neutral headline about nothing', url: 'https://ex.com/a', by: 'alice', score: 0, descendants: 0, time: oldTime, type: 'story' };
  const low = strategies.scoreItem(item, mk(2, 1)).reasons; // one engagement (count 1) → affinity 0.38
  const deepOne = strategies.scoreItem(item, mk(6, 1)).reasons; // ONE deeply-read item, high affinity
  const high = strategies.scoreItem(item, mk(6, 3)).reasons; // repeated across 3 items → habit
  return { low, deepOne, high };
});

console.log('  low (count 1):      ', JSON.stringify(r.low));
console.log('  deepOne (count 1):  ', JSON.stringify(r.deepOne));
console.log('  high (count 3):     ', JSON.stringify(r.high));
check('a lone engagement is NOT described as "often"', !r.low.some((t) => /often/i.test(t)), JSON.stringify(r.low));
check('a lone engagement is NOT mislabeled as "read" (it may be a save)', !r.low.some((t) => /you've read|you read/i.test(t)), JSON.stringify(r.low));
check('a lone engagement yields a soft "engaged with" reason', r.low.some((t) => /engaged with/i.test(t)), JSON.stringify(r.low));
check('a SINGLE deeply-read item is NOT "often" even at high affinity', !r.deepOne.some((t) => /often/i.test(t)), JSON.stringify(r.deepOne));
check('repeated engagement across ≥2 items DOES earn an "often" reason', r.high.some((t) => /often/i.test(t)), JSON.stringify(r.high));

// ---- per-author diversity cap: one author can't flood the top ----
const authorCap = await page.evaluate(async () => {
  const s = await window.__hnlens.strategies();
  const mk = (id, by) => ({ item: { id, by, url: `https://d${id}.com/x` }, score: 100 - id, reasons: [] });
  const ranked = [mk(1, 'x'), mk(2, 'x'), mk(3, 'x'), mk(4, 'y'), mk(5, 'x')];
  return s.diversifyByAuthor(ranked, 2).map((r) => `${r.item.id}:${r.item.by}`);
});
const frontX = authorCap.slice(0, 3).filter((s) => s.endsWith(':x')).length;
check('per-author cap keeps ≤2 of one author near the top', frontX <= 2, JSON.stringify(authorCap));
check('per-author cap removes nothing (all 5 still present)', authorCap.length === 5, JSON.stringify(authorCap));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: REASONS TEST PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
