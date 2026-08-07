// Reader-proxy layer test — guards src/lib/hn/proxy.ts: the two-stage content scorer + attribution,
// charset-aware decoding (the jibberish fix), and the per-browser health ranker (Laplace-smoothed
// reliability + content-quality + latency, circuit-breaker, seed-order tiebreak, persistence across
// reload). Drives the REAL module via window.__hnlens.proxy(); pure functions, so no network mocking.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const page = (await b.newContext({ viewport: { width: 1000, height: 800 } })).pages()[0] || (await b.newPage());
// Keep the app's startup feed fetches off the network — this test only exercises pure functions.
await page.route(/hacker-news\.firebaseio\.com|hn\.algolia\.com|google\.com\/s2|gstatic\.com/, (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.proxy, null, { timeout: 20000 });

// ---- 1) two-stage content scorer + attribution ----
const sc = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  const prose =
    'This is a genuinely substantive article body with plenty of ordinary words so that it clears the minimum and reads as real prose rather than a navigation dump or an error page. '.repeat(4);
  const clean = p.scoreContent(`<html><body><article><p>${prose}</p></article></body></html>`, prose, { title: 'substantive article prose body' });
  const enc = p.scoreContent('\uFFFD'.repeat(400), 'x');
  const blocked = p.scoreContent(`<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue. ${'x'.repeat(400)}</body></html>`, 'Enable JavaScript and cookies to continue.');
  const tiny = p.scoreContent('tiny', '');
  const js = p.scoreContent(`<html><body><div id="root"></div><script>${'a'.repeat(1000)}</script></body></html>`, 'Loading');
  const pProse = 'This paragraph has real sentences and stopwords in the raw html body. '.repeat(20);
  const parser = p.scoreContent(`<html><body><p>${pProse}</p></body></html>`, 'short bit');
  const thin = p.scoreContent(`<html><body>${'x'.repeat(400)}</body></html>`, 'alpha beta gamma delta epsilon zeta '.repeat(20));
  return {
    clean: clean.attribution,
    cleanQ: clean.quality,
    enc: enc.attribution,
    blocked: blocked.attribution,
    tiny: tiny.attribution,
    js: js.attribution,
    parser: parser.attribution,
    thin: thin.attribution,
  };
});
check('scorer: server-rendered prose ⇒ clean', sc.clean === 'clean', sc.clean);
check('scorer: clean has high quality (>0.6)', sc.cleanQ > 0.6, `q=${sc.cleanQ}`);
check('scorer: mojibake ⇒ proxy-encoding (the jibberish case)', sc.enc === 'proxy-encoding', sc.enc);
check('scorer: blocker page ⇒ proxy-error', sc.blocked === 'proxy-error', sc.blocked);
check('scorer: tiny body ⇒ proxy-error', sc.tiny === 'proxy-error', sc.tiny);
check('scorer: empty HTML shell + short text ⇒ js-source (missed content)', sc.js === 'js-source', sc.js);
check('scorer: prose IN html but short extract ⇒ parser (our fault, fixable)', sc.parser === 'parser', sc.parser);
check('scorer: long but boilerplate/low-stopword ⇒ thin', sc.thin === 'thin', sc.thin);

// ---- 2) charset-aware decode (jibberish fix) ----
const cs = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  const bytes = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]); // 日本語 in Shift-JIS
  const withCs = p.decodeBytes(bytes, 'text/html; charset=shift_jis');
  const noCs = p.decodeBytes(bytes, 'text/html'); // wrongly assumes UTF-8
  return { withCs, hasRepl: /\uFFFD/.test(noCs) };
});
check('decode: Shift-JIS bytes decode correctly with the charset', cs.withCs === '\u65e5\u672c\u8a9e', JSON.stringify(cs.withCs));
check('decode: same bytes as UTF-8 (no charset) ⇒ jibberish (replacement chars)', cs.hasRepl === true);

// ---- 3) health ranker: seed order, quality/reliability reorder, circuit-breaker ----
const rk = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  p.resetProxyHealth();
  const seed = p.rankProxies(undefined, { explore: false }).map((x) => x.name);
  for (let i = 0; i < 3; i++) p.recordOutcome('AllOrigins', { ok: false });
  p.recordOutcome('cors.eu.org', { ok: true, ms: 400, quality: 0.9 });
  const ranked = p.rankProxies(undefined, { explore: false }).map((x) => x.name);
  const snap = p.proxyHealthSnapshot();
  const ao = snap.find((s) => s.name === 'AllOrigins');
  const ce = snap.find((s) => s.name === 'cors.eu.org');
  p.recordOutcome('AllOrigins', { ok: true, ms: 300, quality: 0.8 }); // recovers → circuit resets
  const afterRecover = p.rankProxies(undefined, { explore: false }).map((x) => x.name);
  return { seed, ranked, ao, ce, recovered: afterRecover.includes('AllOrigins') };
});
check('ranker: a fresh browser gets the seed order (AllOrigins first)', rk.seed[0] === 'AllOrigins' && rk.seed.length === 10, JSON.stringify(rk.seed.slice(0, 3)));
check('ranker: a proxy that just succeeded is tried first', rk.ranked[0] === 'cors.eu.org', rk.ranked[0]);
check('ranker: a repeatedly-failing proxy is dropped (circuit open)', !rk.ranked.includes('AllOrigins'), JSON.stringify(rk.ranked.slice(0, 3)));
check('snapshot: failing proxy shows tries=3, ok%=0, cooling', rk.ao && rk.ao.tries === 3 && rk.ao.okPct === 0 && rk.ao.cooling === true, JSON.stringify(rk.ao));
check('snapshot: succeeding proxy shows tries=1, ok%=100', rk.ce && rk.ce.tries === 1 && rk.ce.okPct === 100, JSON.stringify(rk.ce));
check('ranker: a recovered proxy re-enters the chain', rk.recovered === true);

// ---- 4) health persists across a reload (per-browser learning survives) ----
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__hnlens && window.__hnlens.proxy, null, { timeout: 20000 });
const persisted = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  return p.rankProxies(undefined, { explore: false }).map((x) => x.name)[0];
});
check('ranker: learned health persists across reload (cors.eu.org still top)', persisted === 'cors.eu.org', persisted);

// ---- 5) regression guards for the independent-review findings ----
// H1: when every circuit is open, a non-exploring rank must still surface a recovery probe.
const allCooled = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  p.resetProxyHealth();
  const names = p.rankProxies(undefined, { explore: false }).map((x) => x.name);
  for (const n of names) for (let i = 0; i < 3; i++) p.recordOutcome(n, { ok: false }); // trip every circuit
  let empty = 0;
  for (let i = 0; i < 50; i++) if (p.rankProxies(undefined, { explore: false }).length === 0) empty++;
  return { empty };
});
check('ranker: all circuits open still yields a recovery probe, never an empty chain', allCooled.empty === 0, `${allCooled.empty}/50 empty`);

// M1: explore:true FORCES the probe on (symmetric with explore:false forcing it off).
const forceProbe = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  p.resetProxyHealth();
  for (let i = 0; i < 3; i++) p.recordOutcome('AllOrigins', { ok: false }); // cool ONLY AllOrigins
  let withProbe = 0;
  for (let i = 0; i < 50; i++) if (p.rankProxies(undefined, { explore: true }).some((x) => x.name === 'AllOrigins')) withProbe++;
  const withoutProbe = p.rankProxies(undefined, { explore: false }).some((x) => x.name === 'AllOrigins');
  return { withProbe, withoutProbe };
});
check('ranker: explore:true forces a probe every call (includes the cooled proxy)', forceProbe.withProbe === 50, `${forceProbe.withProbe}/50`);
check('ranker: explore:false still excludes a cooled proxy (opposite case)', forceProbe.withoutProbe === false);

// Blocker detection is precision-over-recall: a fingerprint marks a blocker ONLY when the page has no
// usable article text (`textLen < minText`). 4a HARD GUARANTEE — a real article (usable text) is NEVER
// proxy-error, even when it DISCUSSES bot-walls (the perennial HN anti-bot / 403 / a11y / vendor genre),
// so it can't poison proxy health. 4b — a real SHORT challenge page (fingerprint + no content) IS
// proxy-error. A full-length text-only blocker is served as contained `thin` (kept out of ranking +
// summaries — see the ranking residual guard in articleproxytest), not proxy-error.
const blocker = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  const prose = 'This long article explains how these systems actually work, with plenty of ordinary sentences and stopwords so it reads as genuine prose about the subject at hand and clears the usable-text floor comfortably. '.repeat(6);
  const pad = `<script>${'a'.repeat(400)}</script>`; // pushes rawLen>300 so challenges test the blocked path, not the tiny-page path
  const legit = (title, body) => p.scoreContent(`<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${prose} ${body}</p></article></body></html>`, `${prose} ${body}`, { title });
  const legitCases = {
    antibot: legit('Reverse-engineering DataDome and PerimeterX', 'We poke at datadome, perimeterx, hcaptcha.com, google.com/recaptcha and captcha-delivery.com behaviour.'),
    fix403: legit('How to fix 403 Forbidden', 'The server said you do not have permission to access this resource; here is the real cause.'),
    cfExplainer: legit('What Cloudflare checking your browser does', 'The interstitial says attention required and checking your browser before proceeding.'),
    moderation: legit('Moderation and appeals in practice', 'Users report seeing you have been blocked with no explanation or recourse.'),
    a11y: legit('An accessibility audit', 'Screen-reader users said you are unable to access the settings dialog at all.'),
    recaptcha: legit('A practical guide to reCAPTCHA', 'Integrating /recaptcha/ widgets and please verify you are a human flows cleanly.'),
    incapsula: legit('Imperva Incapsula WAF review', 'The request unsuccessful. Incapsula _incapsula_ marker shows on a block.'),
    titleCaptcha: legit('How CAPTCHAs Work', 'A survey of captcha designs over the years.'),
  };
  const challenges = {
    cf: p.scoreContent(`<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue. ${pad}</body></html>`, 'Enable JavaScript and cookies to continue.'),
    perimeterx: p.scoreContent(`<html><head><title>Loading</title></head><body><div>Please verify you are a human by completing the action below. ${pad}</div></body></html>`, 'Please verify you are a human by completing the action below.'),
    cf403: p.scoreContent(`<html><head><title>example.com</title></head><body><h2>Sorry, you have been blocked</h2><p>You are unable to access example.com.</p>${pad}</body></html>`, 'Sorry, you have been blocked. You are unable to access example.com.'),
    akamai: p.scoreContent(`<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>You do not have permission to access this resource.</p>${pad}</body></html>`, 'You do not have permission to access this resource.'),
  };
  const m = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { a: v.attribution, ok: v.ok }]));
  return { legit: m(legitCases), challenges: m(challenges) };
});
for (const [k, v] of Object.entries(blocker.legit)) {
  check(`scorer 4a: legit article "${k}" (bot-wall vocab in prose) is NOT rejected`, v.a !== 'proxy-error' && v.ok === true, v.a);
}
for (const [k, v] of Object.entries(blocker.challenges)) {
  check(`scorer 4b: a short challenge page "${k}" (fingerprint + no content) ⇒ proxy-error`, v.a === 'proxy-error', v.a);
}

// M4: legit all-caps Latin is not mojibake; genuine double-encoded text still is.
const moji = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  const pt = 'SÃO PAULO CONSTRUÇÃO REGIÃO NÃO INFORMAÇÃO EDUCAÇÃO POPULAÇÃO ORGANIZAÇÃO '.repeat(20);
  const legit = p.scoreContent(`<html><body><article><p>${pt}</p></article></body></html>`, pt, { title: 'noticia brasil' });
  const enc = 'Ã©Ã¨Ã¡Ã£Ã§Ã Ã¼â€™'.repeat(60); // UTF-8 misread as latin-1
  const bad = p.scoreContent(enc, enc);
  return { legit: legit.attribution, enc: bad.attribution };
});
check('scorer: correctly-decoded all-caps Latin is not proxy-encoding', moji.legit !== 'proxy-encoding', moji.legit);
check('scorer: genuine double-encoded text is still proxy-encoding (opposite case)', moji.enc === 'proxy-encoding', moji.enc);

// M2: correctly-decoded non-Latin prose can reach clean; an English keyword dump still ⇒ thin.
const lang = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  const jp = 'これは日本語で書かれた本格的な記事の本文です。文章は十分に長く、実際の段落として読める内容があります。詳細な説明と具体例を含みます。'.repeat(8);
  const cjk = p.scoreContent(`<html><body><article><p>${jp}</p></article></body></html>`, jp, { title: '日本語の記事' });
  const cjkEnTitle = p.scoreContent(`<html><body><article><p>${jp}</p></article></body></html>`, jp, { title: 'A deep dive into Japanese typography and layout' });
  const dump = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau '.repeat(8);
  const eng = p.scoreContent(`<html><body>${'x'.repeat(500)}${dump}</body></html>`, dump, { title: 'greek letters list' });
  return { cjk: cjk.attribution, cjkEnTitle: cjkEnTitle.attribution, eng: eng.attribution };
});
check('scorer: correctly-decoded CJK prose can reach clean (not forced thin)', lang.cjk === 'clean', lang.cjk);
check('scorer: CJK prose with a diverging ENGLISH title still reaches clean (not thin on overlap)', lang.cjkEnTitle === 'clean', lang.cjkEnTitle);
check('scorer: an English low-stopword keyword dump still ⇒ thin (opposite case)', lang.eng === 'thin', lang.eng);

// L2: a future timestamp (clock skew / corrupt store) must not INFLATE decayed counts.
const skew = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  p.resetProxyHealth();
  const future = Date.now() + 10 * 24 * 3600 * 1000;
  p.recordOutcome('codetabs', { ok: true, ms: 100, quality: 0.9 }, future);
  p.recordOutcome('codetabs', { ok: true, ms: 100, quality: 0.9 });
  const snap = p.proxyHealthSnapshot().find((s) => s.name === 'codetabs');
  return { tries: snap.tries };
});
check('ranker: a future timestamp does not inflate counts (decay clamped ≤1)', skew.tries === 2, `tries=${skew.tries}`);

// M6: the diagnostics snapshot reports the DECAYED view the ranker uses, not lifetime counts.
const decaySnap = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  p.resetProxyHealth();
  const old = Date.now() - 9 * 24 * 3600 * 1000; // ~3 half-lives ago
  for (let i = 0; i < 6; i++) p.recordOutcome('cors.lol', { ok: true, ms: 200, quality: 0.9 }, old);
  for (let i = 0; i < 4; i++) p.recordOutcome('cors.lol', { ok: false }, old);
  const snap = p.proxyHealthSnapshot().find((s) => s.name === 'cors.lol');
  return { tries: snap.tries };
});
check('snapshot: reports decayed counts (10 lifetime, 3 half-lives old ⇒ <3)', decaySnap.tries < 3, `tries=${decaySnap.tries}`);

// MEDIUM-2: a decayed old outage must not re-trip the max cooldown on one fresh fail; a RECENT outage still cools.
const streakRecovery = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  p.resetProxyHealth();
  const old = Date.now() - 25 * 24 * 3600 * 1000; // 25 days ago (>> half-life) — evidence long decayed
  for (let i = 0; i < 8; i++) p.recordOutcome('cors.workers.dev', { ok: false }, old);
  p.recordOutcome('cors.workers.dev', { ok: false }); // ONE fresh failure now
  const oldOutage = p.proxyHealthSnapshot().find((s) => s.name === 'cors.workers.dev').cooling;
  for (let i = 0; i < 3; i++) p.recordOutcome('cors.lol', { ok: false }); // recent 3-fail outage
  const recentOutage = p.proxyHealthSnapshot().find((s) => s.name === 'cors.lol').cooling;
  return { oldOutage, recentOutage };
});
check('ranker: a decayed old outage + one fresh fail does NOT re-trip cooldown', streakRecovery.oldOutage === false, `cooling=${streakRecovery.oldOutage}`);
check('ranker: a RECENT 3-fail outage still cools (opposite case)', streakRecovery.recentOutage === true, `cooling=${streakRecovery.recentOutage}`);

// LOW-1/MEDIUM-1: a corrupt health store must not throw — neither a top-level primitive NOR a
// per-proxy entry that is a primitive (valid JSON object, non-object value).
const corrupt = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  const check1 = (store) => {
    localStorage.setItem('hn:proxyhealth', store);
    try { p.recordOutcome('AllOrigins', { ok: true, ms: 100, quality: 0.9 }); return false; } catch { return true; }
  };
  const topLevel = check1('123'); // top-level non-object
  const nestedString = check1('{"AllOrigins":"corrupted"}'); // per-entry string (same proxy we record)
  const nestedNumber = check1('{"AllOrigins":5}'); // per-entry number (same proxy we record)
  const ranked = p.rankProxies(undefined, { explore: false }).length;
  p.resetProxyHealth();
  return { topLevel, nestedString, nestedNumber, ranked };
});
check('robust: a top-level non-object health store does not throw', corrupt.topLevel === false);
check('robust: a per-proxy non-object entry (string/number) does not throw', corrupt.nestedString === false && corrupt.nestedNumber === false, `str=${corrupt.nestedString} num=${corrupt.nestedNumber}`);
check('robust: ranking still works after a corrupt store', corrupt.ranked > 0);

// LOW-1: a per-proxy entry that is an object MISSING numeric fields ({}) must not score NaN and
// displace the empirically-best proxy from the top of the chain.
const nanEntry = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  p.resetProxyHealth();
  for (let i = 0; i < 10; i++) p.recordOutcome('cors.eu.org', { ok: true, ms: 200, quality: 0.95 }); // make it clearly best
  const m = JSON.parse(localStorage.getItem('hn:proxyhealth'));
  m['AllOrigins'] = {}; // corrupt: object missing numeric fields, at seed index 0
  localStorage.setItem('hn:proxyhealth', JSON.stringify(m));
  const top = p.rankProxies(undefined, { explore: false })[0].name;
  p.resetProxyHealth();
  return { top };
});
check('ranker: a malformed (NaN) per-proxy entry does not displace the best proxy from #0', nanEntry.top === 'cors.eu.org', `top=${nanEntry.top}`);

// LOW-2: the tiny-page (rawLen<300) proxy-error trigger requires NO usable text too, so a small page
// that still yields usable article text is never a false rejection; a truly tiny page still is.
const smallRaw = await page.evaluate(async () => {
  const p = await window.__hnlens.proxy();
  const body = 'This short note nonetheless clears the usable-text floor. '.repeat(4); // ~228 chars ≥ minText
  const usable = p.scoreContent(`<p>${body}</p>`, body); // rawLen ~235 (<300) but textLen ≥ 200
  const tinyErr = p.scoreContent('<html></html>', 'x');
  return { usable: usable.attribution, usableOk: usable.ok, tinyErr: tinyErr.attribution };
});
check('scorer: a small-raw page with USABLE text is not proxy-error', smallRaw.usable !== 'proxy-error' && smallRaw.usableOk === true, smallRaw.usable);
check('scorer: a truly tiny page (no usable text) is still proxy-error (opposite case)', smallRaw.tinyErr === 'proxy-error', smallRaw.tinyErr);

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: PROXY LAYER PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
