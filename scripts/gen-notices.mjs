/**
 * Generate THIRD_PARTY_NOTICES.md from the RUNTIME dependency CLOSURE — every package that can be
 * redistributed in the bundle, not only the ones named in package.json.
 *
 * Why this exists: Hacker Lens ships as a static bundle, so every `dependencies` entry is redistributed
 * to users. Four of them are Apache-2.0, whose section 4(d) requires propagating any upstream NOTICE
 * file, and dompurify is dual-licensed so the elected license has to be stated. That is a real (if
 * small) legal obligation and it was previously undocumented.
 *
 * Generated rather than hand-written so it cannot drift from package.json — a hand-maintained
 * attribution list is exactly the kind of file that silently goes stale after a dependency bump.
 * `devDependencies` are deliberately excluded: they are build-time only and are not redistributed
 * (axe-core's MPL-2.0, for instance, never reaches a user).
 *
 * Usage: node scripts/gen-notices.mjs [--check]
 *   --check exits non-zero if the committed file is out of date, for CI/verify.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'THIRD_PARTY_NOTICES.md';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

/**
 * The TRANSITIVE runtime closure, not just the direct dependencies.
 *
 * The direct list is 12 packages; the closure is far larger, and every one of them can end up in a
 * user's bundle — react-router, scheduler and the onnxruntime-web pieces are all demonstrably in
 * `dist/`. Attribution obligations attach to what is REDISTRIBUTED, and minification strips the
 * `@license` headers that would otherwise carry them, so listing only the names we happened to type
 * into package.json understated the file's own claim to list "the runtime dependencies below".
 *
 * Walked from package.json through each installed package's own `dependencies`, which is the same
 * closure the bundler resolves. Optional and peer deps are skipped: an absent optional dependency
 * is not redistributed.
 */
function runtimeClosure(rootDeps) {
  const seen = new Set();
  const queue = [...rootDeps];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const dir = join('node_modules', name);
    if (!existsSync(join(dir, 'package.json'))) continue; // not installed => not shipped
    seen.add(name);
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    for (const d of Object.keys(meta.dependencies ?? {})) if (!seen.has(d)) queue.push(d);
  }
  return [...seen].sort();
}
const deps = runtimeClosure(Object.keys(pkg.dependencies ?? {}).sort());

/**
 * AI MODELS are redistributed too — just not through npm. They are downloaded to the user's browser
 * at runtime from the model host, so the dependency walk above cannot see them, yet their licenses
 * carry attribution obligations (Meta's Llama 3.2 Community License requires displaying "Built with
 * Llama"). The model IDs are read from the catalog that is the app's single source of truth, and any
 * ID without a license entry below is a hard error — so adding a model cannot silently ship it
 * unattributed.
 */
const MODEL_LICENSES = [
  {
    match: /^Llama-3\.2/,
    name: 'Llama 3.2 (Meta)',
    license: 'Llama 3.2 Community License',
    url: 'https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE',
    attribution: 'Built with Llama.',
  },
  { match: /all-MiniLM-L6-v2/, name: 'all-MiniLM-L6-v2 (via Xenova ONNX)', license: 'Apache-2.0', url: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2' },
  { match: /bge-small-en/, name: 'bge-small-en-v1.5 (BAAI, via Xenova ONNX)', license: 'MIT', url: 'https://huggingface.co/BAAI/bge-small-en-v1.5' },
  { match: /gte-small/, name: 'gte-small (via Xenova ONNX)', license: 'MIT', url: 'https://huggingface.co/thenlper/gte-small' },
];

function noticesFail(msg) {
  console.error(msg);
  process.exit(1);
}

function catalogModelIds() {
  const src = readFileSync(join('src', 'lib', 'models', 'catalog.ts'), 'utf8');
  const ids = new Set();
  // Matches both `id: '<x>'` (LLMs) and `value: '<x>'` (embeddings) in the catalog literals.
  for (const m of src.matchAll(/\b(?:id|value):\s*'([^']+)'/g)) ids.add(m[1]);
  return [...ids];
}

const models = catalogModelIds().map((id) => {
  const entry = MODEL_LICENSES.find((e) => e.match.test(id));
  if (!entry) noticesFail(`No license entry for catalog model "${id}" — add it to MODEL_LICENSES in scripts/gen-notices.mjs.`);
  return { id, ...entry };
});

/** Upstream NOTICE text, if the package ships one (Apache-2.0 §4(d)). */
function noticeFor(dir) {
  for (const n of ['NOTICE', 'NOTICE.txt', 'NOTICE.md']) {
    const p = join(dir, n);
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  }
  return null;
}

const rows = [];
const notices = [];
for (const name of deps) {
  const dir = join('node_modules', name);
  if (!existsSync(join(dir, 'package.json'))) {
    console.error(`WARN: ${name} not installed — run npm ci first`);
    continue;
  }
  const m = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const license = m.license ?? (Array.isArray(m.licenses) ? m.licenses.map((l) => l.type).join(' OR ') : 'UNKNOWN');
  const home = m.homepage ?? m.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '') ?? '';
  rows.push({ name, version: m.version, license, home });
  const notice = noticeFor(dir);
  if (notice) notices.push({ name, notice });
}

const apache = rows.filter((r) => /Apache-2\.0/.test(r.license));
const lines = [];
lines.push('# Third-party notices');
lines.push('');
lines.push('Hacker Lens is MIT-licensed (see `LICENSE`). It is distributed as a static browser bundle.');
lines.push('This file lists the packages in the runtime dependency closure reached through each');
lines.push("package's own `dependencies`, their licenses, and any upstream NOTICE text they require.");
lines.push('It also lists the AI models the app downloads to your browser at runtime, which carry');
lines.push('their own attribution requirements.');
lines.push('');
// Do NOT claim everything listed is redistributed. The closure includes packages that never reach
// the bundle — `sharp` is the Node-only image backend of Transformers.js, and SECURITY.md says so
// explicitly. Two shipped documents contradicting each other is worse than over-listing, and
// over-listing is the safe direction for an attribution file.
lines.push('Listing is deliberately conservative: a package appears here if it is in that dependency');
lines.push('closure, whether or not it ends up in the shipped bundle. Some do not — for example `sharp`,');
lines.push('the Node-only image backend of Transformers.js, which the browser build never imports (see');
lines.push('`SECURITY.md`). They are listed anyway rather than risk omitting an attribution that is owed.');
lines.push('');
lines.push('Scope: optional and peer dependencies are not walked. The only copyleft they would add is the');
lines.push('`@img/sharp-libvips-*` platform binaries (LGPL-3.0), which are `sharp` optionalDependencies —');
lines.push('never fetched by the browser build, never in `dist/`, so not redistributed by this project.');
lines.push('');
lines.push('Build-time-only packages (`devDependencies`) are not listed: they are not part of the');
lines.push('shipped bundle and are not redistributed.');
lines.push('');
lines.push('> Generated by `node scripts/gen-notices.mjs` — do not edit by hand.');
lines.push('');
lines.push('## Bundled runtime dependencies');
lines.push('');
lines.push('| Package | Version | License |');
lines.push('| --- | --- | --- |');
for (const r of rows) {
  const label = r.home ? `[${r.name}](${r.home})` : r.name;
  lines.push(`| ${label} | ${r.version} | ${r.license} |`);
}
lines.push('');
if (apache.length) {
  lines.push('## Apache License 2.0');
  lines.push('');
  lines.push(`The following are licensed under the Apache License, Version 2.0:`);
  lines.push('');
  for (const r of apache) lines.push(`- ${r.name} ${r.version}`);
  lines.push('');
  lines.push('You may obtain a copy of the license at <https://www.apache.org/licenses/LICENSE-2.0>.');
  lines.push('Unless required by applicable law or agreed to in writing, software distributed under');
  lines.push('the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY');
  lines.push('KIND, either express or implied.');
  lines.push('');
}
if (models.length) {
  lines.push('## AI models (downloaded to your browser at runtime)');
  lines.push('');
  lines.push('These are not npm packages and are not in the bundle; the app fetches them on demand from');
  lines.push('the model host when you enable on-device AI. They are listed here because their licenses');
  lines.push('require attribution when the model is used in a product.');
  lines.push('');
  lines.push('| Model | License |');
  lines.push('| --- | --- |');
  for (const m of models) lines.push(`| [${m.name}](${m.url}) | ${m.license} |`);
  lines.push('');
  const attributions = [...new Set(models.filter((m) => m.attribution).map((m) => m.attribution))];
  for (const a of attributions) lines.push(`**${a}**`);
  if (attributions.length) lines.push('');
}

const dual = rows.filter((r) => /OR/.test(r.license));
if (dual.length) {
  lines.push('## Dual-licensed packages');
  lines.push('');
  for (const r of dual) {
    // Elect an option the package ACTUALLY OFFERS. This used to print "Hacker Lens elects the
    // Apache-2.0 option" for every dual-licensed package regardless of what it offered, which for
    // type-fest (`MIT OR CC0-1.0`) asserted an election of a licence that is not on the table — a
    // false statement in a shipped legal file, certified as up to date by `--check`.
    const options = r.license.replace(/[()]/g, '').split(/\s+OR\s+/i).map((x) => x.trim());
    const preference = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'ISC', 'CC0-1.0', '0BSD'];
    const chosen = preference.find((p) => options.includes(p)) ?? options[0];
    const covered = chosen === 'Apache-2.0' ? ', so its terms are covered by the section above' : '';
    lines.push(`- **${r.name}** ${r.version} — offered as \`${r.license}\`. Hacker Lens elects the`);
    lines.push(`  **${chosen}** option${covered}.`);
  }
  lines.push('');
}
if (notices.length) {
  lines.push('## Upstream NOTICE files');
  lines.push('');
  lines.push('Reproduced as required by Apache-2.0 section 4(d).');
  lines.push('');
  for (const n of notices) {
    lines.push(`### ${n.name}`);
    lines.push('');
    lines.push('```text');
    lines.push(n.notice);
    lines.push('```');
    lines.push('');
  }
}
const out = lines.join('\n').replace(/\n{3,}/g, '\n\n');

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current.trim() !== out.trim()) {
    console.error(`${OUT} is out of date — run: node scripts/gen-notices.mjs`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date (${rows.length} runtime deps, ${apache.length} Apache-2.0).`);
} else {
  writeFileSync(OUT, out + '\n');
  console.log(`wrote ${OUT} — ${rows.length} runtime deps, ${apache.length} Apache-2.0, ${notices.length} upstream NOTICE file(s).`);
}
