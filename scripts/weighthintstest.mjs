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
// Hint-specific phrasing (avoid matching the "Enable embeddings" toggle / "Retrain now"
// button that also live on the Settings page). The learned hint says the reranker trains
// itself automatically as you read (there is NO "Train from history" button).
const RELEVANCE_HINT = /enable Embeddings in Settings/i;
const LEARNED_HINT = /trains itself automatically.*Retrain now/i;
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

// --- Ranker-gate regression (c2r2 + c2r3): the learned-slider hint must match the EXACT gate
// useFeed uses for the feed — activeModel = useLearnedRanker ? model : undefined, applied only
// when rankerTrained() (enough samples AND >=MIN_TRAIN_POSITIVES). So the hint is present unless
// BOTH the toggle is on AND the model is trained. Two past bugs: (c2r2) it keyed on n>0 so a
// single sample falsely cleared it; (c2r3) it ignored useLearnedRanker so a trained-but-toggled-
// off model looked "active" while the feed + "Why #N?" said it was off. Seed the model directly
// (autotrain can't clobber it: with 0 events isStale() is false, so it skips), reload Settings so
// startup re-primes ['ranker'] from loadModel, and read the hint.
const LEARNED_OFF_HINT = /turn on the Learned reranker/i;
const seedModel = async (n, pos, learnedOn) => {
  await page.evaluate(
    async ([nn, pp, on]) => {
      const l = await window.__hnlens.logistic();
      window.__hnlens.prefs.getState().set({ useLearnedRanker: on });
      const m = l.emptyModel();
      m.n = nn;
      m.pos = pp;
      m.updatedAt = Date.now();
      // `emptyModel()` has an ALL-ZERO weight vector, which is degenerate — it scores every story
      // identically and cannot move a card, so `rankerTrained` rightly reports it as untrained. A
      // real trained model has weights; seed one so this fixture represents a trained state.
      if (nn > 0) m.w = m.w.map((_, k) => (k === 6 ? 1.8 : 0));
      await l.saveModel(m);
    },
    [n, pos, learnedOn]
  );
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
  await page.getByText('For You ranking weights').waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  return body();
};

// enough samples but too few positives, reranker ON ⇒ NOT trained ⇒ "trains itself" hint STAYS
// (the c2r2 bug cleared it as soon as n>0).
t = await seedModel(14, 1, true);
check('learned hint STAYS with samples but too few positives (not rankerTrained)', LEARNED_HINT.test(t), 'n=14 pos=1 ON');
// The Settings "Learned reranker" STATUS line (7th ranker-gate surface, c2r3/c2r4) must ALSO
// reflect the gate — a below-gate model must NOT read as active/"trained on N examples".
check('reranker status line reads "Still learning" below the gate (not active)', /Still learning/.test(t) && !/personalizing from/.test(t), '');

// trained AND reranker ON ⇒ fully active ⇒ no learned hint at all.
t = await seedModel(20, 8, true);
check('learned hint clears when trained and reranker ON', !LEARNED_HINT.test(t) && !LEARNED_OFF_HINT.test(t), 'n=20 pos=8 ON');
check('reranker status line reads "Active · personalizing" when trained', /Active · personalizing from/.test(t), '');

// trained BUT reranker toggled OFF ⇒ the slider weight is a no-op ⇒ an inactive "turn on" hint
// shows (the c2r3 bug: it looked active while the feed ignored it).
t = await seedModel(20, 8, false);
check('learned hint shows "turn on" when trained but reranker OFF', LEARNED_OFF_HINT.test(t), 'n=20 pos=8 OFF');
// The Settings STATUS line must ALSO honor the toggle (c2r5 bug: it read "Active · personalizing"
// with a trained model while the toggle was OFF — the c2r4 gate fix consulted rankerTrained but
// not useLearnedRanker, the OTHER half of the feed's activeModel gate).
check('reranker status line reads "Off" (not Active) when trained but toggled OFF', /Off · trained on/.test(t) && !/Active · personalizing/.test(t), '');

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: WEIGHT HINTS PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
