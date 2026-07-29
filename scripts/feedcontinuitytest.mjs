// Feed CONTINUITY — the list you come back to is the list you left.
//
// WHY THIS EXISTS. A reader reported: "I read an item, came back, it was gone from For You, and I
// clicked what I thought was that item — it was a different story that had moved into that
// position." Four mechanisms compounded to produce it, each individually defensible:
//   1. `scrollRestoration` was 'manual' while the app-side restore it cited had been deleted;
//   2. the feed-tab strip centred itself with `scrollIntoView`, which scrolls the PAGE when the
//      strip is off-screen;
//   3. the pinned order was module-scope (lost on reload) and applied only to For You, so HN's own
//      three-minute churn re-sorted the plain feeds under the reader;
//   4. read stories were swept on every page LOAD, so the story just read vanished and everything
//      below it moved up one card.
//
// Every one of those passed the tests that existed. What none of them measured is the thing the
// reader actually does: AIM at a story, leave, come back, and ACT — and whether the click lands on
// the story they aimed at. So that is what this asserts, by IDENTITY, across the excursion matrix
// and — crucially — across POSITION, including the boundaries.
//
// The boundary matters on its own: arriving at a feed must put the reader at the top of the PAGE,
// it scrolls the first CARD to the viewport top, which is ~157px below the top of the PAGE because
// the header and tab strip sit in between. Scrolling to the top and reloading therefore moved the
// reader DOWN after they had done nothing, while every mid-list position stayed pixel-exact. If
// there was nothing to restore, restoring must do nothing.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const IDS = Array.from({ length: 120 }, (_, i) => 70000 + i);
const mkItem = (id) => ({
  id, type: 'story', by: `u${id}`, title: `Story ${id}`, url: `https://d${id}.example/x`,
  score: 500 - (id - 70000), descendants: 4, time: now - 3600 - (id - 70000) * 60,
});

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const page = ctx.pages()[0] || (await ctx.newPage());

try {
  // A CHURNING list: every refetch rotates the head, which is what HN's own list does over three
  // minutes. A fixture that returns a stable list cannot detect the defect at all.
  let churn = 0;
  await page.route(/hacker-news\.firebaseio\.com/, (r) => {
    const u = r.request().url();
    const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    for (const ep of ['topstories', 'beststories', 'newstories', 'askstories', 'showstories', 'jobstories']) {
      if (u.includes(ep)) {
        churn += 1;
        const rotated = [...IDS.slice(churn % 5), ...IDS.slice(0, churn % 5)];
        return j(rotated);
      }
    }
    const m = u.match(/item\/(\d+)\.json/);
    if (m) return j(mkItem(Number(m[1])));
    if (u.includes('maxitem')) return j(IDS[IDS.length - 1]);
    return j(null);
  });
  await page.route(/hn\.algolia\.com/, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hits: [], children: [], id: 1, title: 't', author: 'a', created_at_i: now, type: 'story', points: 1, text: null, story_id: 1 }) })
  );

  const cardIds = () =>
    page.evaluate(() => [...document.querySelectorAll('.story-card[data-id]')].map((e) => Number(e.dataset.id)));
  // What is under a given viewport point — the literal "I clicked where I remembered" test.
  const idAtPoint = (x, y) =>
    page.evaluate(
      ([px, py]) => {
        const el = document.elementFromPoint(px, py);
        return Number(el?.closest('.story-card[data-id]')?.dataset.id) || null;
      },
      [x, y]
    );

  const settle = async (ms = 2600) => page.waitForTimeout(ms);
  const load = async (feed) => {
    await page.goto(`${BASE}#/?feed=${feed}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.story-card', { timeout: 30000 });
    await settle();
  };

  // ---------- 1. THE BOUNDARY: at the top, a round trip must move nothing ----------
  for (const feed of ['top', 'foryou']) {
    await load(feed);
    // Scroll down and back to the top, so the excursion starts from a genuine top position —
    // the "never scrolled" case is easy and was already fine; this is the one that failed.
    await page.evaluate(() => window.scrollTo({ top: 1800 }));
    await settle(900);
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    await settle(900);
    const beforeY = await page.evaluate(() => window.scrollY);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.story-card', { timeout: 30000 });
    await settle();
    const afterY = await page.evaluate(() => window.scrollY);
    check(
      `[${feed}] at the top, a reload moves the page 0px`,
      beforeY === 0 && afterY <= 4,
      `before=${beforeY} after=${afterY}`
    );
  }

  // ---------- 2. AIM AND ACT, mid-list, across excursions ----------
  const excursions = {
    reload: async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.story-card', { timeout: 30000 });
    },
    tabswitch: async () => {
      await page.getByRole('button', { name: 'New', exact: true }).first().click();
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: 'Top', exact: true }).first().click();
      await page.waitForSelector('.story-card', { timeout: 30000 });
    },
    discussion: async () => {
      await page.locator('.story-card [aria-label^="Open comments"]').first().click();
      await page.waitForURL(/#\/item\//, { timeout: 20000 });
      await page.waitForTimeout(1200);
      await page.goBack();
      await page.waitForSelector('.story-card', { timeout: 30000 });
    },
  };

  for (const [name, run] of Object.entries(excursions)) {
    await load('top');
    await page.evaluate(() => window.scrollTo({ top: 1800 }));
    await settle();
    const aimY = await page.evaluate(() => window.scrollY);
    // Aim at whatever sits at a fixed viewport point, and remember its IDENTITY.
    const AIM_X = 400;
    const AIM_Y = 400;
    const aimed = await idAtPoint(AIM_X, AIM_Y);
    const before = await cardIds();

    await run();
    await settle();

    const landedY = await page.evaluate(() => window.scrollY);
    const after = await cardIds();
    const stillPresent = aimed !== null && after.includes(aimed);
    // Survivors must keep their relative order — a re-sort is what slides an unrelated story into
    // the slot the reader is reaching for.
    const survivors = before.filter((id) => after.includes(id));
    const orderKept = survivors.every((id, i, arr) => (i === 0 ? true : after.indexOf(arr[i - 1]) < after.indexOf(id)));
    // The reader is put at the TOP of the feed, and the top of the feed is the same story it was.
    // Landing anywhere else means an offset was inherited from the page just left — the failure that
    // "do nothing" produces, which is not the same as "go to the top".
    const topCardBefore = before[0] ?? null;
    const topCardAfter = after[0] ?? null;

    check(`[top/${name}] the aimed-at story is still in the list`, stillPresent, `aimed=${aimed} (aimY=${aimY})`);
    check(`[top/${name}] returning puts the reader at the TOP, not at an inherited offset`, landedY === 0, `landed=${landedY}`);
    check(`[top/${name}] the story at the top of the list is unchanged`, topCardBefore !== null && topCardAfter === topCardBefore, `before=${topCardBefore} after=${topCardAfter}`);
    check(`[top/${name}] survivors keep their relative order`, orderKept, `${survivors.length} survivors`);
  }

  // ---------- 2a. THE ARRIVAL HOLD MUST YIELD TO THE READER ----------
  // Landing at the top takes more than one scrollTo: the list mounts short and grows, and the
  // offset inherited from the route just left is applied against whatever height exists at that
  // instant. So the top is re-asserted for a short window — which is only safe if the reader
  // interrupting it always wins. Without that, a fast scroller is yanked back.
  {
    await load('top');
    await page.click('.feed-tabs button:has-text("New")').catch(() => {});
    await page.waitForTimeout(60); // well inside the hold window
    await page.mouse.wheel(0, 1500);
    await settle(1600);
    const wheelY = await page.evaluate(() => window.scrollY);
    check('a reader who scrolls just after arriving is NOT pulled back to the top', wheelY > 200, `y=${wheelY}`);

    await page.click('.feed-tabs button:has-text("Top")').catch(() => {});
    await page.waitForTimeout(60);
    await page.keyboard.press('End');
    await settle(1600);
    const keyY = await page.evaluate(() => window.scrollY);
    check('a keyboard reader is NOT pulled back to the top either', keyY > 200, `y=${keyY}`);

    await page.click('.feed-tabs button:has-text("Best")').catch(() => {});
    await settle(1600);
    const calmY = await page.evaluate(() => window.scrollY);
    check('an undisturbed arrival still lands at the top', calmY === 0, `y=${calmY}`);
  }

  // ---------- 2c. ARRIVING AT A NON-FEED ROUTE STARTS AT THE TOP ----------
  // `scrollRestoration` is manual and React Router leaves the window offset where the previous route
  // had it, so navigating away from a scrolled feed carried that offset onto the destination —
  // measured, /settings opened at y=3000 of a 6276px page. The feed had an arrival scroll; every
  // other route had nothing.
  {
    await load('top');
    await page.waitForTimeout(2200); // past the feed's own arrival hold
    await page.mouse.wheel(0, 3000); // a real gesture, which the hold yields to
    await settle(800);
    const fromY = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => {
      window.location.hash = '#/settings';
    });
    await page.waitForSelector('h1,h2', { timeout: 15000 }).catch(() => {});
    await settle(1500);
    const dest = await page.evaluate(() => ({ y: window.scrollY, h: document.documentElement.scrollHeight }));
    check('PRECONDITION: the feed was actually scrolled, and the destination can scroll', fromY > 500 && dest.h > 1200, `fromY=${fromY} destH=${dest.h}`);
    check('arriving at /settings from a scrolled feed lands at the TOP', dest.y <= 8, `y=${dest.y} (came from ${fromY})`);
  }

  // ---------- 2b. THE SESSION DEFINITION ITSELF ----------
  // A session starts when you open the app in a NEW TAB or press Refresh, and continues across
  // everything else including a reload. Assert the definition directly, because three separate
  // mechanisms derive from it and they previously disagreed.
  {
    await load('top');
    await page.evaluate(() => window.scrollTo({ top: 1800 }));
    await settle();
    const keysInSession = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('hn:')).sort());
    check('session state is recorded in sessionStorage', keysInSession.length > 0, keysInSession.join(','));

    // A RELOAD continues the session: the state survives.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.story-card', { timeout: 30000 });
    await settle();
    const afterReload = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('hn:')).sort());
    check('a RELOAD continues the session (state survives)', afterReload.length > 0, afterReload.join(','));

    // A NEW TAB starts a new one: sessionStorage is per-tab, so it begins empty by construction.
    const fresh = await ctx.newPage();
    try {
      await fresh.goto(`${BASE}#/?feed=top`, { waitUntil: 'domcontentloaded' });
      await fresh.waitForTimeout(1200);
      // Assert the EFFECT, not the presence of keys: a new tab writes its own fresh depth/pin on
      // first render, so key presence proves nothing. What must be true is that it inherited no
      // POSITION — it is at the top, with no session state to inherit.
      const newTabState = await fresh.evaluate(() => ({
        y: window.scrollY,
      }));
      check(
        'a NEW TAB starts a new session (no inherited position)',
        newTabState.y === 0,
        JSON.stringify(newTabState)
      );
    } finally {
      await fresh.close().catch(() => {});
    }

    // REFRESH starts a new one in this tab: position state is dropped.
    await page.getByRole('button', { name: 'Refresh' }).first().click();
    await settle();
    // Again the effect, not the store: a re-render immediately writes a fresh pin, which is
    // correct. What must be true is that the reader's POSITION was released — back to the top of a
    // newly ranked list, at the top of it.
    const afterRefresh = await page.evaluate(() => ({
      y: window.scrollY,
      depth: sessionStorage.getItem('hn:depth'),
    }));
    check(
      'REFRESH starts a new session (position released)',
      afterRefresh.y <= 4,
      JSON.stringify(afterRefresh)
    );
  }

  // ---------- 2b-ii. The pin must never be written EMPTY ----------
  // The aim-and-act checks above passed while this was broken, because with a stable fixture the
  // freshly-computed order happened to match. The defect is in the bookkeeping: on the first render
  // of every load `fresh` is empty, and writing that empty list destroyed the persisted pin before
  // rebuilding it. Instrument the WRITES rather than the outcome.
  {
    await load('top');
    await page.evaluate(() => window.scrollTo({ top: 900 }));
    await settle();
    await page.addInitScript(() => {
      window.__pinWrites = [];
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'hn:pinnedOrder') {
          try {
            const parsed = JSON.parse(v);
            window.__pinWrites.push(Object.fromEntries(Object.entries(parsed).map(([f, e]) => [f, e.ids.length])));
          } catch { /* ignore */ }
        }
        return orig.call(this, k, v);
      };
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.story-card', { timeout: 30000 });
    await settle();
    const writes = await page.evaluate(() => window.__pinWrites ?? []);
    const emptied = writes.some((w) => Object.values(w).some((n) => n === 0));
    check('a reload never writes an EMPTY pinned order', !emptied, JSON.stringify(writes.slice(0, 6)));
  }

  // ---------- 2c. Dismissing a story must not yank the one below it ----------
  // "Not interested" removed the row instantly, so everything below jumped up a full card height
  // and the reader's next click — on the story they had already picked out — hit the wrong one.
  {
    await load('top');
    await page.evaluate(() => window.scrollTo({ top: 900 }));
    await settle();
    const AIM_X = 400;
    const AIM_Y = 500;
    const target = await idAtPoint(AIM_X, AIM_Y);
    // Hide a card ABOVE the one being aimed at — that is what pulls the target upward.
    const hid = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.story-card[data-id]')];
      const above = cards.find((c) => c.getBoundingClientRect().bottom < 480 && c.getBoundingClientRect().bottom > 100);
      const btn = above?.querySelector('button[aria-label="Not interested"]');
      if (!btn) return null;
      btn.click();
      return Number(above.dataset.id);
    });
    await page.waitForTimeout(900);
    const after = await idAtPoint(AIM_X, AIM_Y);
    check('dismissing a story above does not move the one you were aiming at', hid === null || after === target, `hid=${hid} aimed=${target} got=${after}`);
    const stub = await page.evaluate(() => !!document.querySelector('[data-hidden-stub="true"]'));
    check('the dismissed row leaves a placeholder with an Undo', hid === null || stub, `stub=${stub}`);
  }

  // ---------- 3. A churning source must NOT re-sort the visible list ----------
  // The plain feeds had no stabilisation at all: past the list TTL, HN's own churn re-ordered the
  // page under the reader with nothing added or removed and nothing on screen to say so.
  await load('top');
  const beforeChurn = await cardIds();
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'New', exact: true }).first().click();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: 'Top', exact: true }).first().click();
    await page.waitForTimeout(900);
  }
  await settle();
  const afterChurn = await cardIds();
  const common = beforeChurn.filter((id) => afterChurn.includes(id));
  const churnOrderKept = common.every((id, i, arr) => (i === 0 ? true : afterChurn.indexOf(arr[i - 1]) < afterChurn.indexOf(id)));
  check('a churning source does not re-sort the visible list', churnOrderKept, `${common.length} in common`);

  // ---------- 4a2. Returning from a DEEP excursion when you never scrolled ----------
  // A skipped restore is only correct if the page is already where the restore would have put it.
  // Returning must scroll to the top explicitly; leaving the offset alone inherits the
  // position — which is right on a reload (the browser is at 0) and wrong on an in-app return,
  // where React Router keeps the offset of the page just left. Reported by a reader: opened the
  // first story's discussion, read it to the end, came back, and landed at the BOTTOM of the feed.
  // Measured 0 -> 4,032px on Top and 0 -> 12,405px on a long thread.
  await load('foryou');
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(900);
  const topStory = await idAtPoint(640, 300);
  const firstId = await page.evaluate(() => document.querySelector('.story-card[data-id]')?.getAttribute('data-id'));
  // A long thread for this one cell only: the shared mock returns an empty tree, and the defect
  // needs a discussion tall enough to leave a large offset behind.
  await page.route(/hn\.algolia\.com\/api\/v1\/items\//, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: Number(firstId), story_id: Number(firstId), title: 't', author: 'a', type: 'story',
        created_at_i: now, points: 1, text: null, parent_id: null,
        children: Array.from({ length: 120 }, (_, i) => ({
          id: 900000 + i, story_id: Number(firstId), parent_id: Number(firstId), author: `c${i}`,
          created_at_i: now - i, type: 'comment', points: null, children: [],
          text: `<p>Comment number ${i} with enough words in it to occupy a realistic amount of vertical space on the page.</p>`,
        })),
      }),
    })
  );
  await page.goto(`${BASE}#/item/${firstId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[id^="comment-"]', { timeout: 20000 });
  await settle(1200);
  const deep = await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    return document.documentElement.scrollHeight;
  });
  await settle(900);
  check('PRECONDITION: the discussion is long enough to leave a large offset', deep > 1500, `docH=${deep}`);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await settle(1600);
  const backY = await page.evaluate(() => window.scrollY);
  check('returning from a deep discussion when you never scrolled lands at the top', backY <= 8, `y=${backY}`);
  check(
    'and the story you were looking at is still where you left it',
    (await idAtPoint(640, 300)) === topStory,
    `want ${topStory} got ${await idAtPoint(640, 300)}`
  );

  // ---------- 4b. Engaging must not re-render the whole personalized list ----------
  // Saving, hiding or reading invalidates ['affinities'] and ['content'], which recomputes the
  // ranking. That is fine. What was not fine is that every card then received a fresh `reasons`
  // array and a fresh explanation OBJECT, so `memo(StoryCard)` bailed out for nobody and the cost
  // of a single Save grew linearly with how deep the reader had paged — measured on a throttled
  // phone at 60 / 111 / 197ms for 25 / 50 / 90 cards, against 0ms for the same action on Top, whose
  // cards share one constant empty array. The bound is deliberately loose (this harness runs
  // unthrottled, where the fixed cost is a few ms): the property under test is that the cost does
  // not scale with the list, not any particular millisecond count.
  await load('foryou');
  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push(e.duration);
    }).observe({ entryTypes: ['longtask'] });
  });
  const deepCards = await page.evaluate(() => document.querySelectorAll('.story-card[data-id]').length);
  const saveBtn = page.locator('button[aria-label="Save"]').first();
  check('PRECONDITION: enough cards and a Save control to measure engagement cost', (await saveBtn.count()) > 0 && deepCards >= 20, `${deepCards} cards`);
  if ((await saveBtn.count()) && deepCards >= 20) {
    await page.evaluate(() => { window.__lt = []; });
    await saveBtn.click();
    await page.waitForTimeout(3000);
    const blocked = await page.evaluate(() => window.__lt.reduce((a, b) => a + b, 0));
    check('engaging does not re-render the whole personalized list', blocked < 400, `${Math.round(blocked)}ms blocked across ${deepCards} cards`);
  }

  // ---------- 4c. A card must not collapse under the reader ----------
  // Cards with comments reserve space for a top-comment preview. When the lazy fetch settled with
  // nothing usable the slot was removed, so cards below the fold jumped -65px while the reader sat
  // still, and the cumulative shrink moved every card below the reader for the rest of
  // the session (a reload then landed 400-1200px away, on the wrong story).
  await load('foryou');
  await page.evaluate(() => window.scrollTo(0, 1200));
  await settle(1500);
  const h1 = await page.evaluate(() => document.documentElement.scrollHeight);
  await settle(2500); // let every lazy preview query resolve
  const h2 = await page.evaluate(() => document.documentElement.scrollHeight);
  check(
    'the feed does not shrink as lazy previews resolve',
    Math.abs(h2 - h1) <= 8,
    `${h1} -> ${h2}`
  );

  // ---------- 5. Teaching the ranker FROM A CARD must not move the reader ----------
  // The site name in a card's meta line is a ~70x16px grey string sitting directly above the
  // headline — the most mis-clickable element on a card. Treating a click on it as a request for a
  // new ranking re-ordered 14 of the 25 visible cards and the browser's compensating scroll carried
  // the reader 2,026px away from what they were reading, announced only as "Following <site>". A
  // teach is not a re-sort request: it is recorded at once and takes effect at the next boundary
  // the reader causes, exactly as a background retrain already did.
  //
  // Asserted by IDENTITY — is the story I was looking at still under the same point — and NOT by
  // scrollY, because following a site legitimately adds or removes a "why" chip and the document
  // changes height by that much. A scrollY assertion would fail on a correct implementation.
  // The click is a REAL synthesized mouse click: a Playwright locator click scrolls the element
  // into view first and would manufacture the very movement being measured.
  await load('foryou');
  await page.evaluate(() => window.scrollTo(0, 2100));
  await settle(1400);
  const AIM_Y = 420;
  const aimedAt = await idAtPoint(640, AIM_Y);
  // Where that card sits in the viewport. Measured on the CARD rather than by re-probing the point
  // afterwards, because a point probe can land in the gap between two cards (or on the toast the
  // action raises) and report `null` for a feed that did not move at all.
  const topOf = (id) =>
    page.evaluate(
      (cid) => {
        const el = document.querySelector(`.story-card[data-id="${cid}"]`);
        return el ? Math.round(el.getBoundingClientRect().top) : null;
      },
      id
    );
  const aimedTopBefore = await topOf(aimedAt);
  const orderBefore = (await cardIds()).slice(0, 25);
  const followedBefore = await page.evaluate(() => window.__hnlens.prefs.getState().followedDomains.join(','));
  // Following a site from a card is done through the "Personalize" (⋯) menu: the meta-line site name
  // is a plain span, not a control (it was the most mis-clickable element on a card). The teach path
  // moved into the menu, but the invariant is unchanged — recording a teach must NOT re-sort the feed.
  // Find a card in the aim band with a Personalize button and drive the menu with RAW mouse clicks (a
  // Playwright locator click scrolls the target into view first and would manufacture the very
  // movement being measured); the follow item calls the same toggleFollowDomain the chip once did.
  const teachBtn = await page.evaluate(() => {
    for (const card of document.querySelectorAll('.story-card')) {
      const r0 = card.getBoundingClientRect();
      if (r0.top < 60 || r0.top > 400) continue;
      const btn = [...card.querySelectorAll('button')].find((b) =>
        /Personalize/.test(b.getAttribute('aria-label') || b.getAttribute('title') || '')
      );
      if (!btn) continue;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return null;
  });
  check('PRECONDITION: a story is under the aim point and a card Personalize menu is reachable', !!aimedAt && !!teachBtn, `aim=${aimedAt}`);
  if (aimedAt && teachBtn) {
    await page.mouse.click(teachBtn.x, teachBtn.y); // open the ⋯ menu (raw click — no scroll-into-view)
    await settle(300);
    // The Follow-site item — a domain has a dot; "Follow <author>" does not.
    const followItem = await page.evaluate(() => {
      const menu = document.querySelector('[role="menu"]');
      if (!menu) return null;
      const it = [...menu.querySelectorAll('[role="menuitem"]')].find((m) =>
        /^Follow \S+\.\S+/.test((m.textContent || '').trim())
      );
      if (!it) return null;
      const r = it.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    check('PRECONDITION: the Personalize menu offers a Follow-site item', !!followItem, `menu=${!!followItem}`);
    if (followItem) {
      await page.mouse.click(followItem.x, followItem.y); // follow the site (menu closes itself)
      await settle(2400);
      const orderAfter = (await cardIds()).slice(0, 25);
      const moved = orderBefore.filter((id, i) => orderAfter[i] !== id).length;
      const aimedTopAfter = await topOf(aimedAt);
      const shift = aimedTopAfter === null || aimedTopBefore === null ? null : Math.abs(aimedTopAfter - aimedTopBefore);
      check('following a site from a card does not re-order the visible feed', moved === 0, `${moved}/25 moved`);
      check(
        'the story the reader was looking at has not moved on screen',
        shift !== null && shift <= 8,
        `card ${aimedAt} top ${aimedTopBefore} -> ${aimedTopAfter} (${shift === null ? 'gone' : `${shift}px`})`
      );
      // Compared against the set captured BEFORE the click, because the teach TOGGLES: asserting
      // "non-empty" fails whenever the site happened to be followed already.
      check(
        'the teach WAS recorded (so this cannot pass by the click doing nothing)',
        (await page.evaluate(() => window.__hnlens.prefs.getState().followedDomains.join(','))) !== followedBefore,
        `before=[${followedBefore}]`
      );
    }
  }
} finally {
  await ctx.close().catch(() => {});
  await b.close().catch(() => {});
}

console.log(`\nRESULT: FEED CONTINUITY ${fails.length ? `FAIL \u2717 (${fails.length}: ${fails.join('; ')})` : 'PASS \u2713'}`);
process.exit(fails.length ? 1 : 0);
