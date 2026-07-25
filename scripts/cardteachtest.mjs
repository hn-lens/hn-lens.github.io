// Card-level teaching test — guards the feature: you can follow/mute a story's
// domain or author straight from the card's "Personalize" menu, and it (a) writes
// the real prefs the ranker/filters use and (b) muting removes the story from the
// feed (global filtering). Drives the REAL app over a mocked HN API.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const STORIES = [
  { id: 901, type: 'story', by: 'alice', title: 'Story A', url: 'https://a.com/x', score: 120, descendants: 5, time: now - 3600 },
  { id: 902, type: 'story', by: 'bob', title: 'Story B', url: 'https://b.com/x', score: 110, descendants: 5, time: now - 3600 },
  { id: 903, type: 'story', by: 'carol', title: 'Story C', url: 'https://c.com/x', score: 100, descendants: 5, time: now - 3600 },
];
const byId = new Map(STORIES.map((s) => [s.id, s]));
const POOL = STORIES.map((s) => s.id);

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories/.test(u)) return j(POOL);
  if (/(best|new|ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) return j(byId.get(Number(m[1])) ?? null);
  return j(null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', useLearnedRanker: false, embeddingsEnabled: false, minPoints: 0, followedDomains: [], mutedDomains: [], followedUsers: [], mutedUsers: [] });
});
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(400);

const pref = (k) => page.evaluate((key) => window.__hnlens.prefs.getState()[key], k);
const shows = async (t) => (await page.evaluate(() => [...document.querySelectorAll('article h3')].map((h) => h.textContent.trim()))).some((x) => x.includes(t));
const cardOf = (t) => page.locator('article').filter({ hasText: t });
const openMenu = async (t) => {
  await cardOf(t).getByRole('button', { name: /Personalize/ }).click();
  await page.waitForTimeout(150);
};
const clickItem = async (name) => {
  await page.getByRole('menuitem', { name }).click();
  await page.waitForTimeout(300);
};

// --- the Personalize menu paints ABOVE the next card (no z-index/overlap artifact) ---
// The dropdown drops down over the card below it; a later sibling card would otherwise
// paint on top of it (its chips/Why-button bleeding through). Assert the menu is topmost.
await openMenu('Story A');
const overlap = await page.evaluate(() => {
  const menu = document.querySelector('[role="menu"]');
  if (!menu) return { ok: false, reason: 'no menu' };
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  const last = items[items.length - 1]; // lowest item — most likely to overlap the next card
  const r = last.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { ok: !!el && menu.contains(el), hit: el?.textContent?.trim()?.slice(0, 40) };
});
check('Personalize menu is topmost (not overlapped by the next card)', overlap.ok, JSON.stringify(overlap));
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

// --- follow domain ---
await openMenu('Story A');
await clickItem('Follow a.com');
check('Follow domain writes followedDomains', (await pref('followedDomains')).includes('a.com'), JSON.stringify(await pref('followedDomains')));

// --- follow author ---
await openMenu('Story A');
await clickItem('Follow alice');
check('Follow author writes followedUsers', (await pref('followedUsers')).includes('alice'), JSON.stringify(await pref('followedUsers')));
// Follow-author must offer an Undo like the other 3 Personalize actions (follow-domain/mute-*) — it
// was the lone exception (bare toast, no Undo). Assert the toast now has an Undo control.
check('Follow author toast offers Undo (consistent with the other Personalize actions)', await page.getByRole('button', { name: 'Undo' }).first().isVisible().catch(() => false));

// --- mute domain removes the story from the feed ---
await openMenu('Story B');
await clickItem('Mute b.com');
check('Mute domain writes mutedDomains', (await pref('mutedDomains')).includes('b.com'), JSON.stringify(await pref('mutedDomains')));
check('Mute domain removes the story from the feed (global filter)', !(await shows('Story B')), 'Story B should be gone');

// --- mute author removes the story from the feed ---
await openMenu('Story C');
await clickItem('Mute carol');
check('Mute author writes mutedUsers', (await pref('mutedUsers')).includes('carol'), JSON.stringify(await pref('mutedUsers')));
check('Mute author removes the story from the feed', !(await shows('Story C')), 'Story C should be gone');

// --- the menu toggles labels: re-open A shows Unfollow ---
await openMenu('Story A');
check('follow state reflected in the menu (Unfollow a.com shown)', await page.getByRole('menuitem', { name: 'Unfollow a.com' }).isVisible());

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: CARD TEACHING PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
