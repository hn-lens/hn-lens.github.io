// "Built with Llama" attribution must NOT render over a thin-input REFUSAL — no model ran, so the
// attribution is false. The refusal path returns an empty `request`; the attribution must key off
// that (a real model call), not merely off "a local provider is selected".
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
// A thin story: one junk comment (below the substance floor), no linked article, no self text ⇒
// nothing substantive to summarize ⇒ refusal. One comment so the discussion toolbar (and thus the
// AI summary control) renders (it needs topLevel.length > 0).
const STORY = { id: 1, type: 'story', by: 'op', title: 'A lonely post with nothing to summarize', score: 50, descendants: 1, time: now - 3600 };
const TREE = { id: 1, story_id: 1, title: STORY.title, points: 50, author: 'op', created_at_i: now - 3600, type: 'story', text: null, children: [{ id: 11, author: 'x', text: '<p>meh</p>', created_at_i: now - 3000, children: [] }] };
// A SUBSTANTIVE thread (NOT thin) so askThread attempts a real model call. Paired with a mocked cloud
// provider whose endpoint 500s, the call THROWS — over that error the Ask footer (caveat / "Answered
// from" / attribution) must be suppressed just like over a refusal (`sent.sent` alone is not enough).
const STORY2 = { id: 2, type: 'story', by: 'op2', title: 'A busy discussion with plenty to say', score: 120, descendants: 3, time: now - 3600 };
const SUB = '<p>A genuinely substantive comment, well over the preview and substance floor, arguing a specific point about the tradeoffs involved here.</p>';
const TREE2 = { id: 2, story_id: 2, title: STORY2.title, points: 120, author: 'op2', created_at_i: now - 3600, type: 'story', text: null, children: [
  { id: 21, author: 'a', text: SUB, created_at_i: now - 3000, children: [] },
  { id: 22, author: 'b', text: SUB, created_at_i: now - 2900, children: [] },
  { id: 23, author: 'c', text: SUB, created_at_i: now - 2800, children: [] },
] };

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());
const json = (r, x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const mi = u.match(/item\/(\d+)\.json/);
  if (mi) { const id = Number(mi[1]); return json(r, id === 1 ? STORY : id === 2 ? STORY2 : null); }
  return json(r, null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => json(r, Number(r.request().url().match(/items\/(\d+)/)[1]) === 2 ? TREE2 : TREE));
// The cloud (Gemini) endpoint 500s, so a real send throws — used by the Ask-ERROR scenario below.
await page.route(/generativelanguage\.googleapis\.com/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"simulated provider error"}}' }));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs && window.__hnlens.registry, null, { timeout: 20000 });
// Local provider, AI on, WebGPU pretend-available (the refusal path returns BEFORE any model load).
await page.evaluate(() => {
  window.__hnlens.prefs.getState().set({ llmProvider: 'local', llmEnabled: true, showAiSummaries: true, apiKeys: { gemini: '', openai: '', anthropic: '' } });
  window.__hnlens.registry().useModelStore.getState().setWebgpu('available');
});
await page.goto(`${BASE}#/item/1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\bSummary\b/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
// Open the Summary tool (toolbar toggle), then trigger the summary.
await page.getByRole('button', { name: /^Summary$/ }).first().click().catch(() => {});
await page.waitForFunction(() => /discussion summary/i.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {});
await page.getByRole('button', { name: /^Summarize$/ }).click().catch(() => {});
await page.waitForFunction(() => /not enough to summarize/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(400);

const body = await page.locator('main').innerText();
check('PRECONDITION: the thin story produced a refusal', /not enough to summarize/i.test(body), body.replace(/\s+/g, ' ').slice(0, 140));
check('a Summarize refusal does NOT carry the "Built with Llama" attribution (no model ran)', !/Built with Llama/i.test(body), (body.match(/Built with Llama/i) || [''])[0]);
check('a Summarize refusal does NOT carry the "AI-generated" caveat (no model ran)', !/AI-generated ·/i.test(body), (body.match(/AI-generated[^\n]*/i) || [''])[0]);

// --- Ask path: the SAME rules, a sibling of the Summarize fix. A thin thread is refused inside
// askThread with NO model call, so neither the "Built with Llama" attribution nor the "AI-generated"
// caveat may appear over the refusal. Scope to the Ask panel (its own <form>) so the summary block
// above can't mask the assertion.
await page.getByRole('button', { name: 'Ask' }).first().click().catch(() => {});
await page.waitForSelector('#ask-thread', { timeout: 10000 }).catch(() => {});
await page.fill('#ask-thread', 'What are the main objections?').catch(() => {});
await page.press('#ask-thread', 'Enter').catch(() => {});
await page.waitForFunction(() => /enough content to answer/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(400);
const askPanel = page.locator('form').filter({ hasText: 'Ask this discussion' });
const askBody = await askPanel.innerText().catch(() => '');
check('PRECONDITION: the thin thread produced an Ask refusal', /enough content to answer/i.test(askBody), askBody.replace(/\s+/g, ' ').slice(0, 160));
check('an Ask refusal does NOT carry the "Built with Llama" attribution (no model ran)', !/Built with Llama/i.test(askBody), (askBody.match(/Built with Llama/i) || [''])[0]);
check('an Ask refusal does NOT carry the "AI-generated" caveat (no model ran)', !/AI-generated ·/i.test(askBody), (askBody.match(/AI-generated[^\n]*/i) || [''])[0]);

// --- Ask ERROR path: a SUBSTANTIVE thread (not a refusal) whose provider call THROWS. `sent.sent` is
// true here (a send was attempted), so the footer must key off "a model produced text" (!errored) —
// over the error the caveat and the "Answered from N" provenance must both be suppressed.
await page.evaluate(() => {
  window.__hnlens.prefs.getState().set({ llmProvider: 'gemini', apiKeys: { gemini: 'test-key', openai: '', anthropic: '' } });
});
// Client-side hash nav (reliable SPA route change; page.goto to a hash-only URL can no-op).
await page.evaluate(() => { window.location.hash = '#/item/2'; });
// Wait for /item/2's OWN content, not the stale /item/1 Ask button still in the DOM mid-transition.
await page.waitForFunction(() => /A busy discussion with plenty to say/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
// The Ask tool may carry over OPEN from the /item/1 refusal above; clicking would TOGGLE it closed.
// Only click when the input isn't already present, so the panel ends up open either way.
if (!(await page.evaluate(() => !!document.querySelector('#ask-thread')))) {
  await page.getByRole('button', { name: 'Ask' }).first().click().catch(() => {});
}
await page.waitForSelector('#ask-thread', { timeout: 10000 }).catch(() => {});
await page.fill('#ask-thread', 'What is the main tradeoff discussed?').catch(() => {});
await page.press('#ask-thread', 'Enter').catch(() => {});
// Scope the wait + read to the Ask <form> via querySelectorAll (a Playwright locator .innerText()
// can hit a strict-mode multi-match while the route transition briefly leaves a stale form).
const askText = () => `[...document.querySelectorAll('form')].find((x) => /Ask this discussion/.test(x.innerText))`;
await page.waitForFunction(`(() => { const f = ${askText()}; return f && /Couldn.t answer/i.test(f.innerText); })()`, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(300);
const errBody = await page.evaluate(`(() => { const f = ${askText()}; return f ? f.innerText : ''; })()`);
check('PRECONDITION: a substantive thread + provider 500 produced an Ask ERROR', /Couldn.t answer/i.test(errBody), errBody.replace(/\s+/g, ' ').slice(0, 160));
check('an Ask ERROR does NOT carry the "AI-generated" caveat (no model produced text)', !/AI-generated ·/i.test(errBody), (errBody.match(/AI-generated[^\n]*/i) || [''])[0]);
check('an Ask ERROR does NOT claim "Answered from N top comments" (no model produced text)', !/Answered from/i.test(errBody), (errBody.match(/Answered from[^\n]*/i) || [''])[0]);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: REFUSAL ATTRIBUTION PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
