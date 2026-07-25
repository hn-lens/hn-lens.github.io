// Inline top-comment surface tests. The feed cards can show the single best top-level
// comment under each story, controlled by the "Top comments" switch in the feed header
// (a persisted pref, NOT a Settings toggle). This guards:
//   [A] with the toggle ON, the best top-level comment (by substance x replies) renders
//       under the card with its author + a "Read N comments ->" link; it is fetched via the
//       firebase ITEM pool (item.kids), NOT the whole Algolia comment tree (the perf fix —
//       assert ZERO Algolia /items requests); and multi-paragraph/link comment text is NOT
//       word-mashed at block boundaries (the stripHtml block-awareness fix).
//   [B] toggling the header switch OFF hides the comment block live (the control's EFFECT,
//       not just that it writes the store).
//   [C] with the toggle OFF, the feed fetches NO comment items (lazy + gated) — the whole
//       point of gating is that it costs nothing when off.
//   [D] a muted commenter's comment is never surfaced — it falls back to the next best.
//
// Hermetic: fully mocked HN API (firebase item pool + an Algolia stub), chromium, no WebGPU.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);

const STORY_IDS = [1000, 1001];
// Comment ids live in a distinct >=10000 range so the mock can COUNT comment-item fetches
// separately from the story-item fetches the feed itself makes.
const CID = (sid, n) => sid * 10 + n; // 1000 -> 10001.. ; 1001 -> 10011..
const KIDS = Object.fromEntries(STORY_IDS.map((sid) => [sid, [CID(sid, 1), CID(sid, 2), CID(sid, 3), CID(sid, 4)]]));
const mkStory = (id) => ({
  id, type: 'story', by: `op${id}`, title: `Story ${id}`, url: `https://d${id}.example/x`,
  score: 150, descendants: 5, time: now - 100000, kids: KIDS[id],
});

const AUTHOR_TOP = 'greatcommenter';
const AUTHOR_MID = 'okcommenter';
const AUTHOR_LOW = 'terseperson';
const AUTHOR_EMPTY = 'formatonlyperson'; // a formatting-only (empty visible text) comment
const TOP_PHRASE = 'This is the standout analysis with real substance';
const SECOND_PHRASE = 'and a second block here'; // in a separate <p>, to test block-boundary spacing
const MID_PHRASE = 'A reasonably useful middle of the road point';

// Per story, the DIRECT top-level comment items (firebase shape). Each comment carries its own
// `kids` = direct-reply ids (only the COUNT is used for scoring; the replies are never fetched).
// score = min(len,200) + replies*70 - linkdump*300, so the TOP comment (long + 2 replies) beats the
// MID (medium + 1 reply) beats the LOW (short + 0). The TOP text uses the REALISTIC HN shape: it
// STARTS with a BARE text node (the first paragraph is NOT wrapped in <p>) — the boundary that the
// append-only separator mashed — then a <p>, a trailing <a>, a <pre> code block, and a <ul> list, so
// it exercises EVERY block-boundary of the stripHtml both-sides fix.
//   CID4 is a FORMATTING-ONLY comment (`<p></p>`) with the MOST replies (would out-SCORE the TOP,
//   350 vs 340) — it must be dropped because its VISIBLE (stripped) text is empty, else it would
//   render an author byline above a blank preview line.
const mkComments = (sid) => ({
  [CID(sid, 1)]: { id: CID(sid, 1), type: 'comment', by: AUTHOR_LOW, text: '<p>Short.</p>', kids: [] },
  [CID(sid, 2)]: {
    id: CID(sid, 2), type: 'comment', by: AUTHOR_TOP,
    text: `${TOP_PHRASE} ${'detail '.repeat(18)}leadword<p>${SECOND_PHRASE}</p><a href="https://ex.com/x">https://ex.com/x</a><pre>codeblocktoken</pre><ul><li>listword</li></ul><p>tailword</p>`,
    kids: [sid * 100 + 1, sid * 100 + 2],
  },
  [CID(sid, 3)]: {
    id: CID(sid, 3), type: 'comment', by: AUTHOR_MID,
    text: `<p>${MID_PHRASE} that is medium length ${'more '.repeat(12)}.</p>`,
    kids: [sid * 100 + 3],
  },
  [CID(sid, 4)]: {
    id: CID(sid, 4), type: 'comment', by: AUTHOR_EMPTY,
    text: '<p></p>', // formatting-only: strips to '' → must be dropped despite the high reply count
    kids: [sid * 100 + 4, sid * 100 + 5, sid * 100 + 6, sid * 100 + 7, sid * 100 + 8],
  },
});
const COMMENTS = Object.assign({}, ...STORY_IDS.map(mkComments));

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());

let commentFetches = 0; // firebase fetches of COMMENT items (proves lazy fetch fired / stays 0 when off)
let treeFetches = 0; // Algolia /items (comment-tree) requests — must stay 0 (the perf fix)

await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (u.includes('/topstories.json')) return j(STORY_IDS);
  for (const ep of ['beststories', 'newstories', 'askstories', 'showstories', 'jobstories']) if (u.includes(`/${ep}.json`)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) {
    const id = Number(m[1]);
    if (STORY_IDS.includes(id)) return j(mkStory(id));
    if (COMMENTS[id]) {
      commentFetches++;
      return j(COMMENTS[id]);
    }
    return j(null);
  }
  if (u.includes('/user/')) return j({ id: 'x', karma: 1, created: now });
  if (u.includes('maxitem')) return j(9999);
  return j(null);
});
await page.route(/hn\.algolia\.com\/api\/v1\/search/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nbHits: 0, page: 0, nbPages: 0, hits: [] }) })
);
// Stub the Algolia comment-tree endpoint and COUNT hits: the inline top comment must no longer
// use it (it used to download the whole nested tree per card just for one preview line).
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => {
  treeFetches++;
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 0, children: [] }) });
});
await page.route(/google\.com\/s2\/favicons|gstatic\.com\/faviconV2/, (r) => r.fulfill({ status: 200, body: '' }));

const bodyHas = (re) => page.evaluate((src) => new RegExp(src, 'i').test(document.body.innerText), re.source);
const openTop = async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await page.waitForSelector('article[data-id="1000"]', { timeout: 15000 });
};

// Baseline prefs: plain Top feed, no ranking/embeddings/filters, top comments ON.
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({
    useLearnedRanker: false, embeddingsEnabled: false, defaultFeed: 'top', minPoints: 0,
    mutedDomains: [], mutedUsers: [], showTopComments: true,
  });
});

// ===== [A] with the toggle ON, the best top-level comment surfaces =====
console.log('\n[A] toggle ON: the standout top comment renders under the card');
await openTop();
await page.waitForFunction((p) => document.body.innerText.includes(p), TOP_PHRASE, { timeout: 15000 }).catch(() => {});
check('the highest-substance top-level comment is shown', await page.evaluate((p) => document.body.innerText.includes(p), TOP_PHRASE));
check('its author is shown as the attribution', await bodyHas(new RegExp(AUTHOR_TOP)));
check('a "Read N comments ->" link is shown (N = descendants)', await bodyHas(/Read 5 comments/));
check('the header "Top comments" switch is present', await page.getByRole('switch', { name: /Top comments/i }).isVisible().catch(() => false));
check('a comment ITEM fetch fired (lazy load)', commentFetches >= 1, `${commentFetches} fetch(es)`);
check('NO Algolia comment-tree was fetched (perf fix)', treeFetches === 0, `${treeFetches} tree fetch(es)`);
// stripHtml BOTH-SIDES block separation: NO block boundary may mash. Read the preview paragraph's
// textContent (NOT body.innerText) so the CSS line-clamp can't hide the boundary tail. The TOP
// comment uses the REALISTIC shape (starts with BARE text before the first <p>).
const topcText = await page.evaluate(() => document.querySelector('.sc-topcomment p')?.textContent || '');
// (1) leading bare-text -> first <p>: the append-only separator mashed this ("leadwordand a second…").
//     This is the boundary EVERY real HN comment has and is the core of the c3r6 both-sides fix.
check('leading bare text keeps a space before the first block (not mashed)', /leadword and a second block here/.test(topcText), topcText.slice(0, 110));
// (2) </p> -> trailing <a> link.
check('a trailing link keeps a space before it (not word-mashed)', /block here https:\/\/ex\.com/.test(topcText));
// (3) <pre> code block -> <ul>/<li> list -> <p>: pre AND the ul container must separate.
check('a <pre> code block + <ul> list keep spaces at every boundary', /codeblocktoken listword tailword/.test(topcText), topcText.slice(-70));
// (4) the formatting-only comment (CID4: empty visible text, HIGHEST reply score) must be DROPPED,
//     never rendered as an author byline above a blank line — require a non-empty visible preview.
check('an empty-content comment is never surfaced as a blank preview', topcText.trim().length > 0 && !(await bodyHas(new RegExp(AUTHOR_EMPTY))));

// ===== [B] toggling the header switch OFF hides the block live =====
console.log('\n[B] header switch OFF hides the comment block (live)');
const sw = page.getByRole('switch', { name: /Top comments/i });
check('switch reports checked (aria-checked=true) when on', (await sw.getAttribute('aria-checked')) === 'true');
await sw.click();
await page.waitForTimeout(400);
check('turning the switch OFF removes the inline comment', !(await page.evaluate((p) => document.body.innerText.includes(p), TOP_PHRASE)), 'still visible ⇒ dead toggle');
check('switch reports unchecked after click', (await sw.getAttribute('aria-checked')) === 'false');
check('no .sc-topcomment blocks remain in the DOM', (await page.locator('.sc-topcomment').count()) === 0);

// ===== [C] with the toggle OFF, a fresh feed fetches NO comment items =====
console.log('\n[C] toggle OFF: the feed fetches no comment items');
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData(); // clears kv cache too, so any fetch would be a real one
});
commentFetches = 0;
treeFetches = 0;
await openTop();
await page.waitForTimeout(1200); // give any (unwanted) lazy fetch time to fire
check('OFF: zero comment-item fetches on a fresh feed load', commentFetches === 0, `${commentFetches} fetch(es)`);
check('OFF: zero Algolia tree fetches', treeFetches === 0, `${treeFetches} fetch(es)`);
check('OFF: no inline comment blocks rendered', (await page.locator('.sc-topcomment').count()) === 0);

// ===== [D] a muted commenter is never surfaced — fall back to the next best =====
console.log('\n[D] a muted commenter falls back to the next-best comment');
await page.evaluate((muted) => {
  window.__hnlens.prefs.getState().set({ showTopComments: true, mutedUsers: [muted] });
}, AUTHOR_TOP);
await openTop();
await page.waitForFunction((p) => document.body.innerText.includes(p), MID_PHRASE, { timeout: 15000 }).catch(() => {});
check('the muted top commenter is NOT surfaced', !(await page.evaluate((p) => document.body.innerText.includes(p), TOP_PHRASE)));
check('the next-best (non-muted) comment is shown instead', await page.evaluate((p) => document.body.innerText.includes(p), MID_PHRASE));
check('the fallback comment shows its author', await bodyHas(new RegExp(AUTHOR_MID)));

// --- QUOTE-THEN-REBUT must show the REBUTTAL, never the quoted claim (ATTRIBUTION) ---
// Regression for: this selector cleaned with a plain stripHtml, which collapses the newlines that
// delimit an HN quote AND keeps the quoted text — so the preview rendered someone ELSE's claim
// directly under the replier's byline, frequently the exact opposite of their position. Both
// sibling selectors (the summary input and the non-AI gist) already filtered quote lines; the
// VISIBLE, default-on one did not. All three now share one cleaner, so assert they AGREE.
const attribution = await page.evaluate(async () => {
  const tc = await window.__hnlens.topComment();
  const html = await window.__hnlens.html();
  const QUOTED = 'the new scheduler is strictly better in every workload';
  const REBUT = 'It does not They only tested a single NUMA topology';
  const picks = tc.pickTopComments([
    { id: 1, type: 'comment', by: 'quoter', text: `<p>&gt; ${QUOTED}</p><p>${REBUT} ${'and more detail '.repeat(6)}</p>`, kids: [1, 2, 3] },
  ]);
  return {
    text: picks[0]?.text ?? '',
    shared: html.commentToText(`<p>&gt; ${QUOTED}</p><p>${REBUT}</p>`),
  };
});
check('the preview drops the QUOTED claim (no misattribution)',
  !/strictly better in every workload/.test(attribution.text), attribution.text.slice(0, 90));
check('the preview keeps the commenter\'s own REBUTTAL',
  /It does not/.test(attribution.text), attribution.text.slice(0, 90));
check('the top-comment selector agrees with the shared cleaner',
  attribution.text.startsWith(attribution.shared.slice(0, 40)), `shared="${attribution.shared.slice(0, 50)}"`);

// --- the feed must be STABLE after first paint, even though previews arrive late ---
// The preview is fetched lazily per card, so on a slow link the feed kept re-flowing for ~2s after
// first paint — five staged jumps, up to +478px for card 8. The reader starts moving toward a story
// and it slides out from under them. The card now reserves the slot from first paint (the story's
// own comment count says a preview is coming), so the arriving text fills space that was already
// there instead of pushing everything down.
{
  // Fresh context so nothing is warm: the reflow only exists while previews are still in flight.
  const ctx2 = await b.newContext({ viewport: { width: 1180, height: 900 } });
  const page2 = await ctx2.newPage();
  await page2.route(/hacker-news\.firebaseio\.com/, async (r) => {
    const u = r.request().url();
    const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (u.includes('/topstories.json')) return j(STORY_IDS);
    for (const ep of ['beststories', 'newstories', 'askstories', 'showstories', 'jobstories'])
      if (u.includes(`/${ep}.json`)) return j([]);
    const m = u.match(/item\/(\d+)/);
    if (m) {
      const id = Number(m[1]);
      if (STORY_IDS.includes(id)) return j(mkStory(id));
      if (COMMENTS[id]) {
        // Comments arrive LATE — the exact shape that produced the staged reflow.
        await new Promise((res) => setTimeout(res, 900));
        return j(COMMENTS[id]);
      }
      return j(null);
    }
    if (u.includes('/user/')) return j({ id: 'x', karma: 1, created: now });
    if (u.includes('maxitem')) return j(9999);
    return j(null);
  });
  await page2.route(/hn\.algolia\.com/, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hits: [], children: [] }) })
  );
  await page2.route(/google\.com\/s2\/favicons|gstatic\.com\/faviconV2/, (r) => r.fulfill({ status: 200, body: '' }));
  await page2.addInitScript(() => {
    localStorage.setItem('hn:prefs', JSON.stringify({ state: { showTopComments: true, defaultFeed: 'top', hasOnboarded: true }, version: 0 }));
  });
  await page2.goto(`${BASE}#/?feed=top`, { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('article[data-id]', { timeout: 20000 });
  await page2.waitForTimeout(120);
  const tops = () =>
    page2.evaluate(() => [...document.querySelectorAll('article[data-id]')].map((a) => Math.round(a.getBoundingClientRect().top)));
  const t0 = await tops();
  await page2.waitForTimeout(3000); // every lazy preview lands
  const t1 = await tops();
  const n = Math.min(t0.length, t1.length);
  check('the reflow probe actually rendered cards (otherwise it proves nothing)', n >= 2, `${n} cards`);
  const worst = n ? Math.max(...Array.from({ length: n }, (_, k) => Math.abs(t1[k] - t0[k]))) : -1;
  check('the feed does not re-flow after first paint as previews arrive', n >= 2 && worst <= 8, `worst shift ${worst}px across ${n} cards`);
  await page2.close();
  await ctx2.close();
}

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: TOP COMMENT (inline preview + header toggle) PASS \u2713' : `RESULT: ${fails.length} FAILED \u2717`}`);
if (fails.length) fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
