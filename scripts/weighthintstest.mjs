// Hermetic test for the WeightSliders "inactive" hints — a purely DERIVED display
// guarding a documented no-op trap (tuning a signal that's currently zero). The
// audit flagged its hasAffinity/hasModel/embeddingsEnabled logic as untested.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const page = (await b.newContext({ viewport: { width: 1000, height: 1100 } })).pages()[0] || (await b.newPage());
await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs && window.__hnlens.interactions, null, { timeout: 20000 });

// Fresh slate: no events (no affinity), embeddings off, no follows, no model.
await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  await i.clearAllData();
  window.__hnlens.prefs.getState().set({ embeddingsEnabled: false, followedDomains: [], followedUsers: [], useLearnedRanker: true });
});
await page.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
await page.getByText('For You ranking weights').waitFor({ timeout: 15000 });
await page.waitForTimeout(400);

const body = () => page.evaluate(() => document.body.innerText);
// Hint-specific phrasing (avoid matching the "Enable embeddings" toggle / "Train
// from history" button that also live on the Settings page).
const RELEVANCE_HINT = /enable Embeddings in Settings/i;
const LEARNED_HINT = /Train from history.* in Settings/i;
const AFFINITY_HINT = /grows as you follow/i;
let t = await body();
check('affinity shows inactive hint (no data)', AFFINITY_HINT.test(t), '');
check('relevance shows inactive hint (embeddings off)', RELEVANCE_HINT.test(t), '');
check('learned shows inactive hint (no model)', LEARNED_HINT.test(t), '');

// enabling embeddings clears the relevance hint
await page.evaluate(() => window.__hnlens.prefs.getState().set({ embeddingsEnabled: true }));
await page.waitForTimeout(250);
t = await body();
check('relevance hint clears when embeddings enabled', !RELEVANCE_HINT.test(t), '');

// following a domain clears the affinity hint
await page.evaluate(() => window.__hnlens.prefs.getState().set({ followedDomains: ['example.com'] }));
await page.waitForTimeout(250);
t = await body();
check('affinity hint clears when following a domain', !AFFINITY_HINT.test(t), '');

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: WEIGHT HINTS PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
