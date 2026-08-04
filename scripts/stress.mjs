// Adversarial stress test: hammer every element, feed weird input, hit invalid
// routes, and watch for crashes (ErrorBoundary), console errors, and broken states.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());

const errors = [];
const EXT = /favicons|gstatic|google\.com\/s2|huggingface|hf\.co|mlc/;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const u = m.location()?.url || '';
  if (EXT.test(u)) return;
  errors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const findings = [];
const bug = (id, desc) => {
  findings.push(`${id}: ${desc}`);
  console.log('  🐛 ' + id + ': ' + desc);
};

async function alive() {
  const crashed = await page.getByText('Something went wrong').count();
  return crashed === 0;
}
async function goHome(feed = 'foryou') {
  await page.goto(BASE + (feed === 'foryou' ? '' : `#/?feed=${feed}`), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article,main', { timeout: 40000 }).catch(() => {});
}
async function scenario(name, fn) {
  const before = errors.length;
  console.log('\n▶ ' + name);
  try {
    await fn();
  } catch (e) {
    bug(name, 'threw: ' + (e.message || e).slice(0, 160));
  }
  if (!(await alive())) bug(name, 'ErrorBoundary crash (white screen)');
  const newErrs = errors.slice(before);
  if (newErrs.length) bug(name, `${newErrs.length} console error(s): ${newErrs[0]}`);
}

// S1: rapid tab switching
await scenario('S1 rapid tab switching', async () => {
  await goHome();
  for (let r = 0; r < 2; r++)
    for (const t of ['Top', 'New', 'Best', 'Ask', 'Show', 'Jobs', 'For You']) {
      await page.getByRole('button', { name: t, exact: true }).first().click();
      await page.waitForTimeout(120);
    }
  await page.waitForSelector('article', { timeout: 40000 });
});

// S2: spam save/hide
await scenario('S2 spam save+hide', async () => {
  await goHome('top');
  await page.waitForSelector('article', { timeout: 40000 });
  const save = page.locator('article').first().getByRole('button', { name: /Save/ });
  for (let i = 0; i < 8; i++) await save.click();
  const hide = page.locator('article').nth(1).getByRole('button', { name: 'Not interested' });
  for (let i = 0; i < 3; i++) await hide.click().catch(() => {});
});

// S3: rapid drawer open/close
await scenario('S3 rapid drawer open/close', async () => {
  await goHome('top');
  await page.waitForSelector('article', { timeout: 40000 });
  for (let i = 0; i < 5; i++) {
    await page.getByRole('button', { name: 'Open comments' }).first().click();
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
  }
});

// S4: nasty search inputs
await scenario('S4 nasty search inputs', async () => {
  const inputs = [
    'a'.repeat(3000),
    '😀🔥💀 unicode',
    '<img src=x onerror="window.__xss=1">',
    '"><script>window.__xss=1</script>',
    "'; DROP TABLE users; --",
    '   ',
  ];
  for (const q of inputs) {
    const box = page.getByRole('searchbox', { name: 'Search Hacker News' });
    await box.fill(q);
    await box.press('Enter');
    await page.waitForTimeout(1200);
  }
  const xss = await page.evaluate(() => window.__xss);
  if (xss) bug('S4', 'XSS executed via search input');
});

// S5: invalid routes
await scenario('S5 invalid routes', async () => {
  for (const r of ['#/item/abc', '#/item/-1', '#/item/0', '#/item/999999999999', '#/item/', '#/totally/bogus', '#/saved']) {
    await page.goto(BASE + r, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    if (!(await alive())) bug('S5', 'crash on route ' + r);
  }
});

// S6: extreme weights (all zero) via sidebar
await scenario('S6 all-zero weights', async () => {
  await goHome();
  await page.waitForSelector('article', { timeout: 40000 });
  await page.getByRole('button', { name: /Tune ranking/ }).click();
  for (const label of ['Popularity (HN score)', 'Recency (freshness)', 'Discussion (comments)']) {
    const s = page.getByRole('slider', { name: label });
    await s.focus();
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft');
  }
  await page.waitForTimeout(800);
  const n = await page.locator('article').count();
  if (n === 0) bug('S6', 'feed empties when weights are all zero');
});

// S7: minPoints max -> empty For You
await scenario('S7 minPoints max empties feed', async () => {
  await page.evaluate(() => window.__hnlens.prefs.getState().set({ minPoints: 200, weights: { popularity: 1, recency: 1, discussion: 0.6, affinity: 1.4, relevance: 1.2, learned: 0.8 } }));
  await goHome();
  await page.waitForTimeout(2500);
  const empty = await page.getByText(/Nothing to show/i).count();
  const n = await page.locator('article').count();
  console.log(`    minPoints=200 -> ${n} cards, emptyState=${empty}`);
  if (n === 0 && empty === 0) bug('S7', 'empty feed shows nothing + no empty-state message');
  await page.evaluate(() => window.__hnlens.prefs.getState().set({ minPoints: 0 }));
});

// S8: username case-sensitivity (HN usernames are case-sensitive!)
await scenario('S8 followed-user case', async () => {
  await page.evaluate(() => window.__hnlens.prefs.getState().set({ followedUsers: [] }));
  await goHome();
  await page.getByRole('button', { name: 'Settings & models' }).click();
  const input = page.getByRole('textbox', { name: 'Followed users' });
  await input.fill('PatrickCollison');
  await input.press('Enter');
  await page.waitForTimeout(150);
  const stored = await page.evaluate(() => window.__hnlens.prefs.getState().followedUsers);
  console.log('    stored followedUsers:', JSON.stringify(stored));
  if (!stored.includes('PatrickCollison')) bug('S8', `HN usernames are case-sensitive but stored as ${JSON.stringify(stored)} (lowercased) — will never match real authors`);
});

// S9: HN username with special chars -> Algolia tag injection / crash
await scenario('S9 weird HN username', async () => {
  for (const u of ['a b,c(d)', '<img onerror=1>', 'x'.repeat(200)]) {
    await page.evaluate(() => window.__hnlens.prefs.getState().set({ hnUsername: '' }));
    await goHome();
    const input = page.getByPlaceholder('HN username');
    if (await input.count()) {
      await input.fill(u);
      await page.getByRole('button', { name: 'Connect' }).click();
      await page.waitForTimeout(1500);
      if (!(await alive())) bug('S9', 'crash on username ' + JSON.stringify(u));
    }
  }
  await page.evaluate(() => window.__hnlens.prefs.getState().set({ hnUsername: '' }));
});

// S10: train with no data
await scenario('S10 train with no interaction data', async () => {
  await goHome();
  await page.getByRole('button', { name: 'Settings & models' }).click();
  await page.getByRole('button', { name: 'Retrain now' }).click();
  await page.waitForTimeout(2500);
});

// S11: clear all data mid-session then use app
await scenario('S11 clear data then use', async () => {
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: /Clear all local data/ }).click();
  await page.waitForTimeout(800);
  await goHome('top');
  await page.waitForSelector('article', { timeout: 40000 });
});

// S12: comment permalink (not a story)
await scenario('S12 comment-id permalink', async () => {
  // fetch a comment id from a story
  const cid = await page.evaluate(async () => {
    const alg = await window.__hnlens.algolia();
    const r = await alg.search({ tags: 'front_page', hitsPerPage: 1 });
    const tree = await alg.fetchItemTree(Number(r.hits[0].objectID));
    return tree.children?.[0]?.id;
  });
  if (cid) {
    await page.goto(BASE + '#/item/' + cid, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const h1 = (await page.locator('h1').first().innerText().catch(() => '')).trim();
    console.log('    comment permalink h1:', JSON.stringify(h1.slice(0, 60)));
    if (!h1) bug('S12', `comment permalink /item/${cid} renders blank title/header`);
  }
});

await b.close();
console.log('\n==================================================');
console.log(`STRESS DONE. ${findings.length} findings, ${errors.length} total console errors.`);
findings.forEach((f) => console.log(' - ' + f));
