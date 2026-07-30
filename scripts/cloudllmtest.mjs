// BYO cloud-LLM test — guards the feature: the user can pick a cloud provider (Gemini /
// OpenAI / Anthropic) and supply their own API key, and AI summaries then run via that
// provider's HTTP API — no WebGPU, no local model. Verifies: (1) generate() routes to the
// selected provider's endpoint and returns its text; (2) a missing key errors clearly;
// (3) the AI summary block works in the UI with WebGPU UNAVAILABLE when a cloud key is set;
// (4) provider + key persist. All provider endpoints are mocked (no real network/keys).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);
const STORY_ID = 7000;
const story = { id: STORY_ID, type: 'story', by: 'op', title: 'A story about raft consensus', url: 'https://ex.com/raft', score: 150, descendants: 6, time: now - 100000 };
const tree = {
  id: STORY_ID, story_id: STORY_ID, title: story.title, url: story.url, author: 'op', created_at_i: now - 100000, type: 'story', text: null, points: 150,
  children: Array.from({ length: 6 }, (_, i) => ({ id: STORY_ID * 10 + i, author: `u${i}`, text: `<p>A substantive comment number ${i} about the consensus protocol tradeoffs and why they matter in practice here.</p>`, created_at_i: now - 9000 + i * 100, parent_id: STORY_ID, story_id: STORY_ID, points: null, type: 'comment', children: [] })),
};
// A too-thin story (zero comments, no article/self-text) → summarizeItem REFUSES before any model
// call (tooThinToAnswer), returning request:[] plus a ZEROED-but-truthy sources object. The refusal
// must therefore show NO "Based on …" provenance line on EITHER surface (card TL;DR + thread) —
// that would describe a request that was never made. (A-class guard; pre-fix these lines rendered
// "Based on no readable content".)
const THIN_ID = 7050; // NOT STORY_ID+1 (7001) — section 9 uses that id and needs the non-thin tree
// One SHORT comment: enough for the discussion toolbar (hence the Summary tool) to render, but still
// far below the summarize threshold (tooThinToAnswer: <2 comments / <200 comment chars, <600 body),
// so BOTH the card TL;DR and the thread summary REFUSE.
const thinStory = { id: THIN_ID, type: 'story', by: 'op', title: 'A brand-new link, barely any discussion', url: 'https://ex.com/new', score: 50, descendants: 1, time: now - 300 };
const thinTree = {
  id: THIN_ID, story_id: THIN_ID, title: thinStory.title, url: thinStory.url, author: 'op', created_at_i: now - 300, type: 'story', text: null, points: 50,
  children: [{ id: THIN_ID * 10, author: 'x', text: '<p>ok</p>', created_at_i: now - 200, parent_id: THIN_ID, story_id: THIN_ID, points: null, type: 'comment', children: [] }],
};
// The Top feed id list is mutable so a late section can add the thin story without perturbing the
// earlier sections (which assume a single story in the feed).
let feedIds = [STORY_ID];

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());

const hits = { gemini: 0, openai: 0, anthropic: 0 };
let lastGeminiModel = '';
let lastGeminiMaxTokens = 0;
let lastGeminiSystem = ''; // the systemInstruction text sent on the last generate call
let geminiEmpty = false; // when true, simulate a "thinking" model that returned no text
let geminiFail = false; // when true, generateContent 500s → the cloud client throws (a transient failure)
let geminiListBad = false; // when true, the list-models endpoint returns 401 (bad key)
let lastOpenaiBody = null; // the last request body sent to OpenAI chat/completions
const json = (r, x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
// Gemini: one host for both list (?models) and generate (models/<m>:generateContent).
await page.route(/generativelanguage\.googleapis\.com/, (r) => {
  const u = r.request().url();
  if (/:generateContent/.test(u)) {
    hits.gemini++;
    lastGeminiModel = u.match(/models\/([^:]+):generateContent/)?.[1] ?? '';
    try {
      const body = JSON.parse(r.request().postData() || '{}');
      lastGeminiMaxTokens = body.generationConfig?.maxOutputTokens ?? 0;
      lastGeminiSystem = body.systemInstruction?.parts?.[0]?.text ?? '';
    } catch {
      lastGeminiMaxTokens = 0;
    }
    // A transient provider failure (rate limit / 5xx) → the cloud client throws → the surface shows
    // a "Could not summarize…" error, which must keep a retry control reachable (finding C).
    if (geminiFail) return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'rate limited' } }) });
    // A thinking model can burn the token budget on reasoning and return no text part.
    if (geminiEmpty) return json(r, { candidates: [{ finishReason: 'MAX_TOKENS', content: {} }] });
    return json(r, { candidates: [{ content: { parts: [{ text: 'GEMINI_SUMMARY raft' }] } }] });
  }
  // list models
  if (geminiListBad) return r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'bad key' } }) });
  return json(r, {
    models: [
      { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
    ],
  });
});
await page.route(/api\.openai\.com\/v1\/chat\/completions/, (r) => {
  hits.openai++;
  try {
    lastOpenaiBody = JSON.parse(r.request().postData() || '{}');
  } catch {
    lastOpenaiBody = null;
  }
  return json(r, { choices: [{ message: { content: 'OPENAI_SUMMARY raft' } }] });
});
await page.route(/api\.openai\.com\/v1\/models/, (r) =>
  json(r, { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }] })
);
await page.route(/api\.anthropic\.com\/v1\/messages/, (r) => {
  hits.anthropic++;
  return json(r, { content: [{ text: 'CLAUDE_SUMMARY raft' }] });
});
await page.route(/api\.anthropic\.com\/v1\/models/, (r) =>
  json(r, { data: [{ id: 'claude-3-5-haiku-latest', display_name: 'Claude 3.5 Haiku' }, { id: 'claude-3-5-sonnet-latest', display_name: 'Claude 3.5 Sonnet' }] })
);
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const j = (x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
  if (/topstories/.test(u)) return j(feedIds);
  if (/(best|new|ask|show|job)stories/.test(u)) return j([]);
  const m = u.match(/item\/(\d+)/);
  if (m) {
    const id = Number(m[1]);
    return j(id === STORY_ID ? story : id === THIN_ID ? thinStory : null);
  }
  return j(null);
});
// Generic route FIRST so the specific /items/ route (registered next) WINS — Playwright
// uses the last-registered matching route, so the comment tree isn't shadowed by '{}'.
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
await page.route(/hn\.algolia\.com\/api\/v1\/items\/(\d+)/, (r) => {
  const id = Number(r.request().url().match(/items\/(\d+)/)?.[1]);
  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(id === THIN_ID ? thinTree : tree) });
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs && window.__hnlens.llm, null, { timeout: 20000 });
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0, showAiSummaries: true, llmEnabled: false });
});

// ---- (1) generate() routes to the selected provider and returns its text ----
const routed = await page.evaluate(async () => {
  const llm = await window.__hnlens.llm();
  const out = {};
  for (const [provider, key] of [['gemini', 'g-key'], ['openai', 'o-key'], ['anthropic', 'a-key']]) {
    const cur = window.__hnlens.prefs.getState();
    cur.set({ llmProvider: provider, apiKeys: { ...cur.apiKeys, [provider]: key } });
    out[provider] = await llm.generate('ignored-local-model', [{ role: 'user', content: 'Summarize: hello' }], { maxTokens: 40 });
  }
  return out;
});
check('generate() routes to Gemini and returns its text', /GEMINI_SUMMARY/.test(routed.gemini), routed.gemini);
check('generate() routes to OpenAI and returns its text', /OPENAI_SUMMARY/.test(routed.openai), routed.openai);
check('generate() routes to Anthropic and returns its text', /CLAUDE_SUMMARY/.test(routed.anthropic), routed.anthropic);
check('each provider endpoint was actually called once', hits.gemini >= 1 && hits.openai >= 1 && hits.anthropic >= 1, JSON.stringify(hits));
// Cloud gets generous token headroom (thinking models spend output tokens reasoning); a
// tiny local-model cap (the TL;DR passes 40) would starve the answer → empty output.
check('cloud generate gives thinking models headroom (maxOutputTokens ≥ 4096)', lastGeminiMaxTokens >= 4096, `maxOutputTokens=${lastGeminiMaxTokens}`);

// ---- A1: OpenAI REASONING models (o1/o3/o4) need max_completion_tokens + no temperature ----
// The picker offers them (listModels keeps o-series ids), but they reject `max_tokens` and a
// non-default `temperature`. Assert a reasoning model's request uses the right params.
await page.evaluate(async () => {
  const llm = await window.__hnlens.llm();
  const cur = window.__hnlens.prefs.getState();
  cur.set({ llmProvider: 'openai', apiKeys: { ...cur.apiKeys, openai: 'o-key' }, cloudModels: { ...cur.cloudModels, openai: 'o3-mini' } });
  await llm.generate('ignored-local-model', [{ role: 'user', content: 'Summarize: hello' }], { maxTokens: 40 });
});
check(
  'OpenAI reasoning model uses max_completion_tokens (not max_tokens) and omits temperature',
  !!lastOpenaiBody &&
    lastOpenaiBody.model === 'o3-mini' &&
    typeof lastOpenaiBody.max_completion_tokens === 'number' &&
    !('max_tokens' in lastOpenaiBody) &&
    !('temperature' in lastOpenaiBody),
  JSON.stringify(lastOpenaiBody)
);
// A regular gpt model still uses max_tokens + temperature.
await page.evaluate(async () => {
  const llm = await window.__hnlens.llm();
  const cur = window.__hnlens.prefs.getState();
  cur.set({ llmProvider: 'openai', apiKeys: { ...cur.apiKeys, openai: 'o-key' }, cloudModels: { ...cur.cloudModels, openai: 'gpt-4o-mini' } });
  await llm.generate('ignored-local-model', [{ role: 'user', content: 'Summarize: hello' }], { maxTokens: 40 });
});
check(
  'OpenAI regular gpt model still uses max_tokens + temperature',
  !!lastOpenaiBody && lastOpenaiBody.model === 'gpt-4o-mini' && 'max_tokens' in lastOpenaiBody && 'temperature' in lastOpenaiBody,
  JSON.stringify(lastOpenaiBody)
);

// A thinking-truncated / empty response must surface a CLEAR error, not a blank summary.
const emptyErr = await page.evaluate(async () => {
  const llm = await window.__hnlens.llm();
  const cur = window.__hnlens.prefs.getState();
  cur.set({ llmProvider: 'gemini', apiKeys: { ...cur.apiKeys, gemini: 'g-key' } });
  try {
    await llm.generate('m', [{ role: 'user', content: 'x' }], { maxTokens: 40 });
    return 'NO_ERROR';
  } catch (e) {
    return String(e?.message || e);
  }
});
// Toggle the empty response for THIS assertion only.
geminiEmpty = true;
const emptyErr2 = await page.evaluate(async () => {
  const llm = await window.__hnlens.llm();
  try {
    await llm.generate('m', [{ role: 'user', content: 'x' }], { maxTokens: 40 });
    return 'NO_ERROR';
  } catch (e) {
    return String(e?.message || e);
  }
});
geminiEmpty = false;
void emptyErr;
check('an empty (thinking-truncated) response throws a clear error, not blank', /no text/i.test(emptyErr2), emptyErr2);

// ---- (2) a missing key errors clearly (no silent success) ----
const errMsg = await page.evaluate(async () => {
  const llm = await window.__hnlens.llm();
  window.__hnlens.prefs.getState().set({ llmProvider: 'gemini', apiKeys: { gemini: '', openai: '', anthropic: '' } });
  try {
    await llm.generate('m', [{ role: 'user', content: 'x' }]);
    return 'NO_ERROR';
  } catch (e) {
    return String(e?.message || e);
  }
});
check('a cloud provider with NO key throws a clear error', /API key/i.test(errMsg), errMsg);

// ---- (3) UI: with a cloud key set, AI summaries work even with WebGPU UNAVAILABLE ----
await page.evaluate(async () => {
  window.__hnlens.prefs.getState().set({ llmProvider: 'gemini', apiKeys: { gemini: 'g-key', openai: '', anthropic: '' }, llmEnabled: false, showAiSummaries: true });
});
await page.goto(`${BASE}#/item/${STORY_ID}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /comment/i.test(document.body.innerText), null, { timeout: 15000 });
await page.evaluate(async () => {
  // Force WebGPU unavailable AFTER load (startup probe may have set it); the cloud path
  // must not care.
  (await window.__hnlens.registry()).useModelStore.getState().setWebgpu('unavailable');
});
await page.waitForTimeout(300);
// The summary lives behind the toolbar's Summarize tool since the discussion header was collapsed
// into one row; open it before asserting on what it renders.
await page.getByRole('button', { name: /^Summary$/ }).first().click().catch(() => {});
await page.waitForTimeout(350);
const beforeText = await page.evaluate(() => document.body.innerText);
check('cloud key + no WebGPU: the AI summary block is shown (not the "needs WebGPU" notice)', /AI discussion summary/i.test(beforeText) && !/need WebGPU|needs WebGPU/i.test(beforeText), beforeText.match(/AI discussion summary|needs? WebGPU/i)?.[0] ?? 'neither');
check('cloud key + no WebGPU: the non-AI gist is hidden', !(await page.getByTestId('thread-gist').isVisible().catch(() => false)));
await page.getByRole('button', { name: 'Summarize', exact: true }).click();
await page.waitForFunction(() => /GEMINI_SUMMARY|Could not/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(400);
const afterClick = await page.evaluate(() => document.body.innerText);
check('clicking Summarize renders the cloud provider\'s summary', /GEMINI_SUMMARY/.test(afterClick), afterClick.match(/Could not[^\n]*/)?.[0] ?? '');
// The generated summary offers a local read-aloud (Listen) control — the summary text is
// already local, so this works with no reader proxy. (ListenButton renders null without
// text, so its presence confirms the summary text was wired through.)
check('the AI summary offers a Listen (read-aloud) control', (await page.getByRole('button', { name: /^Listen$/ }).count()) >= 1);

// ---- (5) listModels() queries each provider and filters to chat models ----
const models = await page.evaluate(async () => {
  const mod = await window.__hnlens.cloud();
  return {
    gemini: (await mod.listModels('gemini', 'k')).map((m) => m.id),
    openai: (await mod.listModels('openai', 'k')).map((m) => m.id),
    anthropic: (await mod.listModels('anthropic', 'k')).map((m) => m.id),
  };
});
check('listModels(gemini) returns generateContent models, excludes embeddings', models.gemini.includes('gemini-2.0-flash') && models.gemini.includes('gemini-1.5-pro') && !models.gemini.includes('text-embedding-004'), JSON.stringify(models.gemini));
check('listModels(openai) keeps gpt chat models, drops embedding/whisper', models.openai.includes('gpt-4o-mini') && models.openai.includes('gpt-4o') && !models.openai.includes('text-embedding-3-small') && !models.openai.includes('whisper-1'), JSON.stringify(models.openai));
check('listModels(anthropic) returns claude models', models.anthropic.includes('claude-3-5-sonnet-latest'), JSON.stringify(models.anthropic));

// ---- (6) Settings UI: Load models → pick one → it's saved and USED in generate ----
await page.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /AI provider/i.test(document.body.innerText), null, { timeout: 15000 });
await page.getByRole('combobox', { name: 'AI provider' }).selectOption('gemini');
await page.getByPlaceholder('AIza…').fill('g-key');
await page.getByRole('button', { name: 'Load models' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('option')].some((o) => o.value === 'gemini-1.5-pro'), null, { timeout: 15000 }).catch(() => {});
const modelOptions = await page.evaluate(() => [...document.querySelectorAll('option')].map((o) => o.value));
check('the Model picker populates from the provider (gemini-1.5-pro offered)', modelOptions.includes('gemini-1.5-pro'), JSON.stringify(modelOptions.filter((v) => /gemini/.test(v))));
await page.getByRole('combobox', { name: 'AI model' }).selectOption('gemini-1.5-pro');
const chosen = await page.evaluate(() => window.__hnlens.prefs.getState().cloudModels.gemini);
check('choosing a model saves it to prefs.cloudModels', chosen === 'gemini-1.5-pro', chosen);
// generate must use the CHOSEN model, not the default
lastGeminiModel = '';
await page.evaluate(async () => {
  await (await window.__hnlens.llm()).generate('local', [{ role: 'user', content: 'x' }], { maxTokens: 20 });
});
check('generate() uses the chosen model (gemini-1.5-pro)', lastGeminiModel === 'gemini-1.5-pro', lastGeminiModel);

// ---- (7) After RELOAD the picker SHOWS the chosen model (not the default). The fetched
// list is transient, so the chosen option must still be present (used === displayed). ----
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.goto(`${BASE}#/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /AI provider/i.test(document.body.innerText), null, { timeout: 15000 });
const shownModel = await page.evaluate(() => document.querySelector('select[aria-label="AI model"]')?.value);
check('after reload the Model picker SHOWS the chosen model, not the default', shownModel === 'gemini-1.5-pro', String(shownModel));

// ---- (8) A "Load models" error must NOT leak across a provider switch. ----
geminiListBad = true;
await page.getByPlaceholder('AIza…').fill('bad-key');
await page.getByRole('button', { name: 'Load models' }).click();
await page.waitForFunction(() => /invalid or unauthorized|API error/i.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 15000 }).catch(() => {});
check('Load-models shows an error for a bad key', /invalid or unauthorized|API error/i.test(await page.evaluate(() => document.querySelector('main')?.innerText ?? '')));
await page.getByRole('combobox', { name: 'AI provider' }).selectOption('anthropic');
await page.waitForTimeout(250);
check('the Load-models error clears when switching provider (no leak)', !/invalid or unauthorized/i.test(await page.evaluate(() => document.querySelector('main')?.innerText ?? '')));
geminiListBad = false;

// ---- (9) LLM transparency + control: full request is returned, a CUSTOM system
// instruction flows into the actual request, and changing it re-summarizes (cache key). ----
const trans = await page.evaluate(async (id) => {
  const llm = await window.__hnlens.llm();
  const dbMod = await window.__hnlens.db();
  const p = window.__hnlens.prefs.getState();
  // Override BOTH prompt parts: a custom system instruction AND a custom user TEMPLATE with a
  // {title} placeholder — both must flow into the actual request, and the template's data
  // must be substituted.
  p.set({
    llmProvider: 'gemini',
    apiKeys: { ...p.apiKeys, gemini: 'g-key' },
    prompts: { ...p.prompts, tldr: { system: 'CUSTOM_SYS_INSTRUCTION', user: 'TEMPLATE_MARK about {title}' } },
  });
  await dbMod.db.kv.where('key').startsWith('sum:').delete();
  const item = { id, title: 'Transparency test', url: 'https://ex.com/t', text: '' };
  const r1 = await llm.summarizeItem('local', 'tldr', item, { fetchArticle: false, force: true });
  const r2 = await llm.summarizeItem('local', 'tldr', item, { fetchArticle: false }); // should be cached
  const pp = window.__hnlens.prefs.getState();
  pp.set({ prompts: { ...pp.prompts, tldr: { system: 'A DIFFERENT INSTRUCTION', user: '' } } });
  const r3 = await llm.summarizeItem('local', 'tldr', item, { fetchArticle: false }); // key changed → miss
  return {
    reqRoles: r1.request.map((m) => m.role),
    sysContent: r1.request.find((m) => m.role === 'system')?.content ?? '',
    userContent: r1.request.find((m) => m.role === 'user')?.content ?? '',
    r2cached: r2.cached,
    r3cached: r3.cached,
  };
}, STORY_ID + 1);
check('summary result returns the full request (system + user messages)', trans.reqRoles.includes('system') && trans.reqRoles.includes('user'), JSON.stringify(trans.reqRoles));
check('the request carries the CUSTOM system instruction', /CUSTOM_SYS_INSTRUCTION/.test(trans.sysContent), trans.sysContent.slice(0, 40));
check(
  'the USER message uses the custom template with the data substituted',
  /TEMPLATE_MARK/.test(trans.userContent) && /Transparency test/.test(trans.userContent),
  trans.userContent.slice(0, 60)
);
// lastGeminiSystem reflects the MOST RECENT generate call (r3, after the instruction was
// changed) — so it proves the current custom system instruction flows to the wire.
check('the custom system instruction is sent in the actual provider request', /A DIFFERENT INSTRUCTION/.test(lastGeminiSystem), lastGeminiSystem.slice(0, 40));
check('an unchanged system instruction serves the cache (2nd call cached)', trans.r2cached === true, String(trans.r2cached));
check('changing the system instruction re-summarizes (cache invalidated)', trans.r3cached === false, String(trans.r3cached));

// ---- (4) provider + key persist across reload ----
// ---- (10) CARD path: the TL;DR controls (Refresh/View request/Edit) must be CLICKABLE —
// not covered by the card's stretched title link (a z-index bug that made them dead). ----
await page.evaluate(async () => {
  await (await window.__hnlens.interactions()).clearAllData();
  window.__hnlens.prefs.getState().set({ defaultFeed: 'top', minPoints: 0, llmProvider: 'gemini', apiKeys: { gemini: 'g-key', openai: '', anthropic: '' }, showAiSummaries: true, prompts: { tldr: { system: '', user: '' }, thread: { system: '', user: '' }, ask: { system: '', user: '' }, user: { system: '', user: '' } } });
  location.hash = '#/';
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Top', exact: true }).click();
await page.waitForSelector('article', { timeout: 15000 });
// The sidebar "Local models" LLM row must reflect the ACTIVE cloud backend, not read "off"
// (which was misleading while a cloud provider was serving AI).
{
  const sbLlm = await page.evaluate(() => document.querySelector('.app-sidebar')?.innerText ?? '');
  check('sidebar LLM row shows the active cloud provider, not "off", when cloud is keyed', /via Gemini/.test(sbLlm), sbLlm.split('\n').find((l) => /via Gemini/.test(l)) ?? sbLlm.slice(0, 80));
}
// Match the TL;DR control by name PREFIX — the label carries an honest source hint
// ("TL;DR (discussion)" when article text is off, "· local LLM" without a cloud key).
await page.locator('article').first().getByRole('button', { name: /^TL;DR/ }).first().click();
await page.waitForFunction(() => /GEMINI_SUMMARY/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(300);
const cardCtl = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('article .sc-tldr button')].find((x) => /View request/i.test(x.textContent || ''));
  if (!btn) return { ok: false, reason: 'no control found' };
  const r = btn.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { ok: el === btn || btn.contains(el), hit: el?.tagName };
});
check('card TL;DR controls are clickable (not under the stretched title link)', cardCtl.ok, JSON.stringify(cardCtl));
// clicking "View request" opens the request modal from the card path too
await page.locator('article .sc-tldr').first().getByRole('button', { name: 'View request' }).click();
await page.waitForTimeout(300);
check('card "View request" opens the request modal', await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => /Request sent to the model/i.test(d.textContent || ''))));
await page.keyboard.press('Escape').catch(() => {});

// ---- (11) The sidebar "N signals recorded locally" is clickable → opens the signals viewer. ----
const sidebarSignals = page.locator('.app-sidebar').getByRole('button', { name: /signals recorded locally/i });
check('sidebar signals count is a clickable control', await sidebarSignals.isVisible().catch(() => false));
await sidebarSignals.click().catch(() => {});
await page.waitForTimeout(250);
check('sidebar signals count opens the signals viewer', await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => /Signals recorded locally/i.test(d.textContent || ''))));
await page.keyboard.press('Escape').catch(() => {});

// "Your interests" chips are actionable (click to unfollow), not dead text.
await page.evaluate(() => window.__hnlens.prefs.getState().set({ followedDomains: ['chip.example'] }));
await page.waitForTimeout(200);
const chip = page.locator('.app-sidebar').getByRole('button', { name: /chip\.example/i });
check('a "Your interests" chip is a clickable control', await chip.isVisible().catch(() => false));
await chip.click().catch(() => {});
await page.waitForTimeout(150);
check('clicking an interest chip unfollows it', !(await page.evaluate(() => window.__hnlens.prefs.getState().followedDomains.includes('chip.example'))));

// ---- (12) PROVENANCE HONESTY on a REFUSAL (A class): a too-thin story the model refuses to
// summarize must NOT show a "Based on …" line — nothing was sent to a model. Both surfaces:
// the card TL;DR (StoryCard) AND the discussion thread (ThreadSummary). Gemini key still set. ----
feedIds = [STORY_ID, THIN_ID]; // add the zero-comment story to the Top feed
await page.evaluate(async () => {
  // Bust the Dexie list/item caches — section 10 cached top=[STORY_ID], which would otherwise be
  // served on reload and the fresh feedIds never fetched.
  const { db } = await window.__hnlens.db();
  await db.lists.clear();
  await db.items.clear();
  window.__hnlens.prefs.getState().set({ llmProvider: 'gemini', apiKeys: { gemini: 'g-key', openai: '', anthropic: '' }, showAiSummaries: true });
  location.hash = '#/';
});
await page.reload({ waitUntil: 'domcontentloaded' }); // full reload → fresh topstories fetch
await page.waitForFunction(() => window.__hnlens, null, { timeout: 20000 });
await page.getByRole('button', { name: 'Top', exact: true }).click();
// Wait for the thin card itself to render (fail loudly here rather than at a downstream click).
await page.waitForFunction(() => [...document.querySelectorAll('article')].some((a) => /barely any discussion/.test(a.textContent || '')), null, { timeout: 15000 });
{
  const thinCard = page.locator('article').filter({ hasText: 'barely any discussion' }).first();
  await thinCard.getByRole('button', { name: /^TL;DR/ }).first().click();
  await page.waitForFunction(() => /Not enough to summarize/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  const tldrBlock = await thinCard.locator('.sc-tldr').innerText().catch(() => '');
  check('card TL;DR refusal shows the honest "not enough" text', /Not enough to summarize/i.test(tldrBlock), tldrBlock.replace(/\s+/g, ' ').slice(0, 80));
  check('card TL;DR refusal shows NO "Based on" provenance (nothing was sent)', !/Based on/i.test(tldrBlock), tldrBlock.match(/Based on[^\n]*/i)?.[0] ?? '(clean)');
  // A deterministic refusal offers no useful controls — Refresh just re-refuses and "Edit prompt" is
  // inoperative (a thin-input refusal short-circuits before any prompt is used). Row hidden (like thread/ask).
  check('card TL;DR refusal hides the controls row (no Refresh / Edit prompt)', !/Refresh|Edit prompt/i.test(tldrBlock), tldrBlock.match(/Refresh|Edit prompt/i)?.[0] ?? '(clean)');
}
{
  await page.goto(`${BASE}#/item/${THIN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /barely any discussion/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  await page.getByRole('button', { name: /^Summary$/ }).first().click().catch(() => {}); // open the toolbar tray
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Summarize', exact: true }).click().catch(() => {});
  await page.waitForFunction(() => /Not enough to summarize/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  // Scope to the summary block: the element that carries the refusal text AND a rendered .hn-html body.
  const threadBlock = await page.evaluate(() => {
    const host = [...document.querySelectorAll('div')].find((d) => /Not enough to summarize/i.test(d.textContent || '') && d.querySelector('.hn-html'));
    return (host ?? document.querySelector('main'))?.innerText ?? '';
  });
  check('thread summary refusal shows the honest "not enough" text', /Not enough to summarize/i.test(threadBlock), threadBlock.replace(/\s+/g, ' ').slice(0, 80));
  check('thread summary refusal shows NO "Based on" provenance (nothing was sent)', !/Based on/i.test(threadBlock), threadBlock.match(/Based on[^\n]*/i)?.[0] ?? '(clean)');
}

// ---- (13) A FAILED generation KEEPS a retry reachable (finding C): a transient provider error
// (here a 500) must still show a retry control (Refresh) — but NO "Based on"/caveat/attribution,
// since nothing ran successfully. Distinct from a deterministic refusal, which hides the row (§12). ----
geminiFail = true;
await page.evaluate(async () => {
  const { db } = await window.__hnlens.db();
  await db.kv.where('key').startsWith('sum:').delete(); // force a cache MISS so the model is actually CALLED (and 500s)
});
{
  // CARD: back to the Top feed (§12 left us on a discussion page), then the non-thin raft card's
  // TL;DR → the model call 500s → error branch.
  await page.evaluate(() => { location.hash = '#/'; });
  await page.getByRole('button', { name: 'Top', exact: true }).click().catch(() => {});
  await page.waitForFunction(() => [...document.querySelectorAll('article')].some((a) => /raft consensus/.test(a.textContent || '')), null, { timeout: 15000 });
  const raftCard = page.locator('article').filter({ hasText: 'raft consensus' }).first();
  await raftCard.getByRole('button', { name: /^TL;DR/ }).first().click();
  await page.waitForFunction(() => /Could not/i.test(document.querySelector('.sc-tldr')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  const errBlock = await raftCard.locator('.sc-tldr').innerText().catch(() => '');
  check('card TL;DR error shows the honest "could not" text', /Could not/i.test(errBlock), errBlock.replace(/\s+/g, ' ').slice(0, 80));
  check('card TL;DR error KEEPS a retry control (Refresh)', /Refresh/i.test(errBlock), errBlock.match(/Refresh/i)?.[0] ?? '(missing)');
  check('card TL;DR error shows NO "Based on"/AI-generated (nothing ran)', !/Based on|AI-generated/i.test(errBlock), (errBlock.match(/Based on[^\n]*|AI-generated[^\n]*/i) || ['(clean)'])[0]);
}
{
  // THREAD: a discussion summary whose model call 500s → error branch keeps Refresh reachable.
  await page.goto(`${BASE}#/item/${STORY_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /raft consensus/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  await page.getByRole('button', { name: /^Summary$/ }).first().click().catch(() => {}); // open the tray
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Summarize', exact: true }).click().catch(() => {});
  await page.waitForFunction(() => /Could not summarize/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  const threadErr = await page.evaluate(() => {
    const host = [...document.querySelectorAll('div')].find((d) => /AI discussion summary/i.test(d.textContent || ''));
    return (host ?? document.querySelector('main'))?.innerText ?? '';
  });
  check('thread summary error shows the honest "could not" text', /Could not summarize/i.test(threadErr), threadErr.match(/Could not[^\n]*/i)?.[0] ?? '(none)');
  check('thread summary error KEEPS a retry control (Refresh)', /Refresh/i.test(threadErr), threadErr.match(/Refresh/i)?.[0] ?? '(missing)');
  check('thread summary error shows NO "Based on"/AI-generated (nothing ran)', !/Based on|AI-generated/i.test(threadErr), (threadErr.match(/Based on[^\n]*|AI-generated[^\n]*/i) || ['(clean)'])[0]);
}
geminiFail = false;

await page.evaluate(() => window.__hnlens.prefs.getState().set({ llmProvider: 'openai', apiKeys: { gemini: '', openai: 'persist-key', anthropic: '' } }));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
const persisted = await page.evaluate(() => {
  const s = window.__hnlens.prefs.getState();
  return { provider: s.llmProvider, key: s.apiKeys.openai };
});
check('the chosen provider persists across reload', persisted.provider === 'openai', persisted.provider);
check('the API key persists across reload', persisted.key === 'persist-key', persisted.key ? 'present' : 'missing');

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: CLOUD LLM PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
