// ============================================================================
// Personalization proof → visual dashboard
// ----------------------------------------------------------------------------
// Reads scripts/.artifacts/personalization-report.json (produced by
// personalization-proof.mjs) and renders a single self-contained HTML file with
// inline SVG charts + the two real-UI screenshots embedded as data-URIs.
// No network, no dependencies — opens straight from file://.
// ============================================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, '.artifacts');
const R = JSON.parse(readFileSync(join(DIR, 'personalization-report.json'), 'utf8'));

const COL = { liked: '#3fb950', crypto: '#f85149', neutral: '#8b949e', accent: '#58a6ff', grid: '#30363d', pos: '#3fb950', neg: '#f85149' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dataUri = (file) => (existsSync(join(DIR, file)) ? `data:image/png;base64,${readFileSync(join(DIR, file)).toString('base64')}` : '');

// ---------- tiny inline-SVG chart helpers ----------
function divergingBars(rows, { w = 560, rh = 26, unit = '' } = {}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.v)));
  const h = rows.length * rh + 10;
  const midX = w * 0.42;
  const scale = (w - midX - 90) / max;
  let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">`;
  s += `<line x1="${midX}" y1="4" x2="${midX}" y2="${h - 6}" stroke="${COL.grid}"/>`;
  rows.forEach((r, i) => {
    const y = 8 + i * rh;
    const len = Math.abs(r.v) * scale;
    const x = r.v >= 0 ? midX : midX - len;
    const color = r.color || (r.v >= 0 ? COL.pos : COL.neg);
    s += `<rect x="${x}" y="${y}" width="${Math.max(0.5, len)}" height="${rh - 9}" rx="2" fill="${color}"/>`;
    s += `<text x="${midX - 8}" y="${y + rh / 2 - 3}" text-anchor="end" class="lbl">${esc(r.k)}</text>`;
    s += `<text x="${(r.v >= 0 ? midX + len : x) + (r.v >= 0 ? 6 : -6)}" y="${y + rh / 2 - 3}" text-anchor="${r.v >= 0 ? 'start' : 'end'}" class="val">${r.v >= 0 ? '+' : ''}${r.v}${unit}</text>`;
  });
  return s + '</svg>';
}

function lineChart(vals, { w = 620, h = 200, yMax, yMin = 0, label = '' } = {}) {
  const pad = { l: 44, r: 16, t: 14, b: 26 };
  const max = yMax ?? Math.max(...vals);
  const min = yMin;
  const x = (i) => pad.l + (i / (vals.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);
  let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">`;
  for (let g = 0; g <= 4; g++) {
    const gv = min + (g / 4) * (max - min);
    const gy = y(gv);
    s += `<line x1="${pad.l}" y1="${gy}" x2="${w - pad.r}" y2="${gy}" stroke="${COL.grid}" stroke-dasharray="2 3"/>`;
    s += `<text x="${pad.l - 6}" y="${gy + 3}" text-anchor="end" class="tick">${gv.toFixed(2)}</text>`;
  }
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  s += `<polyline points="${pts}" fill="none" stroke="${COL.accent}" stroke-width="2"/>`;
  s += `<circle cx="${x(0)}" cy="${y(vals[0])}" r="3" fill="${COL.neg}"/>`;
  s += `<circle cx="${x(vals.length - 1)}" cy="${y(vals[vals.length - 1])}" r="3" fill="${COL.pos}"/>`;
  s += `<text x="${x(0) + 6}" y="${y(vals[0]) - 6}" class="val">${vals[0]}</text>`;
  s += `<text x="${x(vals.length - 1) - 6}" y="${y(vals[vals.length - 1]) - 8}" text-anchor="end" class="val">${vals[vals.length - 1]}</text>`;
  s += `<text x="${pad.l}" y="${h - 6}" class="tick">epoch 1</text>`;
  s += `<text x="${w - pad.r}" y="${h - 6}" text-anchor="end" class="tick">epoch ${vals.length}</text>`;
  if (label) s += `<text x="${(w) / 2}" y="${h - 6}" text-anchor="middle" class="tick">${esc(label)}</text>`;
  return s + '</svg>';
}

function dotStrip(pos, neg, { w = 620, h = 130 } = {}) {
  const pad = { l: 16, r: 16, t: 26, b: 26 };
  const x = (v) => pad.l + v * (w - pad.l - pad.r);
  let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">`;
  s += `<line x1="${x(0)}" y1="${h - pad.b}" x2="${x(1)}" y2="${h - pad.b}" stroke="${COL.grid}"/>`;
  for (let t = 0; t <= 1.0001; t += 0.25) {
    s += `<line x1="${x(t)}" y1="${pad.t}" x2="${x(t)}" y2="${h - pad.b}" stroke="${COL.grid}" stroke-dasharray="2 3"/>`;
    s += `<text x="${x(t)}" y="${h - pad.b + 16}" text-anchor="middle" class="tick">${t.toFixed(2)}</text>`;
  }
  s += `<line x1="${x(0.5)}" y1="${pad.t - 4}" x2="${x(0.5)}" y2="${h - pad.b}" stroke="#c9a227" stroke-dasharray="4 3"/>`;
  s += `<text x="${x(0.5)}" y="${pad.t - 8}" text-anchor="middle" class="tick" fill="#c9a227">decision boundary 0.5</text>`;
  const plot = (arr, color, yc) => arr.forEach((v) => { s += `<circle cx="${x(v)}" cy="${yc}" r="4.5" fill="${color}" fill-opacity="0.8"/>`; });
  plot(neg, COL.neg, h - pad.b - 18);
  plot(pos, COL.pos, pad.t + 18);
  s += `<text x="${x(0)}" y="${pad.t + 4}" class="val" fill="${COL.pos}">liked (engaged) → predict ≈ 1</text>`;
  s += `<text x="${x(0)}" y="${h - pad.b - 30}" class="val" fill="${COL.neg}">skipped/hidden → predict ≈ 0</text>`;
  return s + '</svg>';
}

function simBars(sims, { w = 620, h = 210 } = {}) {
  const pad = { l: 30, r: 12, t: 14, b: 40 };
  const bw = (w - pad.l - pad.r) / sims.length;
  const y = (v) => pad.t + (1 - v) * (h - pad.t - pad.b);
  let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">`;
  for (let g = 0; g <= 4; g++) {
    const gv = g / 4, gy = y(gv);
    s += `<line x1="${pad.l}" y1="${gy}" x2="${w - pad.r}" y2="${gy}" stroke="${COL.grid}" stroke-dasharray="2 3"/>`;
    s += `<text x="${pad.l - 6}" y="${gy + 3}" text-anchor="end" class="tick">${gv.toFixed(2)}</text>`;
  }
  sims.forEach((d, i) => {
    const bx = pad.l + i * bw + 3;
    const by = y(d.sim);
    s += `<rect x="${bx}" y="${by}" width="${bw - 6}" height="${h - pad.b - by}" rx="2" fill="${COL[d.topic]}"/>`;
  });
  // topic legend
  const legend = [['liked (arXiv/Rust)', COL.liked], ['crypto', COL.crypto], ['neutral', COL.neutral]];
  legend.forEach(([t, c], i) => {
    const lx = pad.l + i * 150;
    s += `<rect x="${lx}" y="${h - 16}" width="10" height="10" rx="2" fill="${c}"/><text x="${lx + 14}" y="${h - 7}" class="tick">${t}</text>`;
  });
  return s + '</svg>';
}

function rankProgression(mean, { w = 300, h = 200, n = 15 } = {}) {
  const steps = ['cold', 'affinity', 'learned', 'full'];
  const labels = { cold: 'cold', affinity: '+affinity', learned: '+learned', full: '+embeds' };
  const pad = { l: 30, r: 14, t: 16, b: 34 };
  const x = (i) => pad.l + (i / (steps.length - 1)) * (w - pad.l - pad.r);
  const y = (rank) => pad.t + ((rank - 1) / (n - 1)) * (h - pad.t - pad.b); // rank 1 at top
  let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">`;
  [1, 5, 10, 15].forEach((rk) => {
    s += `<line x1="${pad.l}" y1="${y(rk)}" x2="${w - pad.r}" y2="${y(rk)}" stroke="${COL.grid}" stroke-dasharray="2 3"/>`;
    s += `<text x="${pad.l - 6}" y="${y(rk) + 3}" text-anchor="end" class="tick">#${rk}</text>`;
  });
  const pts = steps.map((st, i) => `${x(i)},${y(mean[st])}`).join(' ');
  s += `<polyline points="${pts}" fill="none" stroke="${COL.liked}" stroke-width="2"/>`;
  steps.forEach((st, i) => {
    s += `<circle cx="${x(i)}" cy="${y(mean[st])}" r="3.5" fill="${COL.liked}"/>`;
    s += `<text x="${x(i)}" y="${y(mean[st]) - 8}" text-anchor="middle" class="val">${mean[st]}</text>`;
    s += `<text x="${x(i)}" y="${h - 18}" text-anchor="middle" class="tick">${labels[st]}</text>`;
  });
  s += `<text x="${w / 2}" y="${h - 4}" text-anchor="middle" class="tick">mean rank of liked items (lower = better)</text>`;
  return s + '</svg>';
}

// ---------- causal before/after table ----------
const coldRank = new Map(R.causal.rankings.cold.map((r) => [r.id, r.rank]));
const byFull = R.causal.rankings.full.slice().sort((a, b) => a.rank - b.rank);
const causalRows = byFull.map((r) => {
  const c = coldRank.get(r.id);
  const delta = c - r.rank;
  const arrow = delta > 0 ? `<span class="up">▲ ${delta}</span>` : delta < 0 ? `<span class="down">▼ ${-delta}</span>` : '<span class="flat">–</span>';
  return `<tr>
    <td class="num">${r.rank}</td>
    <td class="num muted">${c}</td>
    <td>${arrow}</td>
    <td><span class="dot" style="background:${COL[r.topic]}"></span>${esc(r.topic)}</td>
    <td>${esc(r.title)}</td>
    <td class="num">${r.score.toFixed(3)}</td>
    <td class="chips">${(r.reasons || []).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</td>
  </tr>`;
}).join('');

// ---------- KPI cards ----------
const t = R.training;
const passed = R.assertions.filter((a) => a.pass).length;
const meanPos = (t.probPositives.reduce((a, b) => a + b, 0) / t.probPositives.length);
const meanNeg = (t.probNegatives.reduce((a, b) => a + b, 0) / t.probNegatives.length);
const kpis = [
  ['Assertions passed', `${passed}/${R.assertions.length}`, passed === R.assertions.length ? 'ok' : 'bad'],
  ['Liked items: cold → personalized', `mean rank ${R.causal.likedMeanRank.cold} → ${R.causal.likedMeanRank.full}`, 'ok'],
  ['Held-out AUC (generalization)', t.holdoutAUC.toFixed(2), t.holdoutAUC > 0.75 ? 'ok' : 'bad'],
  ['P(engage): liked vs skipped', `${meanPos.toFixed(2)} vs ${meanNeg.toFixed(2)}`, 'ok'],
  ['Interaction signals learned from', String(R.data.totalEvents), 'ok'],
];

// ---------- training-data matrix (the exact labelled samples) ----------
const featShort = ['pop', 'rec', 'disc', 'domAff', 'authAff', 'folDom', 'folUsr', 'kw', 'rel', 'term', 'pop×rec', 'domAff×disc', 'rel×term'];
const trainingRows = (R.trainingData || []).map((r) => `<tr>
    <td>${r.label === 1 ? '<span class="up">1 · liked</span>' : '<span class="down">0 · skipped</span>'}</td>
    <td><span class="dot" style="background:${COL[r.topic]}"></span>${esc(r.topic)}</td>
    <td>${esc(r.title)}</td>
    ${r.x.map((v) => `<td class="num">${v}</td>`).join('')}
  </tr>`).join('');

// ---------- weight + affinity + wiring tables ----------
const weightRows = R.featureNames.map((n, i) => ({ k: n, v: t.weights[i] }));
const wiringTerms = (() => {
  const f = R.wiring.features;
  const W = { popularity: 1.0, recency: 1.0, discussion: 0.6, affinity: 1.4, relevance: 1.2, learned: 0.8 };
  const affinityRaw = f.domainAffinity + f.authorAffinity + (f.followedDomain ? 2 : 0) + (f.followedUser ? 2 : 0) + (f.boostKeyword ? 1.5 : 0);
  const affinity = Math.tanh(affinityRaw / 4);
  return [
    ['popularity', W.popularity, f.popularity, W.popularity * f.popularity],
    ['recency', W.recency, f.recency, W.recency * f.recency],
    ['discussion', W.discussion, f.discussion, W.discussion * f.discussion],
    ['affinity (tanh blend)', W.affinity, +affinity.toFixed(4), W.affinity * affinity],
    ['relevance (embeddings)', W.relevance, f.relevance, W.relevance * f.relevance],
    ['learned (logistic P−0.5)×2', W.learned, +((R.wiring.predictProba - 0.5) * 2).toFixed(4), R.wiring.learnedTermWith],
  ].map(([n, wt, fv, term]) => `<tr><td>${n}</td><td class="num">${(+wt).toFixed(2)}</td><td class="num">${(+fv).toFixed(4)}</td><td class="num">${(+term).toFixed(4)}</td></tr>`).join('');
})();

const assertionRows = R.assertions.map((a) => `<tr><td>${a.pass ? '<span class="up">✓ pass</span>' : '<span class="down">✗ fail</span>'}</td><td>${esc(a.name)}</td><td class="muted">${esc(a.detail)}</td></tr>`).join('');

const eventRows = Object.entries(R.data.eventCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('');

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Hacker Lens — Personalization Proof</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='%23ff6600'/></svg>"/>
<style>
  :root{ --bg:#0d1117; --panel:#161b22; --panel2:#0b0f14; --fg:#e6edf3; --muted:#8b949e; --border:#30363d; --accent:#58a6ff; }
  [data-theme="light"]{ --bg:#f6f8fa; --panel:#fff; --panel2:#f0f3f6; --fg:#1f2328; --muted:#59636e; --border:#d0d7de; --accent:#0969da; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:1000px;margin:0 auto;padding:28px 20px 80px}
  header.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}
  h1{font-size:22px;margin:0}
  h2{font-size:17px;margin:34px 0 4px;padding-top:14px;border-top:1px solid var(--border)}
  .sub{color:var(--muted);margin:2px 0 0}
  .lede{color:var(--muted);margin:6px 0 0;max-width:75ch}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:20px 0}
  .kpi{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
  .kpi .v{font-size:20px;font-weight:650;margin-top:4px}
  .kpi .k{color:var(--muted);font-size:12px}
  .kpi.ok{border-left:3px solid #3fb950}.kpi.bad{border-left:3px solid #f85149}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin-top:12px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:820px){.grid2{grid-template-columns:1fr}}
  .chart{width:100%;height:auto;display:block}
  .chart .lbl{fill:var(--fg);font-size:11px}.chart .val{fill:var(--fg);font-size:11px;font-weight:600}.chart .tick{fill:var(--muted);font-size:10px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
  th{color:var(--muted);font-weight:600;cursor:pointer;user-select:none;position:sticky;top:0;background:var(--panel)}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .muted{color:var(--muted)}
  .up{color:#3fb950;font-weight:600}.down{color:#f85149;font-weight:600}.flat{color:var(--muted)}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .chip{display:inline-block;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent);border-radius:20px;padding:1px 8px;font-size:11px;margin:1px 3px 1px 0;white-space:nowrap}
  .chips{max-width:280px}
  .shot{width:100%;border:1px solid var(--border);border-radius:8px;margin-top:8px}
  .pill{font-size:12px;padding:3px 9px;border-radius:20px;border:1px solid var(--border);background:var(--panel)}
  .pass-banner{background:color-mix(in srgb,#3fb950 14%,transparent);border:1px solid #3fb950;color:#3fb950}
  code{background:var(--panel2);border:1px solid var(--border);border-radius:5px;padding:1px 5px;font-size:12px}
  button.tgl{cursor:pointer;background:var(--panel);color:var(--fg);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:13px}
  .note{font-size:12.5px;color:var(--muted);margin-top:8px}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <h1>Hacker Lens — Personalization, Proven</h1>
      <p class="sub">Generated ${esc(R.meta.generatedAt)} · every number below is produced by the app's <em>real</em> ranking modules, driven through <code>window.__hnlens</code>.</p>
    </div>
    <button class="tgl" onclick="document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'">◐ theme</button>
  </header>

  <p class="lede">A controlled A/B experiment. We seed one known taste as interaction history —
    <strong style="color:${COL.liked}">loves arXiv papers + Rust + user "pg"</strong>, <strong style="color:${COL.crypto}">ignores/hides crypto</strong> —
    then run the whole pipeline and watch it (1) learn the taste, (2) fit a model that generalizes, and
    (3) actually reorder a feed of stories it has never seen. Crypto is deliberately given the <em>highest</em>
    HN scores, so a non-personalized ranker gets it wrong and only learning-from-history fixes it.</p>

  <div class="kpis">
    ${kpis.map(([k, v, cls]) => `<div class="kpi ${cls}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}
  </div>

  <h2>1 · Data — your history is captured</h2>
  <p class="lede">Clicks, saves, hides and impressions are logged locally (IndexedDB). From them, <code>computeAffinities()</code>
    derives a weighted score per domain and per author. The signal is unambiguous: liked domains/authors go strongly positive, hidden crypto goes negative.</p>
  <div class="grid2">
    <div class="card"><strong>Learned domain affinity</strong>${divergingBars(R.affinities.domains.map((d) => ({ k: d.k, v: +d.v.toFixed(1), color: /arxiv|github/.test(d.k) ? COL.liked : COL.crypto })))}</div>
    <div class="card"><strong>Learned author affinity (top)</strong>${divergingBars(R.affinities.authors.slice(0, 6).map((d) => ({ k: d.k, v: +d.v.toFixed(1), color: COL.liked })))}</div>
  </div>
  <div class="card"><strong>${R.data.totalEvents} interaction signals</strong> across ${R.data.itemsSeeded} stories
    <table><thead><tr><th>event type</th><th class="num">count</th></tr></thead><tbody>${eventRows}</tbody></table>
  </div>

  <h2>2 · Train — "Train from history" fits a model</h2>
  <p class="lede">Engaged stories are labelled <strong style="color:${COL.pos}">1</strong>, impressed-but-ignored and hidden stories <strong style="color:${COL.neg}">0</strong>.
    A logistic regression is trained from scratch by batch gradient descent. <em>AUC</em> = probability the model ranks a random liked story above a random skipped one (0.5 = coin flip, 1.0 = perfect).</p>

  <div class="card"><strong>Training data — the ${R.trainingData ? R.trainingData.length : 0} labelled samples the model fits on</strong>
    <div class="note">Each row is one story from your history turned into a 9-number feature vector plus its label. This is <em>exactly</em> what the real <code>buildTrainingSamples()</code> feeds the trainer (click a header to sort).</div>
    <div style="overflow-x:auto"><table id="tblTrain"><thead><tr><th>label</th><th>topic</th><th>story</th>${featShort.map((f) => `<th class="num">${f}</th>`).join('')}</tr></thead><tbody>${trainingRows}</tbody></table></div>
    <div class="note">pop=popularity · rec=recency · disc=discussion · domAff=domain affinity · authAff=author affinity · folDom=followed domain · folUsr=followed user · kw=boost keyword · rel=embedding relevance. Notice liked rows have high domAff/authAff; skipped (crypto) rows don't.</div>
  </div>

  <div class="grid2">
    <div class="card"><strong>Training loss ↓ over ${t.lossCurve.length} epochs</strong> — from empty model (${t.initialLoss}) to fitted (${t.finalLoss})${lineChart(t.lossCurve, { yMax: 0.72, label: 'log-loss' })}
      <div class="note">Curve computed by re-running the real trainer for k = 1…${t.lossCurve.length} epochs.</div></div>
    <div class="card"><strong>The trained model — learned weight per feature</strong>${divergingBars(weightRows.map((r) => ({ k: r.k, v: r.v })), { unit: '' })}
      <div class="note">These 9 weights + bias <strong>${R.model ? R.model.bias : t.bias}</strong> (trained on n=<strong>${R.model ? R.model.n : t.modelN}</strong>) <em>are</em> the model — persisted in IndexedDB under <code>kv["model:logistic"]</code>. Domain/author affinity + boost-keyword dominate; popularity/recency go small/negative because high-score crypto was the negative class.</div></div>
  </div>
  <div class="card"><strong>Fit quality</strong>
    <table><tbody>
      <tr><td>Train accuracy</td><td class="num">${(t.trainAcc * 100).toFixed(0)}%</td><td>Held-out accuracy</td><td class="num">${(t.holdoutAcc * 100).toFixed(0)}%</td></tr>
      <tr><td>Train AUC</td><td class="num">${t.trainAUC.toFixed(3)}</td><td>Held-out AUC (30% split)</td><td class="num">${t.holdoutAUC.toFixed(3)}</td></tr>
      <tr><td>Examples</td><td class="num">${t.modelN}</td><td>liked / skipped</td><td class="num">${t.positives} / ${t.negatives}</td></tr>
    </tbody></table>
  </div>

  <h2>3 · Trained correctly — the model separates liked from skipped</h2>
  <p class="lede">Predicted probability of engagement for each training story. Liked stories cluster near 1, skipped near 0, cleanly split by the 0.5 boundary — the model didn't just memorize a constant, it learned the boundary.</p>
  <div class="card">${dotStrip(t.probPositives, t.probNegatives)}
    <div class="note">liked mean P(engage) = <strong style="color:${COL.pos}">${meanPos.toFixed(3)}</strong> · skipped mean = <strong style="color:${COL.neg}">${meanNeg.toFixed(3)}</strong></div>
  </div>

  <h2>4 · Used correctly — the model actually drives the score</h2>
  <p class="lede">For a held-out Rust story, we recompute the ranking score by hand from the model + weights + features, and compare to what <code>scoreItem()</code> returns. They match to 9 decimals — proof the trained probability is really consumed. Toggle the model off and the learned term drops to exactly 0.</p>
  <div class="grid2">
    <div class="card"><strong>Score decomposition — #${R.wiring.probeId} "${esc(R.wiring.probeTitle)}"</strong>
      <table><thead><tr><th>signal</th><th class="num">weight</th><th class="num">feature</th><th class="num">contribution</th></tr></thead><tbody>${wiringTerms}</tbody></table>
    </div>
    <div class="card"><strong>Equality & toggle checks</strong>
      <table><tbody>
        <tr><td>scoreItem()</td><td class="num">${R.wiring.scoreItemScore}</td></tr>
        <tr><td>recomputed by hand</td><td class="num">${R.wiring.byHandScore}</td></tr>
        <tr><td>match (|Δ| &lt; 1e-9)</td><td class="num up">${R.wiring.match ? '✓ yes' : '✗ no'}</td></tr>
        <tr><td>score with trained model</td><td class="num">${R.wiring.scoreWithModel}</td></tr>
        <tr><td>score with model OFF</td><td class="num">${R.wiring.scoreWithoutModel}</td></tr>
        <tr><td>learned-term shift</td><td class="num">${R.wiring.deltaFromModel}</td></tr>
        <tr><td>predictProba</td><td class="num">${R.wiring.predictProba}</td></tr>
      </tbody></table>
      <div class="note">The learned term is <code>w.learned × (P−0.5) × 2</code>; with no model P defaults to 0.5 → term = 0 (personalization is inactive, not silently wrong).</div>
    </div>
  </div>

  <h2>5 · Causal — the feed actually changes</h2>
  <p class="lede">The held-out pool (15 stories the model never trained on) ranked two ways. <strong>Cold</strong> = no personalization (popularity/recency only). <strong>Personalized</strong> = affinities + trained model + embeddings. The 5 liked stories climb from a mean rank of ${R.causal.likedMeanRank.cold} to <strong>${R.causal.likedMeanRank.full}</strong> (i.e. the top 5), while high-score crypto sinks from ${R.causal.dislikedMeanRank.cold} to ${R.causal.dislikedMeanRank.full}.</p>
  <div class="grid2">
    <div class="card"><strong>Liked items rise as each mechanism is added</strong>${rankProgression(R.causal.likedMeanRank)}</div>
    <div class="card"><strong>Cold-start top of feed</strong>
      <table><tbody>${R.causal.rankings.cold.slice(0, 5).map((r) => `<tr><td class="num">${r.rank}</td><td><span class="dot" style="background:${COL[r.topic]}"></span>${esc(r.topic)}</td><td>${esc(r.title)}</td></tr>`).join('')}</tbody></table>
      <div class="note">Without your history, high-score crypto dominates the top.</div>
    </div>
  </div>
  <div class="card"><strong>Full re-ranking (personalized order, with rank change vs cold)</strong>
    <table id="tblCausal"><thead><tr><th class="num">rank</th><th class="num">was</th><th>Δ</th><th>topic</th><th>story</th><th class="num">score</th><th>why (from the app)</th></tr></thead><tbody>${causalRows}</tbody></table>
  </div>

  <h2>6 · Content — titles, embeddings & comments feed the model</h2>
  <p class="lede">Two content signals now train into the reranker (both use leave-one-out so a story is never
    compared against a profile containing itself). <strong>relevance</strong> = cosine similarity of a story's
    (title + HN self-text) embedding to the centroid of what you engaged with. <strong>termAffinity</strong> =
    contrastive overlap of a story's title terms against a term profile built from the <em>titles + top comments</em>
    of threads you engaged with, minus a disliked-term profile. (Hard limit: linked <em>article</em> bodies can't be
    read in-browser — no CORS — so content = titles, HN self-text, and HN comments.)</p>
  <div class="card"><strong>Embedding relevance to your reading profile</strong>${simBars(R.embeddings.sims)}
    <div class="note">liked mean similarity = <strong style="color:${COL.liked}">${R.embeddings.likedMeanSim}</strong> · crypto mean = <strong style="color:${COL.crypto}">${R.embeddings.dislikedMeanSim}</strong></div>
  </div>
  ${R.content && R.content.commentProof ? `<div class="card"><strong>Proof that COMMENT text feeds the model</strong>
    <p class="lede" style="margin-top:6px">Two near-identical stories on a domain you've never engaged with (no domain/author/embedding affinity). They differ by one word: <strong>2006</strong>'s title contains a term (<code>wasm</code>) that appeared <em>only in the comments</em> of threads you engaged with — never in any title. <strong>2007</strong>'s doesn't. The gap is attributable to comment text alone.</p>
    <table><thead><tr><th>story</th><th class="num">termAffinity</th><th class="num">embedding relevance</th><th class="num">rank (personalized)</th></tr></thead><tbody>
      <tr><td><span class="dot" style="background:${COL.liked}"></span>#2006 "wasm sandbox internals"</td><td class="num up">${R.content.commentProof.termWith}</td><td class="num muted">${R.content.commentProof.relevanceWith}</td><td class="num">#${R.content.commentProof.rankWith}</td></tr>
      <tr><td><span class="dot" style="background:${COL.neutral}"></span>#2007 "kubernetes cluster internals"</td><td class="num">${R.content.commentProof.termWithout}</td><td class="num muted">${R.content.commentProof.relevanceWith}</td><td class="num">#${R.content.commentProof.rankWithout}</td></tr>
    </tbody></table>
    <div class="note">Same domain, same score, same (neutral) embedding — the only difference is a word seen in comments, and it moves the story up. That's comment content driving the ranking.</div>
  </div>` : ''}
  ${R.content && R.content.articleProof ? `<div class="card"><strong>Opt-in: linked ARTICLE-body text (free reader services, no setup)</strong>
    <p class="lede" style="margin-top:6px">Off, article bodies are never fetched (browsers can't read cross-site pages). On, engaged articles are fetched via a chain of free public proxies (AllOrigins → cors.eu.org → codetabs) and their text feeds the term profile. The term <code>raft</code> appears only in article <em>bodies</em> (no title/comment): a story whose title has it lifts only when the feature is on.</p>
    <table><thead><tr><th>story</th><th class="num">termAffinity · proxy OFF</th><th class="num">termAffinity · proxy ON</th></tr></thead><tbody>
      <tr><td><span class="dot" style="background:${COL.liked}"></span>#2008 "raft consensus internals"</td><td class="num muted">${R.content.articleProof.off.raft}</td><td class="num up">${R.content.articleProof.on.raft}</td></tr>
      <tr><td><span class="dot" style="background:${COL.neutral}"></span>#2009 "gossip protocol internals"</td><td class="num muted">${R.content.articleProof.off.gossip}</td><td class="num">${R.content.articleProof.on.gossip}</td></tr>
    </tbody></table>
    <div class="note">Off by default — it sends the URLs you read to the proxy, the one non-local feature.</div>
  </div>` : ''}

  <h2>7 · In the real product</h2>
  <p class="lede">The same pipeline, driven through the actual UI over a mocked HN API so the controlled taste flows end-to-end. For-You surfaces a liked story first with a real "why" chip; Settings shows the trained-model status and the recorded signal count.</p>
  <div class="grid2">
    <div class="card"><strong>For You feed</strong> — #1: "${esc(R.ui.firstCard.title)}"<br/><span class="muted">chips:</span> ${(R.ui.firstCard.chips || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}${dataUri('foryou.png') ? `<img class="shot" src="${dataUri('foryou.png')}" alt="For You feed screenshot"/>` : ''}</div>
    <div class="card"><strong>Settings</strong> — ${esc(R.ui.trained || '')} · ${esc(R.ui.signals || '')}${dataUri('settings.png') ? `<img class="shot" src="${dataUri('settings.png')}" alt="Settings screenshot"/>` : ''}
      <div class="note">The UI "Train" button retrains on <em>current</em> data, so its example count includes impressions accrued while browsing (≥ the ${t.modelN} from the offline run).</div></div>
  </div>
  ${dataUri('explain.png') ? `<div class="card"><strong>In-app "Why #N?" explainer</strong> — click the button on any For-You card to trace its rank: score → weighted signals → the learned model's per-feature contributions → the data it trained on. This is the same decomposition as §4/§5, live in the product.<img class="shot" src="${dataUri('explain.png')}" alt="Rank explainer dialog screenshot"/></div>` : ''}

  <h2>8 · All assertions</h2>
  <div class="card ${passed === R.assertions.length ? 'pass-banner' : ''}" style="margin-bottom:8px;padding:10px 14px"><strong>${passed}/${R.assertions.length} assertions passed.</strong> Re-run with <code>npm run test:personalization</code>.</div>
  <div class="card">
    <table id="tblAssert"><thead><tr><th>result</th><th>assertion</th><th>detail</th></tr></thead><tbody>${assertionRows}</tbody></table>
  </div>
</div>

<script>
// numeric-aware column sort (Number() not parseFloat, per dashboard gotchas)
document.querySelectorAll('table#tblCausal, table#tblAssert, table#tblTrain').forEach((tbl) => {
  tbl.querySelectorAll('th').forEach((th, i) => th.addEventListener('click', () => {
    const rows = [...tbl.tBodies[0].rows];
    const dir = th.dataset.dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
    const num = (s) => { const n = Number(String(s).replace(/[^0-9.\\-]/g, '')); return isNaN(n) ? null : n; };
    rows.sort((a, b) => {
      const x = a.cells[i].innerText.trim(), y = b.cells[i].innerText.trim();
      const nx = num(x), ny = num(y);
      const c = (nx !== null && ny !== null) ? nx - ny : x.localeCompare(y);
      return dir === 'asc' ? c : -c;
    });
    rows.forEach((r) => tbl.tBodies[0].appendChild(r));
  }));
});
window.__proofReady = true;
</script>
</body>
</html>`;

const out = join(DIR, 'personalization-proof.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
