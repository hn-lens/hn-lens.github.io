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
  await page.locator('.sc-actions button[aria-label^="Why #"]').first().click();
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
check('Why dialog (reranker ON, untrained): says it trains automatically', /retrains in the background|activates once it has/i.test(whyOn), whyOn.slice(0, 160).replace(/\s+/g, ' '));
// SPEC §2.4: retraining runs only while the tab is HIDDEN, so a reader who never backgrounds the tab
// is never trained by it. Copy promising it trains "as you read" is false for exactly that reader,
// and "no manual step" additionally denies the one control that always works.
// Scoped to a TRAINING claim: "Position is not re-sorted as you read" is a different sentence, and
// it is true (SPEC §2.3). Only "…trains… as you read" is the false one.
check('Why dialog: does NOT promise training happens "as you read"', !/trains?[^.]{0,40}as you read/i.test(whyOn), '');
check('Why dialog: does NOT deny the manual retrain path', !/no manual step/i.test(whyOn), '');
check('Why dialog: names "Retrain now", the control that always works', /retrain now/i.test(whyOn), '');
check('Why dialog (ON): does NOT tell the user to "Train from history" (no such button)', !/train from history/i.test(whyOn), '');
check('Why dialog (ON): does NOT say the reranker is turned off (it is on)', !/turned off/i.test(whyOn), '');
// The cold-start user here has only scrolled (impressions), read nothing. The interaction COUNT is
// not the read count, so the copy must not present it as "stories you've actually read (you have N)".
// It counts interactions against the sample gate instead.
check(
  'Why dialog (ON, untrained): does NOT label the interaction count as stories read',
  !/actually read \(you have/i.test(whyOn),
  whyOn.slice(0, 200).replace(/\s+/g, ' ')
);
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
// FIX 1b — Undo of "Not interested" must live-update For You the SAME way reading does. The Undo
// cancels the hide's affinity in the DATA (feedstabilitytest proves that), but the FEED only
// re-ranks live if the `unhide` event fires onEngagement (→ main.tsx invalidates ['affinities']/
// ['content']). Pre-fix `unhide` was NOT in ENGAGEMENT_TYPES, so Undo left the story BURIED by the
// stale −2.5 until a manual Refresh/reload. Assert the listener actually fires on an unhide.
// ============================================================================
const unhideFires = await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  let fired = false;
  const off = i.onEngagement(() => { fired = true; });
  i.track({ type: 'unhide', itemId: 999001, domain: 'ex11.com', author: 'u11' });
  off();
  return fired;
});
check('FIX 1b: an unhide (Undo) fires onEngagement → For You re-ranks live (not stale until reload)', unhideFires, '');

// ============================================================================
// FIX 2 (OFF branch) — with the reranker turned OFF, the explainer says to turn it on
// (and still never mentions a "Train from history" button).
// ============================================================================
await page.evaluate(() => window.__hnlens.prefs.getState().set({ useLearnedRanker: false }));
await page.waitForTimeout(200);
const whyOff = await openWhyDialog();
check('Why dialog (reranker OFF): says the reranker is turned off', /turned off|isn.t contributing|turn on/i.test(whyOff), whyOff.slice(0, 160).replace(/\s+/g, ' '));
check('Why dialog (OFF): still no "Train from history" instruction', !/train from history/i.test(whyOff), '');
// SPEC §2.4: retraining is a background task; no reranker-state copy may promise it "trains itself
// automatically" (the OFF branch used to), which reads as passive training while the reader watches.
check('Why dialog (OFF): does NOT claim it "trains itself automatically"', !/trains?\s+itself\s+automatically/i.test(whyOff), whyOff.replace(/\s+/g, ' ').slice(0, 160));
await closeDialog();

// ============================================================================
// FIX 3 — the For You sidebar shows learned-reranker PROGRESS toward the gate.
// ============================================================================
// (a) Cold + reranker ON → "Learning your taste — N/12".
await coldForYou();
const sbCold = await sidebarText();
check('FIX 3: sidebar shows learning progress toward the gate ("… /12")', /learning your taste/i.test(sbCold) && /\/\s*12/.test(sbCold), sbCold.split('\n').find((l) => /learning your taste/i.test(l)) ?? sbCold.slice(0, 120));
check('FIX 3: sidebar does NOT claim it is activated yet', !/reranker on|tuned to/i.test(sbCold), '');
// Same SPEC §2.4 honesty rule as the Why dialog, on the surface that shows the stuck counter.
check('sidebar does NOT promise training happens "as you read"', !/as you read/i.test(sbCold), sbCold.split('\n').find((l) => /as you read/i.test(l)) ?? '');
check('sidebar names "Retrain now" beside the progress it is stuck on', /retrain now/i.test(sbCold), '');

// (b) Seed a trained model past the gate → "personalizing from N examples from your activity".
await page.evaluate(async () => {
  const interactions = await window.__hnlens.interactions();
  await interactions.clearAllData(); // clears kv (incl. any model) — seed AFTER this
  window.__hnlens.prefs.getState().set({ defaultFeed: 'foryou', useLearnedRanker: true, embeddingsEnabled: false, hideReadInFeed: false, minPoints: 0 });
  const logistic = window.__hnlens.logistic();
  const m = await logistic.loadModel(); // default shape with a full-length weight vector
  m.n = 20;
  m.pos = 8; // enough POSITIVES: the sidebar uses the same rankerTrained() gate as scoring,
  m.updatedAt = Date.now(); // which requires n>=12 AND pos>=3 (not samples alone)…
  // …and at least one NON-ZERO weight. A freshly-loaded default model is all zeros, which is
  // degenerate — it scores every story identically and cannot move a card — so the gate rightly
  // treats it as untrained. A real trained model has weights; seed one.
  m.w = m.w.map((_, k) => (k === 6 ? 1.8 : 0));
  await logistic.saveModel(m);
  location.hash = '#/';
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(400);
const sbActive = await sidebarText();
check('FIX 3: once trained past the gate, sidebar says the reranker is on (tuned to N)', /reranker on/i.test(sbActive) && /\b20\b/.test(sbActive), sbActive.split('\n').find((l) => /reranker on|tuned to/i.test(l)) ?? sbActive.slice(0, 120));

// (c) POSITIVES GATE: a model with enough SAMPLES (n>=12) but too few POSITIVES (pos<3) is
// NOT applied by scoring (rankerTrained), so the sidebar must NOT claim it's on — it must
// match the explainer/scoring, which use the same gate (regression for the sidebar-copy bug
// where the sidebar keyed off model.n alone and falsely said "on" for a passive scroller).
await page.evaluate(async () => {
  const logistic = window.__hnlens.logistic();
  const m = await logistic.loadModel();
  m.n = 15;
  m.pos = 1; // below MIN_TRAIN_POSITIVES (3)
  m.updatedAt = Date.now();
  await logistic.saveModel(m);
  location.hash = '#/';
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(400);
const sbFewPos = await sidebarText();
check(
  'sidebar does NOT claim the reranker is on when positives < gate (n>=12, pos<3)',
  !/reranker on|tuned to/i.test(sbFewPos) && /learning your taste/i.test(sbFewPos),
  sbFewPos.split('\n').find((l) => /reranker|learning/i.test(l)) ?? sbFewPos.slice(0, 120)
);
// The Why-dialog too-few-positives branch must use the SAME background/Retrain framing as the
// too-few-samples branch, not a divergent "activates automatically" that implies passive training
// while the reader stays in the tab (SPEC §2.4).
const whyFewPos = await openWhyDialog();
check('Why dialog (too-few-positives): describes retrain via background/Retrain, not passive "as you read"',
  !/(?:re)?trains?\b[^.]{0,40}\bas you (?:browse|read)\b/i.test(whyFewPos) &&
    (!/(activat|retrain|trains?\b)/i.test(whyFewPos) || /background|retrain now/i.test(whyFewPos)),
  whyFewPos.replace(/\s+/g, ' ').slice(0, 180));
await closeDialog();

// ============================================================================
// RE-CENTERED learned signal + explicit BASELINE bar (resolves the "positive features but negative
// result" confusion): the learned signal is centered on YOUR base engagement rate (pos/n), so a
// typical story reads ~0 (not a confusing strong negative), and "Inside the learned model" shows the
// model bias as an explicit "Baseline" bar so features + baseline reconcile to the shown P(engage).
// ============================================================================
await page.evaluate(async () => {
  const logistic = window.__hnlens.logistic();
  const m = await logistic.loadModel();
  m.w = [1.5, 0.5, 2.1, 1.4, 0, 0, 0, 0, 1.8, 0]; // positive feature weights
  m.b = -4.2; // strong negative bias = low base rate
  m.n = 322;
  m.pos = 30; // baseRate = 30/322 ≈ 9%
  m.updatedAt = Date.now();
  await logistic.saveModel(m);
  location.hash = '#/';
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(400);
const whyBase = await openWhyDialog();
check('Why dialog shows an explicit "Baseline" bar in the learned model', /Baseline/i.test(whyBase), whyBase.replace(/\s+/g, ' ').slice(0, 220));
// The rate must be DISCLOSED, and the surrounding words must stay TRUE at any rate: the copy used
// to hardcode "you rarely engage" / "only ~N%", which for an avid reader rendered "you engage with
// only ~90% of stories" beside a bar labelled "you rarely engage" — the trust surface contradicting
// itself. Assert the disclosure, and assert the low-rate wording only appears for a LOW rate.
// The percentage shown to the user must be their ACTUAL engagement rate (positives/samples), not
// the internal centring reference the signed bar is measured against (the ranked pool's median
// prediction). Those became two different numbers when the centring moved to the pool, and the copy
// kept describing the centring value as "how often you engage" — a false statement ABOUT THE USER.
check('Why dialog discloses the base engagement rate (~N%)', /you engage with about \d+%/i.test(whyBase), (/(you engage with about \d+%)/i.exec(whyBase) || [])[1] || '(missing)');
check('the disclosed rate is the TRUE engagement rate, not the centring value',
  Number((/you engage with about (\d+)%/i.exec(whyBase) || [])[1] ?? -1) === Math.round((30 / 322) * 100),
  `shown=${(/you engage with about (\d+)%/i.exec(whyBase) || [])[1]} expected=${Math.round((30 / 322) * 100)}`);
// The stated composition rule must be the rule actually used: the bars are log-odds and the estimate
// is their sigmoid — telling a reader they "sum to that estimate" makes them add -0.43 next to "40%".
// It must name the UNITS (log-odds, not percentages) and must NOT claim the baseline "matches" the
// engagement rate — the bar is a fitted intercept in log-odds and the rate is a probability; they
// differed by 15-83 points, so "a matching baseline" was false in the panel's own numbers.
// The stated composition rule must match what the bars ACTUALLY are. They are each feature's share
// of the score-table figure and add up to it — so the panel must say that, and must NOT claim the
// older shapes (raw log-odds that "convert to" the %, bars that "sum to that estimate", or a
// baseline that "matches" the engagement rate), all of which left the reader with a total that
// appeared nowhere in the panel.
check('the panel states the REAL composition rule (shares that add up to the score-table figure)',
  /add up to it/i.test(whyBase) &&
    !/sum to that estimate/i.test(whyBase) &&
    !/matching\s+baseline/i.test(whyBase),
  whyBase.replace(/\s+/g, ' ').slice(0, 160));
{
  const pct = Number((/engage with about (\d+)% of stories/.exec(whyBase) || [])[1] ?? '-1');
  const saysRarely = /rarely engage/.test(whyBase);
  check('the "rarely engage" wording only appears when the rate really is low',
    pct < 0 || (pct < 35 ? saysRarely : !saysRarely), `rate=${pct}% saysRarely=${saysRarely}`);
}
// Each sentence must be conditioned on the thing it CLAIMS, not on a loosely-related quantity.
// Two ways this panel used to contradict the numbers printed directly beneath it:
//  - the "mostly-positive features can still land below 50%" clause was gated on the USER'S overall
//    engagement rate, so a balanced or avid reader saw it beside a ~95% estimate (and a selective
//    reader with a high estimate got it too), explaining an outcome that was not on screen;
//  - the "each bar below … they add up to it" promise was unconditional, so a story whose features
//    are all neutral rendered that sentence, a dangling colon, and then "All features are neutral".
{
  const shown = Number((/predicts[^~]*~(\d+)%/.exec(whyBase) || [])[1] ?? '-1');
  const saysBelow = /can still land below 50%/.test(whyBase);
  check(
    'the "below 50%" clause only appears when the DISPLAYED estimate is actually below 50%',
    shown < 0 || (shown < 50 ? true : !saysBelow),
    `displayed=${shown}% saysBelow=${saysBelow}`
  );
  const promisesBars = /add up to it/.test(whyBase);
  const saysNeutral = /All features are neutral/.test(whyBase);
  check(
    'the panel never promises bars and then renders none',
    !(promisesBars && saysNeutral),
    `promisesBars=${promisesBars} saysNeutral=${saysNeutral}`
  );
}
await closeDialog();
// Unit: the learned signal is centered at the base rate (pos/n), NOT an absolute 0.5.
const baseRate = await page.evaluate(async () => {
  const S = await window.__hnlens.strategies();
  const model = await window.__hnlens.logistic().loadModel();
  return S.learnedBaseRate(model);
});
check('learnedBaseRate is centered on pos/n (re-centered, not 0.5)', Math.abs(baseRate - 30 / 322) < 1e-9, `baseRate=${baseRate}`);

// --- the RENDERED model bars must ADD UP to the score-table's "Learned model" figure ---
// Regression for the cross-section reconciliation gap: each half of the panel was internally exact
// (bars → log-odds sum → the % shown beside them; score table → weight × pull), but the LINK between
// them was never displayed, so a reader adding the bars got a number that appeared nowhere — the
// bars summed to -1.90 next to a stated +0.22. The bars are now each feature's share of that figure.
// Swept across learned weights because scaling to the bare pull instead of the WEIGHTED contribution
// matches only at the default 1.0 — the shape that would hide this again.
for (const lw of [0.8, 1.0, 2.5]) {
  await page.evaluate((w) => {
    const st = window.__hnlens.prefs.getState();
    st.set({ weights: { ...st.weights, learned: w } });
  }, lw);
  await page.waitForTimeout(250);
  await page.locator('.sc-actions button[aria-label^="Why #"]').first().click();
  await page.waitForSelector('[role="dialog"][aria-label^="Why this story is ranked"]', { timeout: 8000 });
  await page.waitForTimeout(250);
  const txt = await page.locator('[role="dialog"][aria-label^="Why this story is ranked"]').innerText();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const lines = txt.split('\n');
  const li = lines.findIndex((l) => l.startsWith('Learned model'));
  const shown = Number((/([+-]?\d+\.\d+)/.exec(lines.slice(li, li + 3).join(' ')) || [])[1]);
  const block = txt.split('Inside the learned model')[1]?.split('The data behind it')[0] ?? '';
  const bars = [...block.matchAll(/^([A-Za-z][^\n]*?)\s+([+-]?\d+\.\d+)\s*$/gm)].map((x) => Number(x[2]));
  const sum = Math.round(bars.reduce((a, v) => a + v, 0) * 100) / 100;
  check(`learned bars sum EXACTLY to the score-table figure (weight ${lw})`,
    bars.length > 0 && Number.isFinite(shown) && Math.abs(sum - shown) < 0.005,
    `bars=${bars.length} sum=${sum} shown=${shown}`);
  check(`model bars don't print a (w×v) formula that contradicts them (weight ${lw})`,
    !/\(\d+\.\d+×/.test(block), block.slice(0, 80));
  // The prose names the Baseline bar, so it must ALWAYS be on screen — including when it rounds to
  // ~0 (which is itself the meaningful "this story starts where a typical one does"). Filtering
  // near-zero bars left the paragraph describing an element that wasn't rendered.
  check(`the Baseline bar the copy references is actually rendered (weight ${lw})`,
    /Baseline/.test(block), block.slice(0, 80));
  // Never juxtapose an ABSOLUTE probability with the user's own engagement rate and no conversion —
  // different reference frames (the pull is centred on the pool, the rate is not), which invites
  // exactly the comparison the model does not make.
  // The absolute prediction and the user's lifetime rate are DIFFERENT reference frames; showing
  // them side by side with no third number invites a comparison the ranking never makes. The panel
  // must therefore also state what a TYPICAL story in this feed scores — that is the frame the bars
  // and the pull actually use.
  check(`the panel gives the pool frame, not just an absolute % vs the user's rate (weight ${lw})`,
    /for a typical story in this feed/i.test(txt), txt.replace(/\s+/g, ' ').slice(0, 120));
}

// ============================================================================
// Settings reranker description (SPEC §2.4). The screen the three corrected in-app strings redirect
// the reader to must not itself promise passive "as you browse/read" training, and must point at the
// control that actually works. This was the authoritative description the earlier fix missed.
// ============================================================================
await page.evaluate(() => { location.hash = '#/settings'; });
await page.waitForTimeout(500);
const settingsText = await page.evaluate(() => document.querySelector('.app-content')?.innerText ?? document.body.innerText);
check('Settings reranker copy does NOT promise training "as you browse/read"',
  !/(?:re)?trains?\b[^.]{0,40}\bas you (?:browse|read)\b/i.test(settingsText),
  (settingsText.match(/[^.]*\bas you (?:browse|read)\b[^.]*/i) || [''])[0].trim().slice(0, 160));
check('Settings reranker copy does NOT claim it "trains itself automatically"',
  !/trains?\s+itself\s+automatically/i.test(settingsText), '');
check('Settings names "Retrain" (the control that always works)', /retrain/i.test(settingsText), '');

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: PERSONALIZE LIVE-UPDATE PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
