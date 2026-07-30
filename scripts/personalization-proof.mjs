// ============================================================================
// Personalization proof harness
// ----------------------------------------------------------------------------
// Proves — with data, not vibes — that Hacker Lens actually LEARNS from your history
// and CHANGES what you see. Every number below is produced by the *real* app
// modules (train / logistic / features / strategies / interactions / embeddings),
// driven through window.__hnlens; nothing here reimplements the ranking.
//
// The experiment is a controlled, deterministic A/B:
//   1. Seed a KNOWN taste as interaction history (loves arXiv papers + Rust +
//      user "pg"; ignores/​hides crypto). This is "your history".
//   2. Run the real pipeline and capture every intermediate:
//        DATA      → events + learned affinities
//        TRAIN     → logistic model (empty→fitted), loss curve, train/held-out AUC
//        CORRECT   → weight signs + P(engage) separation on held-out items
//        USED      → recompute score by hand == scoreItem(); toggle model → term=0
//        CAUSAL    → rank a held-out pool cold vs personalized; liked items rise
//        EMBEDDINGS→ real cosine-similarity relevance recovers the taste
//   3. Drive the real For-You UI over a MOCKED HN API so the screenshots show the
//      controlled taste end-to-end, plus the Settings reranker "Active · personalizing" status.
//
// Output: scripts/.artifacts/personalization-report.json (+ two screenshots),
// consumed by scripts/personalization-report.mjs to render the visual dashboard.
// Exit code is non-zero if any assertion fails.
// ============================================================================
import { chromium } from 'playwright';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:4173/';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '.artifacts');
const PROFILE_DIR = '/tmp/hnlens-personalization-proof';
mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE_DIR, { recursive: true, force: true });

const FEATURE_NAMES = [
  'popularity',
  'recency',
  'discussion',
  'domainAffinity',
  'authorAffinity',
  'relevance',
  'termAffinity',
  'popXrec',
  'domAffXdisc',
  'relXterm',
];

// ---------------------------------------------------------------------------
// Synthetic-but-realistic dataset. Ground-truth taste is engineered so that a
// NON-personalized ranker gets it "wrong" (crypto has the highest HN scores),
// and only learning-from-history flips it — that gap is the proof.
// ---------------------------------------------------------------------------
function buildDataset() {
  const now = Math.floor(Date.now() / 1000);
  const H = 3600;
  const items = [];
  const events = [];
  const embeddings = [];
  const EMB_MODEL = 'Xenova/all-MiniLM-L6-v2';

  const norm = (v) => {
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
  };
  // 8-dim toy embedding space: like≈axis0, dislike(crypto)≈axis1, neutral≈axis2.
  const VEC = {
    like: norm([1, 0.05, 0.05, 0.02, 0, 0, 0, 0]),
    dislike: norm([0.05, 1, 0.05, 0.02, 0, 0, 0, 0]),
    neutral: norm([0.05, 0.05, 1, 0.02, 0, 0, 0, 0]),
  };
  const embFor = (topic) =>
    topic === 'crypto' ? VEC.dislike : topic === 'liked' ? VEC.like : VEC.neutral;

  const domainFor = { arxiv: 'arxiv.org', rust: 'github.com', crypto: 'crypto.example', buzz: 'buzz.example', news: 'news.example', dev: 'dev.example' };
  const urlFor = (kind, id) => `https://${domainFor[kind]}/${kind}/${id}`;

  const addItem = (id, kind, { by, score, desc, title, embTopic, ageH }) => {
    items.push({
      id,
      type: 'story',
      by,
      time: now - (ageH ?? 6) * H,
      url: urlFor(kind, id),
      score,
      title,
      descendants: desc,
    });
    embeddings.push({ id, vec: embFor(embTopic), model: EMB_MODEL });
  };
  const ev = (type, id, kind, by, tsAgoH) =>
    events.push({ type, itemId: id, domain: domainFor[kind], author: by, ts: Date.now() - (tsAgoH ?? 1) * H * 1000 });

  // ---- HISTORY: positives (engaged) — arXiv papers + Rust + user "pg" ----
  const posArxiv = [
    [1001, 'pg', 'Attention is all you need, revisited'],
    [1002, 'pg', 'Scaling laws for neural language models'],
    [1003, 'dang', 'A mathematical framework for transformer circuits'],
    [1004, 'pg', 'Emergent abilities of large language models'],
    [1005, 'tptacek', 'Chain-of-thought prompting elicits reasoning'],
    [1006, 'pg', 'Grokking: generalization beyond overfitting'],
  ];
  for (const [id, by, title] of posArxiv) {
    addItem(id, 'arxiv', { by, score: 40 + (id % 30), desc: 20 + (id % 25), title, embTopic: 'liked' });
    ev('impression', id, 'arxiv', by, 30);
    ev('open_link', id, 'arxiv', by, 29);
    ev('open_comments', id, 'arxiv', by, 29);
    ev('save', id, 'arxiv', by, 28);
  }
  ev('upvote_out', 1002, 'arxiv', 'pg', 27);
  ev('upvote_out', 1004, 'arxiv', 'pg', 27);

  const posRust = [
    [1010, 'burntsushi', 'Ripgrep 15: even faster searching in Rust'],
    [1011, 'steveklabnik', 'Async Rust: a runtime from scratch'],
    [1012, 'josh', 'Zero-cost abstractions in Rust, explained'],
    [1013, 'matklad', 'Rust-analyzer architecture deep dive'],
    [1014, 'dtolnay', 'Serde: fast serialization in Rust'],
    [1015, 'pg', 'Why we rewrote our backend in Rust'],
  ];
  for (const [id, by, title] of posRust) {
    addItem(id, 'rust', { by, score: 55 + (id % 40), desc: 30 + (id % 30), title, embTopic: 'liked' });
    ev('impression', id, 'rust', by, 20);
    ev('open_link', id, 'rust', by, 19);
    ev('save', id, 'rust', by, 18);
  }
  ev('open_comments', 1010, 'rust', 'burntsushi', 19);
  ev('summarize', 1013, 'rust', 'matklad', 18);

  // ---- COMMENT CONTENT: a distinctive term ("wasm"/"sandbox") that appears ONLY
  // in the comments of engaged threads — never in any title. Proves comment text
  // (not just clicks) feeds the model. ----
  const comments = {};
  const wasmComments = [
    'You can compile this project to wasm and run the whole thing inside a browser sandbox, which is great for portability and safety.',
    'The wasm sandbox model gives you strong isolation between modules; I shipped this to production and the sandbox held up under load.',
    'Running it as wasm in the browser means no install step at all, and the sandbox keeps untrusted plugin code fully contained.',
  ];
  for (const id of [1010, 1011, 1012, 1013]) comments[id] = wasmComments;
  comments[1002] = ['The appendix on scaling behaviour is worth reading closely; it matched my own experiments almost exactly.'];

  // ---- HISTORY: negatives — crypto (ignored + some HIDDEN) + buzz (ignored) ----
  const negCrypto = [
    [1020, 'satoshi', 'Bitcoin surges past $90k'],
    [1021, 'satoshi', 'New L2 blockchain promises 1M TPS'],
    [1022, 'cryptobro', 'DeFi yield farming for beginners'],
    [1023, 'cryptobro', 'This NFT sold for 4000 ETH'],
    [1024, 'satoshi', 'Why crypto is the future of money'],
    [1025, 'cryptobro', 'Altcoin season is here'],
    [1026, 'satoshi', 'Stablecoin depeg explained'],
    [1027, 'cryptobro', 'Meme coin mania continues'],
  ];
  negCrypto.forEach(([id, by, title], i) => {
    addItem(id, 'crypto', { by, score: 120 + id, desc: 80 + id, title, embTopic: 'crypto' });
    ev('impression', id, 'crypto', by, 25);
    if (i < 4) ev('hide', id, 'crypto', by, 24); // strong negative signal
  });

  const negBuzz = [
    [1030, 'influencer', '10 productivity hacks that changed my life'],
    [1031, 'influencer', 'You won\u2019t believe what happened next'],
    [1032, 'influencer', 'The one weird trick to riches'],
    [1033, 'influencer', 'Going viral: a thread'],
  ];
  for (const [id, by, title] of negBuzz) {
    addItem(id, 'buzz', { by, score: 90 + id, desc: 40 + id, title, embTopic: 'neutral' });
    ev('impression', id, 'buzz', by, 22);
  }

  // ---- HELD-OUT candidate pool (ids 2000+): model has never seen these ----
  // Crypto is given the HIGHEST HN scores on purpose: a cold ranker ranks it top.
  const liked = [];
  const disliked = [];
  const neutral = [];
  const cand = (id, kind, embTopic, bucket, o) => {
    addItem(id, kind, { ...o, embTopic });
    bucket.push(id);
  };
  cand(2001, 'arxiv', 'liked', liked, { by: 'pg', score: 62, desc: 40, title: 'Sparse attention scaling laws for LLMs' });
  cand(2002, 'arxiv', 'liked', liked, { by: 'dang', score: 48, desc: 25, title: 'A new optimizer for deep networks' });
  cand(2003, 'rust', 'liked', liked, { by: 'burntsushi', score: 88, desc: 55, title: 'Building a search engine in Rust' });
  cand(2004, 'rust', 'liked', liked, { by: 'steveklabnik', score: 54, desc: 30, title: 'Fearless concurrency in Rust' });
  cand(2005, 'arxiv', 'liked', liked, { by: 'pg', score: 71, desc: 44, title: 'Mechanistic interpretability of transformers' });

  cand(2010, 'crypto', 'crypto', disliked, { by: 'satoshi', score: 520, desc: 300, title: 'Bitcoin hits an all-time high today' });
  cand(2011, 'crypto', 'crypto', disliked, { by: 'satoshi', score: 430, desc: 210, title: 'Ethereum L2 rollup breaks records' });
  cand(2012, 'crypto', 'crypto', disliked, { by: 'cryptobro', score: 380, desc: 190, title: 'New DeFi protocol launches token' });
  cand(2013, 'crypto', 'crypto', disliked, { by: 'cryptobro', score: 300, desc: 150, title: 'NFT marketplace raises $50M' });
  cand(2014, 'crypto', 'crypto', disliked, { by: 'satoshi', score: 260, desc: 170, title: 'Crypto regulation bill advances' });

  cand(2020, 'news', 'neutral', neutral, { by: 'reporter', score: 150, desc: 90, title: 'Big tech company reports earnings' });
  cand(2021, 'news', 'neutral', neutral, { by: 'reporter', score: 180, desc: 110, title: 'New flagship phone announced' });
  cand(2022, 'news', 'neutral', neutral, { by: 'reporter', score: 130, desc: 70, title: 'Scientists observe rare event' });
  cand(2023, 'news', 'neutral', neutral, { by: 'reporter', score: 160, desc: 100, title: 'Election results are in' });
  cand(2024, 'news', 'neutral', neutral, { by: 'reporter', score: 120, desc: 60, title: 'Local sports team wins final' });

  // ---- COMMENT-CONTENT PROBE: two near-identical stories on a neutral domain the
  // user has no domain/author/embedding affinity for. They differ by ONE word:
  // 2006's title contains "wasm/sandbox" (a term that only ever appeared in
  // COMMENTS of engaged threads); 2007 does not. Any rank gap ⇒ comment text drove it.
  const commentProbe = [];
  const probe = (id, title) => {
    addItem(id, 'dev', { by: 'randomdev', score: 60, desc: 30, title, embTopic: 'neutral' });
    commentProbe.push(id);
  };
  probe(2006, 'wasm sandbox internals');
  probe(2007, 'kubernetes cluster internals');

  // ---- ARTICLE-TEXT PROBE: two neutral-domain stories seeded (not in the feed).
  // With the reader proxy ON, engaged items' ARTICLE BODIES contribute the term
  // "raft" (present only in article text, never in titles/comments); 2008 has it. ----
  const articleProbe = [];
  const aprobe = (id, title) => {
    addItem(id, 'dev', { by: 'randomdev', score: 60, desc: 30, title, embTopic: 'neutral' });
    articleProbe.push(id);
  };
  aprobe(2008, 'raft consensus internals');
  aprobe(2009, 'gossip protocol internals');

  const candidateIds = [...disliked, ...neutral, ...liked, ...commentProbe]; // crypto-first (as a real feed would be)
  return { items, events, embeddings, comments, liked, disliked, neutral, commentProbe, articleProbe, candidateIds, EMB_MODEL };
}

// The mocked reader proxies return this for any engaged article — it carries the
// term "raft", which appears in NO title or comment (isolates article-body effect).
// Must exceed the fetcher's MIN_USABLE length so it counts as real content.
const ARTICLE_BODY =
  'A deep technical dive into the raft consensus algorithm for distributed systems. ' +
  'This article explains how raft handles leader election, log replication, membership changes, ' +
  'and safety, and how raft compares to paxos and to zab. It walks through raft term numbers, ' +
  'heartbeats, and quorum commit rules with worked examples so engineers can implement raft correctly.';

const DATA = buildDataset();

// ---------------------------------------------------------------------------
// Playwright: mock the HN API so the real For-You UI ranks our controlled data.
// ---------------------------------------------------------------------------
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: true,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

const itemById = new Map(DATA.items.map((it) => [it.id, it]));
await page.route(/hacker-news\.firebaseio\.com/, async (route) => {
  const url = route.request().url();
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.includes('/topstories.json')) return json(DATA.candidateIds);
  if (url.includes('/beststories.json')) return json(DATA.candidateIds);
  if (url.includes('/newstories.json')) return json([...DATA.liked, ...DATA.neutral]);
  if (/\/(ask|show|job)stories\.json/.test(url)) return json([]);
  const m = url.match(/\/item\/(\d+)\.json/);
  if (m) return json(itemById.get(Number(m[1])) ?? null);
  if (url.includes('/maxitem.json')) return json(2100);
  return json(null);
});
await page.route(/hn\.algolia\.com/, (route) => {
  const url = route.request().url();
  const m = url.match(/\/items\/(\d+)/);
  if (m) {
    const id = Number(m[1]);
    const texts = DATA.comments[id] || [];
    const children = texts.map((t, i) => ({
      id: id * 100 + i, created_at_i: 1_700_000_000 + i, author: `commenter${i}`, text: t,
      parent_id: id, story_id: id, points: 8 - i, type: 'comment', children: [],
    }));
    const body = { id, created_at_i: 1_700_000_000, author: 'op', title: '', url: '', text: '', points: 10, parent_id: null, story_id: id, children, type: 'story' };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hits: [] }) });
});
await page.route(/google\.com\/s2\/favicons|gstatic\.com\/faviconV2/, (route) => route.fulfill({ status: 200, body: '' }));
// Mocked free reader proxies for the opt-in article-text feature (see PHASE 9).
await page.route(/allorigins\.win|cors\.eu\.org|codetabs\.com/, (route) =>
  route.fulfill({ status: 200, contentType: 'text/plain', body: ARTICLE_BODY })
);

const log = [];
const say = (s) => {
  console.log(s);
  log.push(s);
};
const assertions = [];
const check = (name, pass, detail) => {
  assertions.push({ name, pass: !!pass, detail: detail ?? '' });
  say(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
};

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });

// ===========================================================================
// PHASE 1 — seed history, then run the whole pipeline via the REAL modules.
// ===========================================================================
say('\n[1] DATA — seeding a known taste as interaction history');
const report = await page.evaluate(async (D) => {
  const H = window.__hnlens;
  const [{ db }, interactions, train, logistic, features, strategies, content] = await Promise.all([
    H.db(),
    H.interactions(),
    H.train(),
    H.logistic(),
    H.features(),
    H.strategies(),
    H.content(),
  ]);

  // ---- reset & seed (all through the real db layer) ----
  await interactions.clearAllData();
  H.prefs.getState().set({
    weights: { popularity: 1.0, recency: 1.0, discussion: 0.6, affinity: 1.4, relevance: 1.2, learned: 0.8 },
    followedDomains: [], followedUsers: [], mutedDomains: [], mutedUsers: [],
    keywordsBoost: ['rust', 'llm'], keywordsMute: [], minPoints: 0,
    embeddingsEnabled: true, embeddingModel: D.EMB_MODEL,
    useLearnedRanker: true, llmEnabled: false, defaultFeed: 'foryou',
    hideReadInFeed: false, // this proof seeds read/engaged items and asserts they RANK in For You
  });
  const now = Date.now();
  await db.items.bulkPut(D.items.map((item) => ({ id: item.id, item, cachedAt: now })));
  await db.events.bulkAdd(D.events.map((e) => ({ ...e })));
  await db.embeddings.bulkPut(D.embeddings.map((r) => ({ id: r.id, vec: r.vec, model: r.model })));

  const eventRows = await db.events.toArray();
  const eventCounts = {};
  for (const e of eventRows) eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;

  // ---- learned affinities (real) ----
  const aff = await interactions.computeAffinities();
  const sortRec = (o) => Object.entries(o).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);

  // ---- training data + model (real) ----
  const td = await train.buildTrainingSamples();
  const samples = td.samples;
  const labels = samples.map((s) => s.y);

  // The exact labelled samples the model fits on (feature matrix + label), with
  // the story each row came from — this IS the training data.
  const idToItem = new Map(D.items.map((it) => [it.id, it]));
  const topicOf = (it, label) => {
    const url = it && it.url ? it.url : '';
    if (label === 1) return 'liked';
    return /crypto\./.test(url) ? 'crypto' : 'neutral';
  };
  const trainingData = samples.map((s, i) => {
    const id = td.sampleIds[i];
    const it = idToItem.get(id);
    return {
      id, title: it ? it.title : '', label: s.y,
      topic: topicOf(it, s.y),
      x: s.x.map((v) => +v.toFixed(3)),
    };
  });

  const predict = (m, x) => logistic.predictProba(m, x);
  const posX = samples.filter((s) => s.y === 1).map((s) => s.x);
  const negX = samples.filter((s) => s.y === 0).map((s) => s.x);
  const softplus = (z) => Math.log(1 + Math.exp(-z));
  // pairwise ranking loss over all pos×neg pairs for a given weight vector
  const pairLoss = (w) => {
    let s = 0, c = 0;
    for (const p of posX) for (const n of negX) {
      let z = 0; for (let i = 0; i < w.length; i++) z += w[i] * ((p[i] ?? 0) - (n[i] ?? 0));
      s += softplus(z); c++;
    }
    return c ? s / c : 0;
  };
  const auc = (scores, ys) => {
    const pos = scores.filter((_, i) => ys[i] === 1), neg = scores.filter((_, i) => ys[i] === 0);
    if (!pos.length || !neg.length) return 0.5;
    let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
    return w / (pos.length * neg.length);
  };

  // ranking-loss curve: re-run the REAL pairwise trainer for k=1..120 epochs
  const EPOCHS = 120, LR = 0.3, L2 = 0.01;
  const lossCurve = [];
  for (let k = 1; k <= EPOCHS; k++) {
    const wk = logistic.trainPairwise(posX, negX, { epochs: k, lr: LR, l2: L2 });
    lossCurve.push(+pairLoss(wk).toFixed(5));
  }
  const initialLoss = +pairLoss(new Array(posX[0]?.length ?? 13).fill(0)).toFixed(5);

  // final model == exactly what trainFromHistory persists (pairwise + calibrated)
  const res = await train.trainFromHistory();
  const model = res.model;
  const probs = samples.map((s) => predict(model, s.x));
  const trainAcc = probs.reduce((a, p, i) => a + ((p > 0.5 ? 1 : 0) === labels[i] ? 1 : 0), 0) / probs.length;
  const trainAUC = auc(probs, labels);
  const probPositives = probs.filter((_, i) => labels[i] === 1).map((p) => +p.toFixed(4));
  const probNegatives = probs.filter((_, i) => labels[i] === 0).map((p) => +p.toFixed(4));

  // held-out generalization: stratified 70/30 split, trained with the same real ranker
  const testEvery = (arr) => arr.filter((_, i) => i % 3 === 0);
  const trainPos = posX.filter((_, i) => i % 3 !== 0), testPos = testEvery(posX);
  const trainNeg = negX.filter((_, i) => i % 3 !== 0), testNeg = testEvery(negX);
  const hoModel = logistic.trainRanker(trainPos, trainNeg, { epochs: 200, lr: LR, l2: L2 });
  const hoScores = [...testPos, ...testNeg].map((x) => predict(hoModel, x));
  const hoLabels = [...testPos.map(() => 1), ...testNeg.map(() => 0)];
  const holdoutAUC = auc(hoScores, hoLabels);
  const holdoutAcc = hoScores.reduce((a, p, i) => a + ((p > 0.5 ? 1 : 0) === hoLabels[i] ? 1 : 0), 0) / hoScores.length;

  // ---- content signals (embedding relevance + title/comment term affinity) ----
  // Built from the REAL content module, over the whole candidate pool.
  const pool = D.candidateIds.map((id) => D.items.find((it) => it.id === id));
  const profile = await content.buildContentProfile(D.EMB_MODEL, { withComments: true, embeddings: true });
  const poolSig = await content.computeContentSignals(D.EMB_MODEL, pool, profile, { loo: false });

  // ---- USAGE / wiring proof: recompute a score by hand == scoreItem() ----
  const bare = { ...H.prefs.getState(), followedDomains: [], followedUsers: [], mutedDomains: [], mutedUsers: [], keywordsBoost: [], keywordsMute: [] };
  const full = { ...H.prefs.getState() };
  const fullCtx = strategies.makeContext(full, aff, { simById: poolSig.simById, termById: poolSig.termById });
  const probe = D.items.find((it) => it.id === 2003); // a Rust candidate
  const withModel = strategies.scoreItem(probe, fullCtx, model);
  const withoutModel = strategies.scoreItem(probe, fullCtx, undefined);
  // Recompute from scoreItem's OWN features (so there's no feature divergence) and
  // mirror its exact learned-term guard — proves the blend arithmetic deterministically.
  const fs = withModel.fs;
  const x = features.featureVector(fs);
  const learned = predict(model, x);
  const usedLearned = model && model.n > 0 ? learned : fs.learned;
  // The learned signal is a LOG-ODDS margin centered on YOUR base engagement rate (learnedBaseRate),
  // squashed to ±1 by tanh — NOT a raw probability difference. Platt anchors P at the base rate, so
  // for a minority engager a good and a mediocre story both sit in the sigmoid's flat tail and their
  // probability gap collapses; log-odds preserves the model's ranking margin. Mirror it exactly here
  // (recomputed independently of strategies.blend, so a drift in either side fails the identity).
  const baseRate = model && model.n > 0 ? strategies.learnedBaseRate(model) : 0.5;
  const logit = (v) => {
    const c = Math.min(1 - 1e-6, Math.max(1e-6, v));
    return Math.log(c / (1 - c));
  };
  const learnedPull = Math.tanh((logit(usedLearned) - logit(baseRate)) / 2);
  const w = full.weights;
  const affinityRaw = fs.domainAffinity + fs.authorAffinity + (fs.followedDomain ? 2 : 0) + (fs.followedUser ? 2 : 0) + (fs.boostKeyword ? 1.5 : 0);
  const affinity = Math.tanh(affinityRaw / 4);
  const byHand =
    w.popularity * fs.popularity + w.recency * fs.recency + w.discussion * fs.discussion +
    w.affinity * affinity + w.relevance * fs.relevance + w.learned * learnedPull;
  const learnedTermWith = w.learned * learnedPull;

  // ---- CAUSAL proof: rank the held-out pool, adding one mechanism at a time ----
  const candTopic = (id) =>
    D.liked.includes(id) ? 'liked' : D.disliked.includes(id) ? 'crypto' : D.commentProbe.includes(id) ? 'probe' : 'neutral';
  const EMPTY_AFF = { domains: {}, authors: {} };
  const rankOf = (ranked, ids) => ids.map((id) => ranked.findIndex((r) => r.item.id === id) + 1);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const configs = {
    cold: strategies.computeForYou(pool, strategies.makeContext(bare, EMPTY_AFF), undefined),
    affinity: strategies.computeForYou(pool, strategies.makeContext(bare, aff), undefined),
    learned: strategies.computeForYou(pool, strategies.makeContext(bare, aff), model),
    full: strategies.computeForYou(pool, fullCtx, model),
  };
  const rankings = {};
  const likedMeanRank = {};
  const dislikedMeanRank = {};
  for (const [name, ranked] of Object.entries(configs)) {
    rankings[name] = ranked.map((r, i) => ({
      rank: i + 1, id: r.item.id, title: r.item.title, score: +r.score.toFixed(4),
      topic: candTopic(r.item.id),
      reasons: r.reasons,
    }));
    likedMeanRank[name] = +mean(rankOf(ranked, D.liked)).toFixed(2);
    dislikedMeanRank[name] = +mean(rankOf(ranked, D.disliked)).toFixed(2);
  }
  const rankIn = (name, id) => rankings[name].find((r) => r.id === id)?.rank ?? -1;

  // ---- CONTENT proof: embedding relevance + title/comment term affinity ----
  const contentPer = D.candidateIds.map((id) => ({
    id, topic: candTopic(id),
    relevance: +(poolSig.simById.get(id) ?? 0).toFixed(4),
    termAffinity: +(poolSig.termById.get(id) ?? 0).toFixed(4),
  }));
  const sims = contentPer.map((c) => ({ id: c.id, sim: c.relevance, topic: c.topic }));
  const likedMeanSim = +mean(sims.filter((s) => s.topic === 'liked').map((s) => s.sim)).toFixed(4);
  const dislikedMeanSim = +mean(sims.filter((s) => s.topic === 'crypto').map((s) => s.sim)).toFixed(4);

  // comment-content probe: 2006 title has a term that ONLY appeared in comments; 2007 doesn't.
  const commentProof = {
    withTermId: 2006, withoutTermId: 2007,
    termWith: +(poolSig.termById.get(2006) ?? 0).toFixed(4),
    termWithout: +(poolSig.termById.get(2007) ?? 0).toFixed(4),
    relevanceWith: +(poolSig.simById.get(2006) ?? 0).toFixed(4),
    rankWith: rankIn('full', 2006),
    rankWithout: rankIn('full', 2007),
  };

  return {
    data: { eventCounts, totalEvents: eventRows.length, itemsSeeded: D.items.length,
      sampleEvents: eventRows.slice(0, 12).map((e) => ({ type: e.type, itemId: e.itemId, domain: e.domain, author: e.author })) },
    affinities: { domains: sortRec(aff.domains), authors: sortRec(aff.authors) },
    training: {
      positives: res.positives, negatives: res.negatives, nSamples: samples.length, modelN: model.n,
      weights: model.w.map((v) => +v.toFixed(4)), bias: +model.b.toFixed(4),
      initialLoss, finalLoss: lossCurve[lossCurve.length - 1], lossCurve,
      trainAcc: +trainAcc.toFixed(4), trainAUC: +trainAUC.toFixed(4),
      holdoutAcc: +holdoutAcc.toFixed(4), holdoutAUC: +holdoutAUC.toFixed(4),
      probPositives, probNegatives,
    },
    trainingData,
    model: { weights: model.w.map((v) => +v.toFixed(4)), bias: +model.b.toFixed(4), n: model.n, updatedAt: model.updatedAt },
    wiring: {
      probeId: probe.id, probeTitle: probe.title,
      features: D.FEATURE_NAMESJS.reduce((o, n, i) => ((o[n] = +x[i].toFixed(4)), o), {}),
      predictProba: +learned.toFixed(6),
      byHandScore: +byHand.toFixed(9), scoreItemScore: +withModel.score.toFixed(9),
      match: Math.abs(byHand - withModel.score) < 1e-9,
      scoreWithModel: +withModel.score.toFixed(6), scoreWithoutModel: +withoutModel.score.toFixed(6),
      learnedTermWith: +learnedTermWith.toFixed(6),
      learnedTermWithout: +(withModel.score - withoutModel.score - learnedTermWith).toFixed(9), // ≈0 residual
      deltaFromModel: +(withModel.score - withoutModel.score).toFixed(6),
    },
    causal: { rankings, likedMeanRank, dislikedMeanRank },
    embeddings: { sims, likedMeanSim, dislikedMeanSim },
    content: { perCandidate: contentPer, commentProof },
  };
}, { ...DATA, EMB_MODEL: DATA.EMB_MODEL, FEATURE_NAMESJS: FEATURE_NAMES });

report.featureNames = FEATURE_NAMES;

// ---- report the captured numbers + assert ----
say('\n[1] DATA');
say(`  ${report.data.totalEvents} events seeded across ${report.data.itemsSeeded} items: ${JSON.stringify(report.data.eventCounts)}`);
const topDom = report.affinities.domains.slice(0, 3).map((d) => `${d.k}=${d.v.toFixed(1)}`).join(', ');
say(`  learned domain affinity (top): ${topDom}`);
const arxivAff = report.affinities.domains.find((d) => d.k === 'arxiv.org')?.v ?? 0;
const cryptoAff = report.affinities.domains.find((d) => d.k === 'crypto.example')?.v ?? 0;
check('history is captured as events', report.data.totalEvents > 0, `${report.data.totalEvents} signals`);
check('affinities learn the liked domain > disliked', arxivAff > 0 && arxivAff > cryptoAff, `arxiv.org=${arxivAff.toFixed(1)} vs crypto.example=${cryptoAff.toFixed(1)}`);

say('\n[2] TRAIN');
const t = report.training;
say(`  model: empty (all-zero) \u2192 trained on ${t.modelN} examples (${t.positives} liked + ${t.negatives} skipped)`);
say(`  loss: ${t.initialLoss} \u2192 ${t.finalLoss}   trainAUC=${t.trainAUC}  held-out AUC=${t.holdoutAUC}`);
check('model trained on all samples', t.modelN === t.positives + t.negatives && t.nSamples === t.modelN, `n=${t.modelN}`);
check('loss decreased substantially', t.finalLoss < t.initialLoss * 0.6, `${t.initialLoss} \u2192 ${t.finalLoss}`);
check('train AUC is well above chance', t.trainAUC > 0.9, `AUC=${t.trainAUC}`);
check('held-out AUC generalizes (> 0.75)', t.holdoutAUC > 0.75, `AUC=${t.holdoutAUC}`);

say('\n[3] TRAINED CORRECTLY');
const wByName = FEATURE_NAMES.reduce((o, n, i) => ((o[n] = t.weights[i]), o), {});
say(`  weights: ${FEATURE_NAMES.map((n, i) => `${n}=${t.weights[i]}`).join(', ')}`);
const meanPos = report.training.probPositives.reduce((a, b) => a + b, 0) / report.training.probPositives.length;
const meanNeg = report.training.probNegatives.reduce((a, b) => a + b, 0) / report.training.probNegatives.length;
say(`  P(engage): positives mean=${meanPos.toFixed(3)}  negatives mean=${meanNeg.toFixed(3)}`);
check('domain-affinity weight is positive', wByName.domainAffinity > 0, `w=${wByName.domainAffinity}`);
check('author-affinity weight is positive', wByName.authorAffinity > 0, `w=${wByName.authorAffinity}`);
check('relevance (title/self-text embedding) is now a TRAINED feature (>0)', wByName.relevance > 0, `w=${wByName.relevance}`);
check('termAffinity (title + comment terms) weight is positive', wByName.termAffinity > 0, `w=${wByName.termAffinity}`);
check('P(engage) separates liked from skipped', meanPos > 0.7 && meanNeg < 0.3, `pos=${meanPos.toFixed(2)} neg=${meanNeg.toFixed(2)}`);

say('\n[4] MODEL USED CORRECTLY (wiring)');
const wi = report.wiring;
say(`  probe #${wi.probeId} "${wi.probeTitle}": predictProba=${wi.predictProba}`);
say(`  scoreItem()=${wi.scoreItemScore}   recomputed-by-hand=${wi.byHandScore}`);
say(`  score with model=${wi.scoreWithModel}  without model=${wi.scoreWithoutModel}  (\u0394 from learned term=${wi.deltaFromModel})`);
check('hand-computed score == scoreItem() (1e-9)', wi.match, `|Δ|<1e-9`);
check('trained model actually shifts the score', Math.abs(wi.deltaFromModel) > 1e-4, `Δ=${wi.deltaFromModel}`);
check('learned term is exactly 0 without a model', Math.abs(wi.deltaFromModel - wi.learnedTermWith) < 1e-9, 'toggle off ⇒ no learned contribution');

say('\n[5] CAUSAL — does the feed actually change?');
const c = report.causal;
say(`  liked-topic mean rank:  cold=${c.likedMeanRank.cold}  +affinity=${c.likedMeanRank.affinity}  +learned=${c.likedMeanRank.learned}  +embeddings(full)=${c.likedMeanRank.full}`);
say(`  crypto  mean rank:      cold=${c.dislikedMeanRank.cold}  \u2192 full=${c.dislikedMeanRank.full}`);
say('  cold top 3:  ' + c.rankings.cold.slice(0, 3).map((r) => `${r.topic}:${r.title.slice(0, 28)}`).join(' | '));
say('  full top 3:  ' + c.rankings.full.slice(0, 3).map((r) => `${r.topic}:${r.title.slice(0, 28)}`).join(' | '));
const coldTopIsCrypto = c.rankings.cold[0].topic === 'crypto';
const fullTopIsLiked = c.rankings.full[0].topic === 'liked';
check('cold-start ranks high-score crypto on top (the confound)', coldTopIsCrypto, `#1 = ${c.rankings.cold[0].topic}`);
check('personalization lifts liked items to the top', fullTopIsLiked && c.likedMeanRank.full <= 5, `#1=${c.rankings.full[0].topic}, liked mean rank=${c.likedMeanRank.full}`);
check('each mechanism improves liked rank monotonically', c.likedMeanRank.cold > c.likedMeanRank.affinity && c.likedMeanRank.affinity >= c.likedMeanRank.learned && c.likedMeanRank.learned >= c.likedMeanRank.full, `${c.likedMeanRank.cold}→${c.likedMeanRank.affinity}→${c.likedMeanRank.learned}→${c.likedMeanRank.full}`);

say('\n[6] CONTENT — titles, embeddings & comments feed the model');
const e = report.embeddings;
const cp = report.content.commentProof;
say(`  embedding relevance to your profile: liked mean=${e.likedMeanSim}  crypto mean=${e.dislikedMeanSim}`);
say(`  comment-only term test — 2006 "wasm sandbox internals" termAffinity=${cp.termWith} rank #${cp.rankWith}  vs  2007 "kubernetes cluster internals" termAffinity=${cp.termWithout} rank #${cp.rankWithout}`);
say(`  (2006 has NO domain/author/embedding affinity — relevance=${cp.relevanceWith}; its only signal is a term seen only in COMMENTS)`);
check('embedding relevance recovers the taste', e.likedMeanSim > 0.8 && e.dislikedMeanSim < 0.3, `liked=${e.likedMeanSim} crypto=${e.dislikedMeanSim}`);
check('comment text raises termAffinity (2006 ≫ 2007)', cp.termWith > cp.termWithout + 0.05, `${cp.termWith} vs ${cp.termWithout}`);
check('comment-driven story outranks its identical twin', cp.rankWith >= 0 && cp.rankWith < cp.rankWithout, `#${cp.rankWith} vs #${cp.rankWithout}`);

// ===========================================================================
// PHASE 7 — real UI over the mocked API: screenshots + in-product assertions.
// ===========================================================================
say('\n[7] REAL UI (mocked HN API)');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.prefs, null, { timeout: 20000 });
await page.waitForTimeout(500);

// For You feed
await page.getByRole('button', { name: 'For You' }).first().click().catch(() => {});
await page.waitForSelector('article', { timeout: 30000 });
await page.waitForTimeout(800);
const firstCard = await page.evaluate(() => {
  const a = document.querySelector('article');
  const title = a?.querySelector('h3')?.textContent?.trim() ?? '';
  const chips = Array.from(a?.querySelectorAll('span') ?? [])
    .map((s) => s.textContent?.trim())
    .filter((tt) => tt && (tt.includes('you') || tt.includes('interest') || tt.includes('often') || tt.includes('follow') || tt.includes('reading')));
  return { title, chips };
});
say(`  For You #1: "${firstCard.title}"  chips: ${JSON.stringify(firstCard.chips)}`);
const firstIsLiked = /rust|llm|transformer|attention|interpretab|search engine|concurrency|optimizer|scaling/i.test(firstCard.title);
check('For-You UI shows a liked-topic story first', firstIsLiked, `"${firstCard.title.slice(0, 40)}"`);
check('For-You UI shows a personalized "why" chip', firstCard.chips.length > 0, firstCard.chips[0] || 'none');
await page.screenshot({ path: join(OUT_DIR, 'foryou.png'), fullPage: false });

// Rank explainer: open the "Why #1?" trace on the top card and check the drill-down
await page.locator('article').locator('.sc-actions button[aria-label^="Why #"]').first().click().catch(() => {});
await page.waitForSelector('[role="dialog"]', { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(300);
const dlg = await page.evaluate(() => {
  // pick the explainer dialog specifically (the app also mounts a comments drawer)
  const dialogs = [...document.querySelectorAll('[role="dialog"]')];
  const d = dialogs.find((el) => /How the score adds up/.test(el.textContent || '')) || null;
  return { present: !!d, text: d ? d.textContent || '' : '' };
});
say(`  rank explainer: ${dlg.present ? 'opened' : 'MISSING'}`);
check('rank explainer opens with score → weights breakdown', dlg.present && /How the score adds up/.test(dlg.text) && /Inside the learned model/.test(dlg.text), dlg.present ? 'score + model sections present' : 'no dialog');
// Match the PROVENANCE claim, not one phrasing of it. The panel deliberately says "examples from
// your activity" rather than "interactions": most training rows are passive impressions labelled as
// skips, so naming deliberate actions overstates what the model was fed.
check('rank explainer traces back to the training data', /trained on \d+ examples from your activity/i.test(dlg.text) && /The data behind it/.test(dlg.text), 'model provenance + data signals shown');
// The logistic saturates on small local data — the displayed engage-chance must be a
// bounded estimate ("~X%", 5..95), never a false "100% chance you'll engage".
const chanceMatch = dlg.text.match(/~\s*(\d+)%/);
check('engage-chance is shown as a bounded estimate (never a false 100%)', !!chanceMatch && Number(chanceMatch[1]) <= 95 && Number(chanceMatch[1]) >= 5, chanceMatch ? `~${chanceMatch[1]}%` : 'no ~% found');
await page.screenshot({ path: join(OUT_DIR, 'explain.png'), fullPage: false });
// The content footnote must reflect the reader-proxy state — with it ON, article text
// IS folded into relevance/termAffinity, so the dialog must NOT claim article bodies are
// unreadable. Toggle it on and reopen.
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(150);
await page.evaluate(() => window.__hnlens.prefs.getState().set({ fetchArticleText: true }));
await page.locator('article').locator('.sc-actions button[aria-label^="Why #"]').first().click().catch(() => {});
await page.waitForTimeout(300);
const dlg2 = await page.evaluate(() => {
  const d = [...document.querySelectorAll('[role="dialog"]')].find((el) => /How the score adds up/.test(el.textContent || ''));
  return d ? d.textContent || '' : '';
});
check('Why-dialog content note reflects reader-proxy ON (article text is content)', /via the reader proxy/i.test(dlg2) && !/aren.t readable in-browser\)/i.test(dlg2), 'article-aware footnote');
await page.evaluate(() => window.__hnlens.prefs.getState().set({ fetchArticleText: false }));
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(200);

// Settings — trained-model status + signal count, and drive the real Train button
await page.goto(BASE + '#/settings', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
await page.getByRole('button', { name: 'Retrain now' }).click().catch(() => {});
await page.waitForTimeout(800);
const settingsText = await page.evaluate(() => document.body.innerText);
// The reranker status line reflects the activation gate: above the gate (this proof trains on
// >=12 samples with >=3 positives) it reads "Active · personalizing from N examples from your activity".
// "examples from your activity", not "interactions": most training rows are passive impressions
// labelled as skips, so naming three deliberate actions misdescribed 81% of the data. Match the
// number and the concept, not the old phrasing.
const trainedMatch = settingsText.match(/personalizing from (\d+) examples/i);
const signalsMatch = settingsText.match(/([\d,]+) interaction signals/i);
say(`  Settings: "${trainedMatch?.[0] ?? '(no trained status)'}", "${signalsMatch?.[0] ?? '(no signal count)'}"`);
check('Settings shows the trained model status', !!trainedMatch, trainedMatch?.[0]);
check('Settings shows recorded interaction signals', !!signalsMatch, signalsMatch?.[0]);
await page.locator('section', { hasText: 'Learned reranker' }).scrollIntoViewIfNeeded().catch(() => {});
await page.screenshot({ path: join(OUT_DIR, 'settings.png'), fullPage: true });

// ===========================================================================
// PHASE 8 — the learning loop: dwell weighting + auto-training.
// ===========================================================================
say('\n[8] LEARNING LOOP — read-time (dwell) + auto-train');
const loop = await page.evaluate(async () => {
  const H = window.__hnlens;
  const [{ db }, interactions, train, logistic, autotrain] = await Promise.all([
    H.db(), H.interactions(), H.train(), H.logistic(), H.autotrain(),
  ]);
  const now = Date.now();
  // Two link-only stories: one bounced (returned in 3s), one read (2 min).
  const mk = (id, title) => ({ id, item: { id, type: 'story', by: 'someone', url: `https://dev.example/x/${id}`, title, score: 50, descendants: 10, time: Math.floor(now / 1000) - 3600 }, cachedAt: now });
  await db.items.bulkPut([mk(3001, 'A bounced article'), mk(3002, 'A deeply-read article')]);
  await db.events.bulkAdd([
    { type: 'open_link', itemId: 3001, domain: 'dev.example', author: 'someone', ts: now - 5000 },
    { type: 'dwell', itemId: 3001, domain: 'dev.example', author: 'someone', value: 3000, ts: now - 2000 }, // bounce
    { type: 'open_link', itemId: 3002, domain: 'dev.example', author: 'someone', ts: now - 130000 },
    { type: 'dwell', itemId: 3002, domain: 'dev.example', author: 'someone', value: 120000, ts: now - 5000 }, // long read
  ]);

  // dwell → labels
  const td = await train.buildTrainingSamples();
  const labelOf = (id) => { const i = td.sampleIds.indexOf(id); return i >= 0 ? td.samples[i].y : null; };
  const bouncedLabel = labelOf(3001);
  const readLabel = labelOf(3002);

  // dwell → affinity direction (bounce should push a domain's affinity down)
  const dwellSig = { bounce: interactions.dwellSignal(3000), read: interactions.dwellSignal(120000) };

  // auto-train: the loop must still CLOSE, but only when the retrain is invisible — it is seconds
  // of synchronous main-thread work, so it waits for enough new material AND a hidden tab.
  // The loop must still CLOSE, but only when the retrain is invisible: it is seconds of synchronous
  // main-thread work. The size of the increment is covered exhaustively by autotraingatetest; what
  // matters here is that a real engagement still reaches the model, and only while hidden.
  await db.events.add({ type: 'save', itemId: 2001, domain: 'arxiv.org', author: 'pg', ts: Date.now() });
  const m0 = await logistic.loadModel();
  await logistic.saveModel({ ...m0, updatedAt: 0 }); // an unfitted model defers to training's own sample gate
  const setHidden = (v) =>
    Object.defineProperty(Document.prototype, 'hidden', { get: () => v, configurable: true });
  autotrain.__resetForTest();
  const before = (await logistic.loadModel()).updatedAt;
  H.prefs.getState().set({ useLearnedRanker: true });
  setHidden(false);
  const rVisible = await autotrain.runAutoTrain(); // reader is looking → must not freeze them
  setHidden(true);
  const r1 = await autotrain.runAutoTrain();
  const after = (await logistic.loadModel()).updatedAt;
  const r2 = await autotrain.runAutoTrain(); // within MIN_INTERVAL → skipped
  H.prefs.getState().set({ useLearnedRanker: false });
  const r3 = await autotrain.runAutoTrain(); // gated off → skipped
  H.prefs.getState().set({ useLearnedRanker: true });
  setHidden(false);

  return { bouncedLabel, readLabel, dwellSig, rVisible, r1, r2, r3, before, after };
});
say(`  dwell signal: bounce(3s)=${loop.dwellSig.bounce}  read(120s)=${loop.dwellSig.read}`);
say(`  labels: bounced story=${loop.bouncedLabel} (expect 0)  read story=${loop.readLabel} (expect 1)`);
say(`  auto-train: reader looking → ${loop.rVisible}; tab hidden → ${loop.r1}; immediate re-run → ${loop.r2}; disabled → ${loop.r3}`);
check('dwell: a quick bounce is a negative signal', loop.dwellSig.bounce < 0 && loop.dwellSig.read > 0, `bounce=${loop.dwellSig.bounce}, read=${loop.dwellSig.read}`);
check('dwell: bounced click trains as NEGATIVE, long read as POSITIVE', loop.bouncedLabel === 0 && loop.readLabel === 1, `bounced=${loop.bouncedLabel}, read=${loop.readLabel}`);
check('auto-train does NOT run while the reader is looking at the tab', loop.rVisible === 'skipped', `visible=${loop.rVisible}`);
check('auto-train fires once the tab is hidden (model updatedAt advances)', loop.r1 === 'trained' && loop.after > loop.before, `${loop.r1}, updatedAt ${loop.before} → ${loop.after}`);
check('auto-train is rate-limited + gated by the toggle', loop.r2 === 'skipped' && loop.r3 === 'skipped', `re-run=${loop.r2}, disabled=${loop.r3}`);

// ===========================================================================
// PHASE 9 — opt-in reader proxy: linked ARTICLE-body text feeds ranking.
// ===========================================================================
say('\n[9] ARTICLE TEXT — opt-in reader proxy');
const art = await page.evaluate(async ({ D, body }) => {
  const content = await window.__hnlens.content();
  const dbMod = await window.__hnlens.db();
  const probeItems = D.articleProbe.map((id) => D.items.find((it) => it.id === id));
  // OFF: article terms are not read into the profile → the "raft" term can't help.
  const p0 = await content.buildContentProfile(D.EMB_MODEL, { withComments: true, embeddings: true });
  const s0 = await content.computeContentSignals(D.EMB_MODEL, probeItems, p0, { loo: false });
  // ON: an engaged item you OPENED has its article body CACHED (the on-click/summary fetch
  // caches it). Profile-building reads that cache (cache-only — never a live fetch during
  // training), so "raft" enters the liked profile. Seed the cache to model the opened flow.
  for (const id of D.liked) {
    await dbMod.kvSet(`atext:${id}`, { text: body, proxy: 'mock' });
    await dbMod.db.kv.where('key').equals(`aterms:${id}`).delete();
  }
  const p1 = await content.buildContentProfile(D.EMB_MODEL, { withComments: true, embeddings: true, fetchArticle: true });
  const s1 = await content.computeContentSignals(D.EMB_MODEL, probeItems, p1, { loo: false });
  return {
    off: { raft: +(s0.termById.get(2008) ?? 0).toFixed(4), gossip: +(s0.termById.get(2009) ?? 0).toFixed(4) },
    on: { raft: +(s1.termById.get(2008) ?? 0).toFixed(4), gossip: +(s1.termById.get(2009) ?? 0).toFixed(4) },
  };
}, { D: DATA, body: ARTICLE_BODY });
say(`  "raft consensus internals" termAffinity:  proxy OFF=${art.off.raft}  proxy ON=${art.on.raft}`);
say(`  "gossip protocol internals" termAffinity:  proxy OFF=${art.off.gossip}  proxy ON=${art.on.gossip}`);
check('article body is inert until the proxy is enabled', Math.abs(art.off.raft) < 0.01, `off=${art.off.raft}`);
check('reader proxy lets ARTICLE-body words lift a story', art.on.raft > art.on.gossip + 0.05 && art.on.raft > 0.05, `raft=${art.on.raft} vs gossip=${art.on.gossip}`);

// A CANDIDATE's OWN fetched article body (neutral title, no comments) must lift its
// ranking signal — proving the reranker takes the candidate's full text into account.
const artCand = await page.evaluate(async (D) => {
  const content = await window.__hnlens.content();
  const dbMod = await window.__hnlens.db();
  const p = await content.buildContentProfile(D.EMB_MODEL, { withComments: true, embeddings: true, fetchArticle: true });
  // Titles use words absent from the (tech) profile, so ONLY the article body differs.
  const c1 = { id: 30010, title: 'the quiet meadow picnic basket' };
  const c2 = { id: 30011, title: 'the quiet meadow picnic blanket' };
  await dbMod.kvSet('atext:30010', { text: 'This piece explains raft leader election and log replication in depth for engineers.', proxy: 'mock' });
  await dbMod.db.kv.where('key').equals('aterms:30010').delete();
  const on = await content.computeContentSignals(D.EMB_MODEL, [c1, c2], p, { articleTerms: true });
  const off = await content.computeContentSignals(D.EMB_MODEL, [c1, c2], p, { articleTerms: false });
  return {
    on1: +(on.termById.get(30010) ?? 0).toFixed(4), on2: +(on.termById.get(30011) ?? 0).toFixed(4),
    off1: +(off.termById.get(30010) ?? 0).toFixed(4), off2: +(off.termById.get(30011) ?? 0).toFixed(4),
  };
}, DATA);
say(`  candidate article body: neutral-title story WITH "raft" body termAffinity=${artCand.on1} vs twin=${artCand.on2} (flag off: ${artCand.off1}/${artCand.off2})`);
check("a candidate's OWN article body lifts its ranking signal (full text in reranking)", artCand.on1 > artCand.on2 + 0.05, `${artCand.on1} vs ${artCand.on2}`);
check('candidate article body ignored when the flag is off (neutral titles tie)', Math.abs(artCand.off1 - artCand.off2) < 0.01, `${artCand.off1} vs ${artCand.off2}`);
report.content.candidateArticleProof = artCand;

report.ui = { firstCard, trained: trainedMatch?.[0] ?? null, signals: signalsMatch?.[0] ?? null };
report.content.articleProof = art;
report.meta = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  taste: 'Loves arXiv (ML papers) + Rust (github.com) + user "pg"; ignores/​hides crypto.',
  liked: DATA.liked, disliked: DATA.disliked, neutral: DATA.neutral,
};
report.assertions = assertions;
report.log = log;

await ctx.close();

writeFileSync(join(OUT_DIR, 'personalization-report.json'), JSON.stringify(report, null, 2));
const passed = assertions.filter((a) => a.pass).length;
say('\n==================================================');
say(`RESULT: ${passed}/${assertions.length} assertions passed`);
say(`report: ${join(OUT_DIR, 'personalization-report.json')}`);
process.exit(passed === assertions.length ? 0 : 1);
