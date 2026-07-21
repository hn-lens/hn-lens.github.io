// Regression test for the "warming-up / personalization" surface — the class of bugs
// where For You's event-derived signals, the "warming up" banner, and the "Why #N?"
// explainer only reflected engagement AFTER a full page reload, and the explainer told
// the (default-ON) user to "turn on the learned reranker" and "click Train from history"
// (a button that doesn't exist). Covers three fixes:
//
//   FIX 1 (correctness): reading a story MID-SESSION personalizes For You WITHOUT a reload
//     — onEngagement now invalidates ['affinities'] + ['content'], so the banner clears
//     live. (The existing readtest cold-banner check RELOADS, so it can't catch this.)
//   FIX 2 (trust copy): the "Why #N?" learned-model section gives correct guidance —
//     ON-but-untrained says it trains automatically (no "Train from history"); OFF says
//     turn it on. Never the wrong default-state instructions.
//   FIX 3 (progress): the For You sidebar shows learned-reranker progress (N/12 while
//     learning, "personalizing from N" once activated) so the gate isn't invisible.
//
// Drives the REAL app over a mocked HN API. Needs a wide viewport (sidebar is lg+).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const POOL = [11, 12, 13, 14, 15, 16, 17, 18];
const item = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://ex${id}.com/x`, score: 100 + id, descendants: 10 + id, time: now - 3600 });
const byId = new Map(POOL.map((id) => [id, item(id)]));

const fails = [];
const check = (name, pass, detail) => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories|beststories|newstories/.test(u)) return j(POOL);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });

// A clean, cold For You with the learned reranker ON (the default) and no history.
async function coldForYou() {
  await page.evaluate(async () => {
    await (await window.__hnlens.interactions()).clearAllData();
    window.__hnlens.prefs.getState().set({
      defaultFeed: 'foryou', useLearnedRanker: true, embeddingsEnabled: false,
      hideReadInFeed: false, minPoints: 0, followedDomains: [], followedUsers: [], keywordsBoost: [],
    });
    location.hash = '#/';
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
  await page.waitForSelector('article', { timeout: 15000 });
  await page.waitForTimeout(400);
}

const contentText = () => page.evaluate(() => document.querySelector('.app-content')?.innerText ?? document.body.innerText);
const sidebarText = () => page.evaluate(() => document.querySelector('.app-sidebar')?.innerText ?? '');
// Scope to the rank-explain dialog specifically — the comments drawer is also a
// role="dialog" (aria-label="Discussion") and is always mounted, so a bare
// [role="dialog"] selector would grab the wrong one.
const WHY_DIALOG = '[role="dialog"][aria-label^="Why this story is ranked"]';
async function openWhyDialog() {
  await page.locator('.sc-reasons button:has-text("Why #")').first().click();
  await page.waitForSelector(WHY_DIALOG, { timeout: 8000 });
  await page.waitForTimeout(150);
  return page.evaluate((s) => document.querySelector(s)?.innerText ?? '', WHY_DIALOG);
}
async function closeDialog() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

// ============================================================================
// FIX 2 — the "Why #N?" learned-model copy is correct when the reranker is ON but
// not yet trained (the default new-user state).
// ============================================================================
await coldForYou();
check('cold For You shows the "warming up" banner', /warming up/i.test(await contentText()), '');

const whyOn = await openWhyDialog();
check('Why dialog (reranker ON, untrained): says it trains automatically', /trains itself automatically|activates once it has/i.test(whyOn), whyOn.slice(0, 160).replace(/\s+/g, ' '));
check('Why dialog (ON): does NOT tell the user to "Train from history" (no such button)', !/train from history/i.test(whyOn), '');
check('Why dialog (ON): does NOT say the reranker is turned off (it is on)', !/turned off/i.test(whyOn), '');
await closeDialog();

// ============================================================================
// FIX 1 — reading a story MID-SESSION personalizes For You with NO reload: the
// "warming up" banner clears once affinities/content are invalidated on engagement.
// ============================================================================
check('precondition: banner still shown before any engagement', /warming up/i.test(await contentText()), '');
// Genuinely read two pool stories (open_link + a >=BOUNCE_MS dwell) — creates real
// domain/author affinity and fires onEngagement (which now invalidates affinities/content).
await page.evaluate(() => {
  const i = window.__hnlens.interactions();
  for (const id of [11, 12]) {
    const it = { id, title: `Story ${id}`, url: `https://ex${id}.com/x`, by: `u${id}` };
    i.trackForItem('open_link', it);
    i.trackForItem('dwell', it, { value: 12000 });
  }
});
// NO reload — poll for the banner to clear (this is the whole point: it must update live).
let bannerCleared = false;
for (let t = 0; t < 24; t++) {
  if (!/warming up/i.test(await contentText())) { bannerCleared = true; break; }
  await page.waitForTimeout(250);
}
check('FIX 1: reading mid-session clears the "warming up" banner WITHOUT a reload', bannerCleared, '');

// And the "Why #N?" for the engaged domain now shows a real personal signal, not the
// false "No personal signals for this story yet".
const whyAfter = await openWhyDialog();
check('FIX 1: "Why #N?" reflects the recorded engagement live (a data signal is shown)', /you engage with|you follow|title matches|similar to stories you read|overlap terms/i.test(whyAfter), whyAfter.slice(0, 200).replace(/\s+/g, ' '));
await closeDialog();

// ============================================================================
// FIX 2 (OFF branch) — with the reranker turned OFF, the explainer says to turn it on
// (and still never mentions a "Train from history" button).
// ============================================================================
await page.evaluate(() => window.__hnlens.prefs.getState().set({ useLearnedRanker: false }));
await page.waitForTimeout(200);
const whyOff = await openWhyDialog();
check('Why dialog (reranker OFF): says the reranker is turned off', /turned off|isn.t contributing|turn on/i.test(whyOff), whyOff.slice(0, 160).replace(/\s+/g, ' '));
check('Why dialog (OFF): still no "Train from history" instruction', !/train from history/i.test(whyOff), '');
await closeDialog();

// ============================================================================
// FIX 3 — the For You sidebar shows learned-reranker PROGRESS toward the gate.
// ============================================================================
// (a) Cold + reranker ON → "Learning your taste — N/12".
await coldForYou();
const sbCold = await sidebarText();
check('FIX 3: sidebar shows learning progress toward the gate ("… /12")', /learning your taste/i.test(sbCold) && /\/\s*12/.test(sbCold), sbCold.split('\n').find((l) => /learning your taste/i.test(l)) ?? sbCold.slice(0, 120));
check('FIX 3: sidebar does NOT claim it is activated yet', !/reranker on|tuned to/i.test(sbCold), '');

// (b) Seed a trained model past the gate → "personalizing from N interactions".
await page.evaluate(async () => {
  const interactions = await window.__hnlens.interactions();
  await interactions.clearAllData(); // clears kv (incl. any model) — seed AFTER this
  window.__hnlens.prefs.getState().set({ defaultFeed: 'foryou', useLearnedRanker: true, embeddingsEnabled: false, hideReadInFeed: false, minPoints: 0 });
  const logistic = window.__hnlens.logistic();
  const m = await logistic.loadModel(); // default shape with a full-length weight vector
  m.n = 20;
  m.updatedAt = Date.now();
  await logistic.saveModel(m);
  location.hash = '#/';
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(400);
const sbActive = await sidebarText();
check('FIX 3: once trained past the gate, sidebar says the reranker is on (tuned to N)', /reranker on/i.test(sbActive) && /\b20\b/.test(sbActive), sbActive.split('\n').find((l) => /reranker on|tuned to/i.test(l)) ?? sbActive.slice(0, 120));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: PERSONALIZE LIVE-UPDATE PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
