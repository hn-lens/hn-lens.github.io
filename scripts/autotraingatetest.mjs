// Background auto-retrain must not freeze the tab the reader is using.
//
// WHY THIS EXISTS. Training is plain synchronous JavaScript on the main thread — 200 epochs of
// pairwise ranking plus calibration, preceded by a full read of local history. Measured, one save
// bought a 759ms freeze at normal CPU and 3.9s under 4x throttle, fired ~14 seconds later with no
// spinner and nothing on screen to connect it to. Two gates make that unobservable rather than
// merely rarer, and both have to hold at once:
//
//   1. ENOUGH NEW MATERIAL — a retrain after every engagement re-does the same fit for a signal
//      that has barely moved. Only run once the history has grown by a real increment.
//   2. NOT WHILE THE READER IS LOOKING — the app's own reading loop opens articles in another tab,
//      so `document.hidden` is true precisely when a multi-second block costs nothing.
//
// The manual "Retrain now" button is deliberately exempt: that is an explicit request, and the
// reader is entitled to pay for what they asked for.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());

// Seed `n` engagement events, all newer than the stored model, then ask the trainer to run.
// `hidden` drives document.visibilityState, which is the only thing the visibility gate reads.
async function attempt({ events, hidden, trainedAt, noise = 0 }) {
  return page.evaluate(
    async ([n, isHidden, updatedAt, noiseCount]) => {
      const { db } = window.__hnlens.db();
      const logistic = window.__hnlens.logistic();
      const autotrain = window.__hnlens.autotrain();
      await db.events.clear();
      // A stored model with a known training time is what "new since" is measured against.
      const model = await logistic.loadModel();
      await logistic.saveModel({ ...model, w: model.w?.length ? model.w : [0.1], n: 24, updatedAt });
      const base = updatedAt + 1000;
      // A real log is mostly impressions, which are NOT engagement. Interleaving them at a realistic
      // ratio is what distinguishes "counted the engagements" from "read the first N rows": with a
      // row cap, the engagements sit past the window and the gate can never open.
      const rows = [];
      let t = base;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 12; k++) {
          rows.push({ ts: t++, type: 'impression', itemId: 5000 + i * 12 + k, domain: 'noise.example', author: 'nobody' });
        }
        rows.push({ ts: t++, type: 'open_link', itemId: 9000 + i, domain: 'example.com', author: 'someone' });
      }
      for (let i = 0; i < noiseCount; i++) {
        rows.push({ ts: t++, type: 'impression', itemId: 7000 + i, domain: 'noise.example', author: 'nobody' });
      }
      if (rows.length) await db.events.bulkAdd(rows);

      Object.defineProperty(Document.prototype, 'hidden', { get: () => isHidden, configurable: true });
      Object.defineProperty(Document.prototype, 'visibilityState', {
        get: () => (isHidden ? 'hidden' : 'visible'),
        configurable: true,
      });

      autotrain.__resetForTest?.();
      return autotrain.runAutoTrain();
    },
    [events, hidden, trainedAt, noise]
  );
}

try {
  await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com/, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__hnlens, null, { timeout: 20000 });
  await page.evaluate(() => window.__hnlens.prefs.getState().set({ useLearnedRanker: true }));

  const trainedAt = Date.now() - 60 * 60 * 1000;

  check('a handful of new events while hidden does NOT retrain', (await attempt({ events: 5, hidden: true, trainedAt })) === 'skipped');
  check('impressions alone never count as engagement', (await attempt({ events: 0, hidden: true, trainedAt, noise: 500 })) === 'skipped');
  check('29 new events while hidden does NOT retrain', (await attempt({ events: 29, hidden: true, trainedAt })) === 'skipped');
  check('30 new events while the reader is LOOKING does NOT retrain', (await attempt({ events: 30, hidden: false, trainedAt })) === 'skipped');
  check('30 new events while hidden DOES retrain', (await attempt({ events: 30, hidden: true, trainedAt })) === 'trained');
  check('no new events at all does NOT retrain', (await attempt({ events: 0, hidden: true, trainedAt })) === 'skipped');

  // A reader who has never trained must still get a first model without waiting for 30 events —
  // the sample gate inside training already decides whether there is enough to fit.
  const firstRun = await page.evaluate(async () => {
    const { db } = window.__hnlens.db();
    const logistic = window.__hnlens.logistic();
    const autotrain = window.__hnlens.autotrain();
    await db.events.clear();
    await logistic.saveModel({ w: [], n: 0, b: 0, updatedAt: 0 });
    const base = Date.now() - 5000;
    await db.events.bulkAdd(
      Array.from({ length: 6 }, (_, i) => ({ ts: base + i, type: 'open_link', itemId: 8000 + i, domain: 'e.com', author: 'a' }))
    );
    Object.defineProperty(Document.prototype, 'hidden', { get: () => true, configurable: true });
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'hidden', configurable: true });
    autotrain.__resetForTest?.();
    return autotrain.runAutoTrain();
  });
  check('a never-trained model still gets its first fit below the increment', firstRun === 'trained', firstRun);

  // A FAILING retrain must still consume the rate limit. `lastTrainAt` was only advanced after a
  // SUCCESSFUL `trainFromHistory()`, so a throwing retrain left the limiter untouched and the next
  // tab-hide re-ran the whole scan unthrottled — measured 230ms then 162ms back to back. The gate
  // exists to keep this work off the reader's main thread; a retrain that keeps failing is exactly
  // when that matters most.
  //
  // The failure is induced by CLOSING Dexie rather than by stubbing the module: `autotrain` imports
  // `trainFromHistory` as a direct ESM binding, so reassigning it on the namespace object does
  // nothing (measured: the stub was never called and the run still reported "trained").
  {
    const seq = await page.evaluate(async ([n]) => {
      const { db } = window.__hnlens.db();
      const logistic = window.__hnlens.logistic();
      const autotrain = window.__hnlens.autotrain();
      await db.events.clear();
      const model = await logistic.loadModel();
      const trainedAt = Date.now() - 60 * 60 * 1000;
      await logistic.saveModel({ ...model, w: model.w?.length ? model.w : [0.1], n: 24, updatedAt: trainedAt });
      const base = trainedAt + 1000;
      await db.events.bulkAdd(
        Array.from({ length: n }, (_, i) => ({ ts: base + i, type: 'open_link', itemId: 9500 + i, domain: 'e.com', author: 'a' }))
      );
      Object.defineProperty(Document.prototype, 'hidden', { get: () => true, configurable: true });
      Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'hidden', configurable: true });
      autotrain.__resetForTest?.();

      // Re-arm the same state each time: a successful train advances `updatedAt`, which consumes
      // the fresh events and would make a later assertion pass for the wrong reason.
      const arm = async () => {
        const m = await logistic.loadModel();
        await logistic.saveModel({ ...m, w: m.w?.length ? m.w : [0.1], n: 24, updatedAt: trainedAt });
        autotrain.__resetForTest?.();
      };

      // PRECONDITION FIRST, while everything is healthy: this state does train.
      await arm();
      const healthyBaseline = await autotrain.runAutoTrain();

      await arm();
      db.close(); // every storage call now throws
      const failed = await autotrain.runAutoTrain().catch((e) => `THREW: ${String(e).slice(0, 60)}`);
      await db.open(); // healthy again, and the 40 fresh events are still there
      const immediatelyAfter = await autotrain.runAutoTrain();
      return { healthyBaseline, failed, immediatelyAfter };
    }, [40]);
    // Ordered first so the two assertions below cannot pass merely because nothing was trainable.
    check('PRECONDITION: this state trains when storage is healthy', seq.healthyBaseline === 'trained', JSON.stringify(seq));
    check('a retrain that cannot reach storage returns skipped, it does not reject', seq.failed === 'skipped', JSON.stringify(seq));
    check('a failed attempt still consumes the rate limit (healthy retry is throttled)', seq.immediatelyAfter === 'skipped', JSON.stringify(seq));
  }

  // The gate must be readable by the surface that explains it, not just enforced internally.
  const exported = await page.evaluate(() => {
    const a = window.__hnlens.autotrain();
    return { hasMin: typeof a.MIN_NEW_EVENTS === 'number', min: a.MIN_NEW_EVENTS };
  });
  check('the increment is a named exported constant', exported.hasMin === true, `MIN_NEW_EVENTS=${exported.min}`);
} finally {
  await browser.close();
}

console.log(`\nRESULT: AUTOTRAIN GATE ${fails.length ? `FAIL \u2717 (${fails.join('; ')})` : 'PASS \u2713'}`);
process.exit(fails.length ? 1 : 0);
