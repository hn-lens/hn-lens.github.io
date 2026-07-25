// Offline summarization eval: loads the app, loads a small LLM once (cached via a
// persistent browser profile), then compares prompt variants on real HN threads.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const PROFILE = '/tmp/hnlens-eval-profile'; // persistent => model weights cached across runs
const MODEL = process.env.LLM_ID || 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

// Needs a REAL WebGPU adapter (see modeltest). CDP_URL targets an already-running browser that has
// one; otherwise use the local persistent profile so weights are cached across runs.
const CDP_URL = process.env.CDP_URL || '';
const cdpBrowser = CDP_URL ? await chromium.connectOverCDP(CDP_URL) : null;
const ctx = cdpBrowser
  ? cdpBrowser.contexts()[0] || (await cdpBrowser.newContext())
  : await chromium.launchPersistentContext(PROFILE, {
      headless: true,
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal'],
      viewport: { width: 1200, height: 900 },
    });
// See modeltest: a CDP-attached browser outlives this script, so a page we open must be closed even
// on a crash. Only close a page we CREATED (never a pre-existing tab of the user's).
const preexisting = ctx.pages()[0];
const page = preexisting || (await ctx.newPage());
if (!preexisting) {
  const close = async () => { try { await page.close(); } catch { /* already gone */ } };
  for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
    process.once(sig, (e) => { void close(); if (e instanceof Error) { console.error(e); process.exit(1); } });
  }
}
page.on('pageerror', (e) => console.log('PAGEERR', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 40000 });

console.log('loading engine:', MODEL, '(first run downloads; later runs use cache)…');
await page.evaluate(async (model) => {
  window.__llm = await window.__hnlens.llm();
  window.__alg = await window.__hnlens.algolia();
  await window.__llm.getEngine(model);
}, MODEL);
console.log('engine ready.\n');

const stories = await page.evaluate(async () => {
  const r = await window.__alg.search({ tags: 'front_page', hitsPerPage: 25 });
  return r.hits
    .filter((h) => (h.num_comments || 0) > 120)
    .slice(0, 3)
    .map((h) => ({ id: Number(h.objectID), title: h.title, url: h.url, n: h.num_comments }));
});
console.log('threads:', stories.map((s) => `${s.id} (${s.n}c) ${s.title}`).join('\n         '), '\n');

// ---- prompt variants (built in Node, sent as plain message arrays) ----
const variants = [
  {
    name: 'A:current',
    maxTokens: 700,
    build: (i) => [
      {
        role: 'user',
        content: `You are summarizing a Hacker News discussion for a busy technical reader. Be concise, neutral, specific, and use markdown.

Title: ${i.title}
${i.url ? `Link: ${i.url}` : ''}

Top comments (indented by reply depth):
${i.comments.join('\n')}

Write, using markdown headings and bullets:
- A 3–5 sentence overview of what the discussion is about.
- "Key points": 3–5 bullets of the most substantive takeaways.
- "Debate": 1–2 bullets on the main disagreements, if any.`,
      },
    ],
  },
  {
    name: 'B:strict-template',
    maxTokens: 500,
    build: (i) => [
      {
        role: 'user',
        content: `Summarize this Hacker News discussion for someone who hasn't read it. Use ONLY the comments below; do not invent facts. Be specific and concise.

TITLE: ${i.title}

COMMENTS:
${i.comments.join('\n')}

Reply in exactly this format:
**Gist:** <2 sentences: what the post is about and why people are discussing it>
**What commenters say:**
- <specific point from the comments>
- <specific point>
- <specific point>
**Disagreement:** <1 sentence on the main split, or "Little disagreement.">`,
      },
    ],
  },
  {
    name: 'C:role+steps',
    maxTokens: 500,
    build: (i) => [
      {
        role: 'system',
        content:
          'You are an expert tech editor who writes tight, specific summaries of online discussions. You never repeat the prompt and never invent facts.',
      },
      {
        role: 'user',
        content: `Discussion title: "${i.title}"

Selected comments:
${i.comments.join('\n')}

Write a summary with:
1) A 2-3 sentence overview.
2) 3-4 bullet points of concrete takeaways or claims made by commenters.
3) One line on any disagreement.
Keep it under 150 words. Use markdown.`,
      },
    ],
  },
];

void variants; // kept for ad-hoc comparison; default run validates the shipped functions

for (const s of stories) {
  console.log('\n==================================================================');
  console.log(`THREAD ${s.id} — ${s.title} (${s.n} comments)`);
  console.log('==================================================================');

  const result = await page.evaluate(
    async ({ id, model }) => {
      const tree = await window.__alg.fetchItemTree(id);
      const comments = window.__llm.selectKeyComments(tree.children, 16);
      const summary = await window.__llm.summarizeThread(model, {
        title: tree.title,
        url: tree.url,
        selftext: tree.text,
        comments,
      });
      const tl = await window.__llm.tldr(model, { title: tree.title, comments });
      return { summary, tl };
    },
    { id: s.id, model: MODEL }
  );

  console.log(`\nTL;DR: ${result.tl.trim()}`);
  console.log(`\n${result.summary.trim()}`);
}

// Only tear down a context WE created. Over CDP this IS the real browser's context, so closing it
// would take every other tab the user has open with it. Disconnect instead, and close only a page
// we opened ourselves.
if (cdpBrowser) {
  if (!preexisting) await page.close().catch(() => {});
  await cdpBrowser.close().catch(() => {});
} else {
  await ctx.close();
}
console.log('\n\n(eval done)');
