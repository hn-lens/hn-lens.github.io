// TRAINING-LABEL test — how interaction history becomes logistic-regression labels.
// Regression for the bug where `open_comments` was an UNCONDITIONAL strong positive, so
// merely opening a discussion (a glance/summarize-and-leave) trained the model TOWARD that
// story — even though the article path was already dwell-aware. Now a discussion counts as a
// positive ONLY with a genuine >= BOUNCE_MS stay (a dwell{where:'comments'}); a glance does
// not. Drives the REAL buildTrainingSamples() via window.__hnlens.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());

// Items must be in the LOCAL item cache for buildTrainingSamples to build their features: training
// is CACHE-ONLY by design (it runs in the background after every engagement and must do no network
// I/O), so seeding only events is not a realistic fixture — in the real app you can only engage with
// a story that was fetched and cached at that moment. The firebase route below stays for any
// incidental fetch, but the cache seed is what training actually reads.
const IDS = [90101, 90102, 90103, 90104, 90105, 90106, 90107, 90108, 90109];
const item = (id) => ({ id, type: 'story', by: `u${id}`, title: `Story ${id} about rust and wasm`, url: `https://ex${id}.com/x`, score: 100, descendants: 5, time: now - 3600 });
const byId = new Map(IDS.map((id) => [id, item(id)]));
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });

const labels = await page.evaluate(async ({ ids, t0 }) => {
  const i = await window.__hnlens.interactions();
  await i.clearAllData();
  window.__hnlens.prefs.getState().set({ embeddingsEnabled: false, fetchArticleText: false, useLearnedRanker: true });
  const { db } = await window.__hnlens.db();
  const nowS = Math.floor(Date.now() / 1000);
  await db.items.bulkPut(
    ids.map((id) => ({
      id,
      item: { id, type: 'story', by: `u${id}`, title: `Story ${id} about rust and wasm`, url: `https://ex${id}.com/x`, score: 100, descendants: 5, time: nowS - 3600 },
      cachedAt: Date.now(),
    }))
  );
  const ms = (s) => (t0 - s) * 1000;
  const [A, B, C, D, E, F, G, H, I] = ids;
  await db.events.bulkAdd([
    // A: opened the discussion AND STAYED (>= BOUNCE_MS) -> POSITIVE
    { type: 'impression', itemId: A, ts: ms(100) },
    { type: 'open_comments', itemId: A, ts: ms(90) },
    { type: 'dwell', itemId: A, value: 12000, meta: { where: 'comments' }, ts: ms(80) },
    // B: opened the discussion, GLANCE/bounce (no stay dwell) -> NOT a positive
    { type: 'impression', itemId: B, ts: ms(70) },
    { type: 'open_comments', itemId: B, ts: ms(60) },
    // C: impression only (skipped) -> NEGATIVE
    { type: 'impression', itemId: C, ts: ms(50) },
    // D: saved (deliberate strong action) -> POSITIVE
    { type: 'impression', itemId: D, ts: ms(40) },
    { type: 'save', itemId: D, ts: ms(30) },
    // E: read the article (>= BOUNCE_MS) then LATER re-clicked and bounced -> POSITIVE
    //    (a genuine read is MONOTONIC — a later bounce must not flip it to a negative)
    { type: 'impression', itemId: E, ts: ms(28) },
    { type: 'open_link', itemId: E, ts: ms(26) },
    { type: 'dwell', itemId: E, value: 15000, ts: ms(24) },
    { type: 'open_link', itemId: E, ts: ms(12) },
    { type: 'dwell', itemId: E, value: 2000, ts: ms(10) },
    // F: opened the article and BOUNCED, never read -> NEGATIVE
    { type: 'impression', itemId: F, ts: ms(8) },
    { type: 'open_link', itemId: F, ts: ms(6) },
    { type: 'dwell', itemId: F, value: 2000, ts: ms(4) },
    // G: an IMPORTED commented thread (HN-history import) -> POSITIVE (declared engagement:
    //    the user commented there; unlike an in-app glance, an import has no dwell to prove a stay)
    { type: 'open_comments', itemId: G, meta: { source: 'hn_import' }, ts: ms(2) },
    // H: an IMPORTED post (HN-history import) LATER re-clicked in-app and BOUNCED -> POSITIVE.
    //    Declared engagement (the user submitted it) is MONOTONIC and SYMMETRIC with an imported
    //    comment (G): a later in-app bounce must not flip your own submitted post to a negative.
    { type: 'open_link', itemId: H, meta: { source: 'hn_import' }, ts: ms(120) },
    { type: 'impression', itemId: H, ts: ms(5) },
    { type: 'open_link', itemId: H, ts: ms(4) },
    { type: 'dwell', itemId: H, value: 2000, ts: ms(3) },
    // I: READ the article (>= BOUNCE) then HID it then UNDID (unhide) -> POSITIVE again.
    //    Undo of "Not interested" must reverse the hide in the TRAINING labels too (classifyEngagement
    //    unhide handling) — else a read→hid→un-hid story stays a permanent negative.
    { type: 'impression', itemId: I, ts: ms(20) },
    { type: 'open_link', itemId: I, ts: ms(18) },
    { type: 'dwell', itemId: I, value: 15000, ts: ms(16) },
    { type: 'hide', itemId: I, ts: ms(14) },
    { type: 'unhide', itemId: I, ts: ms(12) },
  ]);
  const train = await window.__hnlens.train();
  const r = await train.buildTrainingSamples();
  const labelOf = (id) => {
    const idx = r.sampleIds.indexOf(id);
    return idx === -1 ? null : r.samples[idx].y;
  };
  // The content profile's LIKED set MUST be the SAME dwell-aware engaged set as the labels
  // (shared classifyEngagement) — a bounce/glance must not leak into the liked profile.
  const engagedIds = await i.getEngagedItemIds();
  return { A: labelOf(A), B: labelOf(B), C: labelOf(C), D: labelOf(D), E: labelOf(E), F: labelOf(F), G: labelOf(G), H: labelOf(H), I: labelOf(I), positives: r.positives, negatives: r.negatives, engagedIds };
}, { ids: IDS, t0: now });

check('discussion STAY (open_comments + >=BOUNCE dwell) is a POSITIVE', labels.A === 1, JSON.stringify(labels));
check('discussion GLANCE (open_comments, no stay) is NOT a positive', labels.B !== 1, `label=${labels.B}`);
check('a glanced-but-impressed story is a NEGATIVE', labels.B === 0, `label=${labels.B}`);
check('impression-only story is a NEGATIVE', labels.C === 0, `label=${labels.C}`);
check('a saved story is a POSITIVE', labels.D === 1, `label=${labels.D}`);
check('a READ article re-clicked+bounced stays a POSITIVE (monotonic)', labels.E === 1, `label=${labels.E}`);
check('an article opened+bounced (never read) is a NEGATIVE', labels.F === 0, `label=${labels.F}`);
check('an IMPORTED commented thread is a POSITIVE (declared engagement)', labels.G === 1, `label=${labels.G}`);
check('an IMPORTED post re-clicked+bounced stays a POSITIVE (monotonic, symmetric with G)', labels.H === 1, `label=${labels.H}`);
check('a READ article HID then UNDONE is a POSITIVE again (Undo reverses the training label)', labels.I === 1, `label=${labels.I}`);

// The CONTENT PROFILE's liked set (getEngagedItemIds) must be the SAME dwell-aware set as the
// positive labels — a bounced article / glanced discussion must NOT leak into the liked profile
// (else its terms rank that topic UP, contradicting the negative label). Regression for that drift.
const [A, B, C, D, E, F, G, H, I] = IDS;
const eng = new Set(labels.engagedIds || []);
check('content-profile engaged set INCLUDES the dwell-aware positives (A,D,E,G,H,I)', [A, D, E, G, H, I].every((id) => eng.has(id)), JSON.stringify(labels.engagedIds));
check('content-profile engaged set EXCLUDES the glance/impression/bounce (B,C,F)', [B, C, F].every((id) => !eng.has(id)), JSON.stringify(labels.engagedIds));

// --- TRAINING FEATURES MUST NOT ENCODE THE ROW'S OWN LABEL (leave-one-out for affinity) ---
// Regression for: content features were leave-one-out but BEHAVIOURAL ones were not, so a positive
// row's domain/author affinity was largely a function of its own open+dwell events — i.e. of y.
// The pairwise ranker separated the classes on a feature that is ~0 at SERVE time for an unfamiliar
// source (weights 5.5 vs 1.2 for content), so For You went inert on any new domain at ANY slider
// setting. Serve time must be UNCHANGED: there, all history legitimately counts.
const loo = await page.evaluate(async () => {
  const i = await window.__hnlens.interactions();
  const dbMod = await window.__hnlens.db();
  const train = window.__hnlens.train();
  const feats = window.__hnlens.features();
  const strat = window.__hnlens.strategies();
  await i.clearAllData();
  window.__hnlens.prefs.getState().set({ embeddingsEnabled: false, fetchArticleText: false });
  const t = Date.now(), nowS = Math.floor(t / 1000);
  const mk = (id, dom, by) => ({ id, type: 'story', by, title: `Story ${id} about widgets`, url: `https://${dom}/x`, score: 50, descendants: 4, time: nowS - 3600 });
  // ONE positive, alone on its domain/author, plus an impressed negative elsewhere.
  const items = [mk(6001, 'solo.example', 'soloauthor'), mk(6009, 'other.example', 'otherauthor')];
  await dbMod.db.items.bulkPut(items.map((it) => ({ id: it.id, item: it, cachedAt: t })));
  await dbMod.db.events.bulkAdd([
    { type: 'impression', itemId: 6001, domain: 'solo.example', author: 'soloauthor', ts: t - 50000 },
    { type: 'open_link', itemId: 6001, domain: 'solo.example', author: 'soloauthor', ts: t - 49000 },
    { type: 'dwell', itemId: 6001, domain: 'solo.example', author: 'soloauthor', value: 70000, ts: t - 48000 },
    { type: 'impression', itemId: 6009, domain: 'other.example', author: 'otherauthor', ts: t - 47000 },
  ]);
  const { samples, sampleIds } = await train.buildTrainingSamples();
  const k = sampleIds.indexOf(6001);
  // feature indices: 3 = domainAffinity, 4 = authorAffinity
  const trainDom = k < 0 ? null : samples[k].x[3];
  const trainAuth = k < 0 ? null : samples[k].x[4];
  // SERVE time must still see the affinity (all history counts there)
  const ctx = strat.makeContext(window.__hnlens.prefs.getState(), await i.computeAffinities(), {});
  const serveDom = feats.computeFeatures(items[0], ctx).domainAffinity;
  // a DIFFERENT story on the same domain/author must still benefit from the engagement
  const sib = { ...items[0], id: 6002 };
  const serveSibling = feats.computeFeatures(sib, ctx).domainAffinity;
  return { trainDom, trainAuth, serveDom, serveSibling };
});
check('a positive row does NOT see its OWN engagement in domainAffinity (leave-one-out)',
  loo.trainDom !== null && Math.abs(loo.trainDom) < 1e-9, `trainDomainAffinity=${loo.trainDom}`);
check('…nor in authorAffinity', loo.trainAuth !== null && Math.abs(loo.trainAuth) < 1e-9, `trainAuthorAffinity=${loo.trainAuth}`);
// Leave-one-out now applies at SERVE time too (a story must not be ranked up by the engagement it
// itself produced), so the scored item legitimately sees 0 for its own domain. What must still hold
// is that the affinity TRANSFERS: a DIFFERENT story on that same domain still benefits.
check('SERVE-time: the engaged item itself gets no affinity from its own events',
  Math.abs(loo.serveDom) < 1e-9, `serveDomainAffinity=${loo.serveDom}`);
check('SERVE-time: a SIBLING on the same domain still gains affinity (taste transfers)',
  loo.serveSibling > 0.1, `siblingDomainAffinity=${loo.serveSibling}`);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: TRAIN LABELS PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
