// Compare comment-SELECTION strategies for summarization, fixing the model
// (Llama 3.2 1B). V1 = length/replies ranking (current). V2 = embedding MMR
// (relevant + diverse coverage = the embedding+LLM combo). Prints the exact
// inputs and outputs so they can be judged against the source.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = 'http://localhost:4173/';
const PROFILE = '/tmp/hnlens-eval-profile';
const MODEL = process.env.LLM_ID || 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
const EMB = 'Xenova/all-MiniLM-L6-v2';
const K = 16;
let out = '';
const log = (s = '') => {
  out += s + '\n';
  console.log(s);
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal'],
  viewport: { width: 1200, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
page.on('pageerror', (e) => log('PAGEERR ' + e.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 40000 });

log('loading LLM + embedding model…');
await page.evaluate(
  async ({ model, emb }) => {
    window.__llm = await window.__hnlens.llm();
    window.__alg = await window.__hnlens.algolia();
    window.__emb = await window.__hnlens.embeddings();
    await window.__llm.getEngine(model);
    await window.__emb.embedTexts(emb, ['warmup']);
  },
  { model: MODEL, emb: EMB }
);
log('ready.\n');

const stories = await page.evaluate(async () => {
  const r = await window.__alg.search({ tags: 'front_page', hitsPerPage: 25 });
  return r.hits
    .filter((h) => (h.num_comments || 0) > 150)
    .slice(0, 3)
    .map((h) => ({ id: Number(h.objectID), title: h.title, url: h.url, n: h.num_comments }));
});

for (const s of stories) {
  const data = await page.evaluate(
    async ({ id, emb, K, model }) => {
      const tree = await window.__alg.fetchItemTree(id);
      const infos = window.__llm.collectComments(tree.children).slice(0, 70); // bound embedding cost

      // V1: length/replies ranking (shipped)
      const v1 = window.__llm.selectKeyComments(tree.children, K);

      // V2: embedding MMR (relevant + diverse coverage)
      const vecs = await window.__emb.embedTexts(
        emb,
        infos.map((c) => c.text.slice(0, 500))
      );
      const dot = (a, b) => {
        let x = 0;
        for (let i = 0; i < a.length; i++) x += a[i] * b[i];
        return x;
      };
      const rel = infos.map(
        (c) => Math.min(c.text.length, 700) / 700 + (Math.min(c.replies, 12) / 12) * 0.6
      );
      const chosen = [];
      const remaining = new Set(infos.map((_, i) => i));
      let seed = 0;
      for (let i = 1; i < infos.length; i++) if (rel[i] > rel[seed]) seed = i;
      chosen.push(seed);
      remaining.delete(seed);
      while (chosen.length < Math.min(K, infos.length)) {
        let best = -1;
        let bestScore = -Infinity;
        for (const i of remaining) {
          let maxSim = 0;
          for (const j of chosen) {
            const sim = dot(vecs[i], vecs[j]);
            if (sim > maxSim) maxSim = sim;
          }
          const score = (1 - maxSim) * (0.5 + rel[i]);
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        }
        chosen.push(best);
        remaining.delete(best);
      }
      const v2infos = chosen.map((i) => infos[i]).sort((a, b) => a.created - b.created);
      const v2 = window.__llm.formatComments(v2infos);

      const sum1 = await window.__llm.summarizeThread(model, { title: tree.title, url: tree.url, comments: v1 });
      const sum2 = await window.__llm.summarizeThread(model, { title: tree.title, url: tree.url, comments: v2 });
      return { v1, v2, sum1, sum2 };
    },
    { id: s.id, emb: EMB, K, model: MODEL }
  );

  log('\n==================================================================');
  log(`THREAD ${s.id} — ${s.title} (${s.n} comments)`);
  log('==================================================================');
  log('\n--- V1 INPUT (length/replies ranking) ---');
  data.v1.forEach((c) => log(c));
  log('\n--- V2 INPUT (embedding MMR: relevant + diverse) ---');
  data.v2.forEach((c) => log(c));
  log('\n--- V1 OUTPUT ---\n' + data.sum1.trim());
  log('\n--- V2 OUTPUT ---\n' + data.sum2.trim());
}

await ctx.close();
writeFileSync('/tmp/inputeval.txt', out);
log('\n(input eval done -> /tmp/inputeval.txt)');
