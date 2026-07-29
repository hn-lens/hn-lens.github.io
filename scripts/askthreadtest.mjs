// Ask-the-thread Q&A test — guards the feature: on a discussion, the reader can type a
// question and a model (here a mocked BYO cloud provider) answers grounded in the thread.
// Verifies: (1) the "Ask this discussion" input renders when AI is active; (2) asking sends
// a request that INCLUDES the question AND the thread's comments (grounding), and the answer
// renders; (3) "View request" shows the exact system+user messages; (4) it is HIDDEN when
// AI is off. The provider endpoint is mocked (no real network/key).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const ID = 7100;
const story = { id: ID, type: 'story', by: 'op', title: 'A story about raft consensus', url: 'https://ex.com/raft', score: 150, descendants: 5, time: now - 100000 };
const tree = {
  id: ID, story_id: ID, title: story.title, url: story.url, author: 'op', created_at_i: now - 100000, type: 'story', text: null, points: 150,
  children: [
    { id: ID * 10 + 1, author: 'alice', text: '<p>The hardest part of raft in practice is leader election under network partitions, which people underestimate constantly.</p>', created_at_i: now - 9000, children: [] },
    { id: ID * 10 + 2, author: 'bob', text: '<p>Log compaction and snapshotting are also a real pain to get right in a production implementation of the protocol.</p>', created_at_i: now - 8000, children: [] },
    { id: ID * 10 + 3, author: 'carol', text: '<p>I disagree that election is hard; membership changes are the truly subtle bit that breaks clusters.</p>', created_at_i: now - 7000, children: [] },
  ],
};

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());

let lastReq = { system: '', user: '' };
let genHits = 0;
const json = (r, x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
await page.route(/generativelanguage\.googleapis\.com/, (r) => {
  const u = r.request().url();
  if (/:generateContent/.test(u)) {
    genHits++;
    try {
      const body = JSON.parse(r.request().postData() || '{}');
      lastReq.system = body.systemInstruction?.parts?.map((p) => p.text).join('\n') ?? '';
      lastReq.user = (body.contents ?? []).flatMap((c) => (c.parts ?? []).map((p) => p.text)).join('\n');
    } catch {
      lastReq = { system: '', user: '' };
    }
    return json(r, { candidates: [{ content: { parts: [{ text: 'Commenters disagree: alice says leader election is hardest, while carol argues membership changes are the subtle part.' }] } }] });
  }
  return json(r, { models: [{ name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] }] });
});
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  if (/item\/7100/.test(u)) return json(r, story);
  if (/stories/.test(u)) return json(r, [ID]);
  return json(r, null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/7100/, (r) => json(r, tree));

await page.goto(`${BASE}#/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__hnlens, null, { timeout: 15000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ showAiSummaries: true, llmProvider: 'gemini', apiKeys: { gemini: 'test-key' }, llmEnabled: false });
});

// ---- (4-inverse) AI active (cloud key) → the Ask input renders ----
await page.goto(`${BASE}#/item/7100`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /raft consensus/i.test(document.body.innerText), null, { timeout: 20000 });
await page.waitForTimeout(400);
// Ask is a TOOL on the discussion toolbar now rather than a parked, always-visible input — an empty
// question box occupied ~96px above every thread. It must still be reachable in one click (or `a`).
check('the Ask tool is on the toolbar when AI is active', (await page.getByRole('button', { name: /^Ask$/ }).count()) > 0);
await page.getByRole('button', { name: /^Ask$/ }).first().click();
await page.waitForTimeout(350);
check('Ask-this-discussion input renders when AI is active', (await page.getByLabel('Ask this discussion').count()) > 0);
check('opening Ask focuses nothing destructive and keeps comments visible', /raft consensus/i.test(await page.locator('body').innerText()));

// ---- ask a question ----
await page.getByLabel('Ask this discussion').fill('What is the hardest part of raft?');
await page.getByRole('button', { name: 'Send', exact: true }).click();
await page.waitForFunction(() => /leader election is hardest|membership changes/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(300);
{
  const body = await page.locator('body').innerText();
  check('the model answer renders in the thread', /leader election is hardest|membership changes are the subtle/i.test(body), body.slice(body.indexOf('Q:'), body.indexOf('Q:') + 200));
  check('the asked question is shown', /What is the hardest part of raft\?/.test(body));
  check('exactly one generate call was made', genHits === 1, `${genHits}`);
}

// ---- grounding: the sent request includes the question AND the thread comments ----
check('request includes the user question', /What is the hardest part of raft\?/.test(lastReq.user), lastReq.user.slice(0, 80));
check('request is GROUNDED in the thread comments (alice + carol present)', /alice/.test(lastReq.user) && /carol/.test(lastReq.user));
check('request has a system instruction constraining to provided content', /ONLY the .*article text and comments/i.test(lastReq.system), lastReq.system.slice(0, 80));

// ---- View request opens the dialog with system + user ----
await page.getByRole('button', { name: /View request/i }).click();
await page.waitForTimeout(300);
{
  const dlg = await page.getByRole('dialog', { name: 'LLM request' }).innerText().catch(() => '');
  check('View request shows the system + user messages', /system/i.test(dlg) && /user/i.test(dlg) && /What is the hardest part/i.test(dlg));
  await page.keyboard.press('Escape');
}

// ---- (4) gated OFF: turn off AI summary controls → Ask input disappears ----
await page.evaluate(() => window.__hnlens.prefs.getState().set({ showAiSummaries: false }));
await page.waitForTimeout(300);
check('Ask input is hidden when "show AI summaries" is off', (await page.getByLabel('Ask this discussion').count()) === 0);

// ---- gated OFF: no cloud key and local off → Ask input hidden (summary CTA shown instead) ----
await page.evaluate(() => window.__hnlens.prefs.getState().set({ showAiSummaries: true, llmProvider: 'local', apiKeys: {}, llmEnabled: false }));
await page.waitForTimeout(300);
check('Ask input is hidden when no AI backend is available', (await page.getByLabel('Ask this discussion').count()) === 0);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: ASK-THREAD PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
