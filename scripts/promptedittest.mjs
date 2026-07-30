// AI prompt EDITING fidelity — guards the fix for the "Edit prompt" affordance that couldn't
// actually edit the current prompt. Both editors (Settings -> "AI prompts (advanced)" and the
// in-place SummaryActions "Edit prompt" dialog) must PRE-FILL the textarea with the EFFECTIVE
// prompt (the override if set, else the built-in default) as the real VALUE — not show it only as
// a placeholder that vanishes on the first keystroke — must keep the "empty override = default"
// storage model (store '' when the text is left equal to the default), and must be tall enough to
// read a multi-sentence prompt. Pre-fix these fields were value=override(=''), placeholder=default,
// rows=2/3.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const STORY_ID = 7000;
// A distinctive slice of each default prompt (prompts.ts) — proof the VALUE is the real prompt.
const DEF_TLDR_SYS = 'single, sharp, accurate one-sentence TL;DR';
const DEF_TLDR_USER = 'Write a one-sentence TL;DR (max 30 words)';

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());

const json = (r, x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
const story = { id: STORY_ID, type: 'story', by: 'op', title: 'A story about raft consensus', url: 'https://ex.com/raft', score: 150, descendants: 3, time: now - 100000 };
// The comments must clear the summarize-substance floor (tooThinToAnswer: >=2 comments AND >=200
// chars) so the TL;DR actually SUCCEEDS (GEMINI_SUMMARY) — this test edits the prompt in a real
// SUCCESS state; a thin story would refuse and (correctly) hide the controls row.
const tree = { id: STORY_ID, story_id: STORY_ID, title: story.title, url: story.url, author: 'op', created_at_i: now - 100000, type: 'story', text: null, points: 150, children: Array.from({ length: 3 }, (_, i) => ({ id: STORY_ID * 10 + i, author: `u${i}`, text: `<p>A substantive comment number ${i} about the raft consensus protocol tradeoffs and why they matter in practice here.</p>`, created_at_i: now - 9000 + i * 100, parent_id: STORY_ID, story_id: STORY_ID, points: null, type: 'comment', children: [] })) };

await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  if (/topstories/.test(u)) return json(r, [STORY_ID]);
  if (/(best|new|ask|show|job)stories/.test(u)) return json(r, []);
  const m = u.match(/item\/(\d+)/);
  if (m) return json(r, { ...story, id: Number(m[1]) });
  return json(r, null);
});
// Generic route FIRST so the specific /items/ route (registered next) WINS — Playwright runs
// matching routes in REVERSE registration order, so a catch-all registered LAST would shadow the
// comment-tree route with '{}', leaving the card with no comments (→ a refusal, not a summary).
await page.route(/hn\.algolia\.com|google\.com\/s2|gstatic\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => json(r, tree));
await page.route(/generativelanguage\.googleapis\.com/, (r) => {
  const u = r.request().url();
  if (/:generateContent/.test(u)) return json(r, { candidates: [{ content: { parts: [{ text: 'GEMINI_SUMMARY raft' }] } }] });
  return json(r, { models: [{ name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', supportedGenerationMethods: ['generateContent'] }] });
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
const resetPrompts = () =>
  page.evaluate(() =>
    window.__hnlens.prefs.getState().set({ prompts: { tldr: { system: '', user: '' }, thread: { system: '', user: '' }, ask: { system: '', user: '' }, user: { system: '', user: '' } } })
  );

// ============ Part A — Settings -> AI prompts (advanced) ============
await resetPrompts();
await page.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#sys-tldr', { timeout: 20000 });

const sysVal = await page.locator('#sys-tldr').inputValue();
check('Settings: system field is PRE-FILLED with the current prompt VALUE (not empty/placeholder)', sysVal.includes(DEF_TLDR_SYS), sysVal.slice(0, 50));
const usrVal = await page.locator('#usr-tldr').inputValue();
check('Settings: user-template field is PRE-FILLED with the current prompt VALUE', usrVal.includes(DEF_TLDR_USER), usrVal.slice(0, 50));

const sysFit = await page.locator('#sys-tldr').evaluate((el) => ({ ch: el.clientHeight, sh: el.scrollHeight }));
check('Settings: system textarea grows to show the full prompt (no vertical clip)', sysFit.ch >= sysFit.sh - 4, JSON.stringify(sysFit));

// Editing keeps the reference (does NOT wipe it) and stores an override.
await page.locator('#sys-tldr').fill(sysVal + ' EXTRA_EDIT');
await page.waitForTimeout(150);
const sysAfter = await page.locator('#sys-tldr').inputValue();
check('Settings: editing preserves the current prompt (reference not wiped on keystroke)', sysAfter.includes(DEF_TLDR_SYS) && sysAfter.includes('EXTRA_EDIT'), sysAfter.slice(-30));
const stored = await page.evaluate(() => window.__hnlens.prefs.getState().prompts.tldr.system);
check('Settings: an edit that differs from the default is stored as an override', stored.includes('EXTRA_EDIT'), stored.slice(-30));

// Reset restores the default text AND clears the override ('' = use default).
await page.locator('label[for="sys-tldr"] ~ *, #sys-tldr').first().waitFor().catch(() => {});
await page.getByRole('button', { name: 'Reset', exact: true }).first().click();
await page.waitForTimeout(150);
const sysReset = await page.locator('#sys-tldr').inputValue();
const storedReset = await page.evaluate(() => window.__hnlens.prefs.getState().prompts.tldr.system);
check('Settings: Reset restores the default text', sysReset.includes(DEF_TLDR_SYS) && !sysReset.includes('EXTRA_EDIT'), sysReset.slice(0, 40));
check("Settings: Reset clears the override (stores '' = use default)", storedReset === '', JSON.stringify(storedReset));

// A prompt longer than the grow cap becomes scrollable (capped height + overflow:auto), never
// clipped with no way to see the rest.
await page.locator('#sys-tldr').fill('LINE\n'.repeat(80));
await page.waitForTimeout(150);
const longFit = await page.locator('#sys-tldr').evaluate((el) => ({ ch: el.clientHeight, sh: el.scrollHeight, oy: getComputedStyle(el).overflowY }));
check('Settings: an over-cap prompt is capped and SCROLLABLE (not silently clipped)', longFit.sh > longFit.ch && longFit.oy === 'auto', JSON.stringify(longFit));

// ============ Part B — in-place "Edit prompt" dialog (card TL;DR path) ============
await resetPrompts();
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0, useLearnedRanker: false, embeddingsEnabled: false, hideReadInFeed: false, llmProvider: 'gemini', apiKeys: { gemini: 'g-key', openai: '', anthropic: '' }, showAiSummaries: true, prompts: { tldr: { system: '', user: '' }, thread: { system: '', user: '' }, ask: { system: '', user: '' }, user: { system: '', user: '' } } });
  location.hash = '#/';
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 });
await page.locator('article').first().getByRole('button', { name: /^TL;DR/ }).first().click();
await page.waitForFunction(() => /GEMINI_SUMMARY/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
// The controls row (with "Edit prompt") renders only on a real SUCCESS — assert the precondition
// explicitly so a thin/refusing fixture fails HERE, not cryptically at the Edit-prompt click below.
check('PRECONDITION: card TL;DR produced a real summary (controls row present)', /GEMINI_SUMMARY/.test(await page.evaluate(() => document.body.innerText)));
await page.locator('article .sc-tldr').first().getByRole('button', { name: 'Edit prompt' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => /Edit the .* prompt/i.test(d.textContent || '')), null, { timeout: 8000 });

const dlgSys = page.locator('[role="dialog"] textarea').first();
const dlgSysVal = await dlgSys.inputValue();
check('Dialog: system field is PRE-FILLED with the current prompt VALUE (not placeholder)', dlgSysVal.includes(DEF_TLDR_SYS), dlgSysVal.slice(0, 50));
const dlgFit = await dlgSys.evaluate((el) => ({ ch: el.clientHeight, sh: el.scrollHeight }));
check('Dialog: system textarea grows to show the full prompt (no vertical clip)', dlgFit.ch >= dlgFit.sh - 4, JSON.stringify(dlgFit));
await dlgSys.fill(dlgSysVal + ' DIALOG_EDIT');
const dlgAfter = await dlgSys.inputValue();
check('Dialog: editing preserves the current prompt (reference not wiped)', dlgAfter.includes(DEF_TLDR_SYS) && dlgAfter.includes('DIALOG_EDIT'), dlgAfter.slice(-30));
// Reset to defaults refills the default text into the box (not blank).
await page.getByRole('button', { name: /Reset to defaults/i }).click();
await page.waitForTimeout(150);
const dlgReset = await dlgSys.inputValue();
check('Dialog: "Reset to defaults" refills the default text (not a blank box)', dlgReset.includes(DEF_TLDR_SYS) && !dlgReset.includes('DIALOG_EDIT'), dlgReset.slice(0, 40));

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: PROMPT EDIT FIDELITY PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
