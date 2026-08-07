// Reader-proxy layer: fetch cross-site pages via free CORS proxies. Which proxy works is per-browser + a 200≠success, so the chain self-tunes + grades. See design/reader-proxy-quality.md.

export type ProxyKind = 'raw' | 'json';

export interface ReaderProxy {
  name: string;
  build: (url: string) => string;
  kind?: ProxyKind; // 'json' ⇒ page is a JSON envelope under `.contents`; default 'raw'
  maxBytes?: number; // hard response-size cap; skip targets expected to exceed it
}

// Seed order for a brand-new browser; the health store reorders per machine. All free + keyless.
export const PROXIES: ReaderProxy[] = [
  { name: 'AllOrigins', build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'cors.eu.org', build: (u) => `https://cors.eu.org/${u}` },
  { name: 'codetabs', build: (u) => `https://api.codetabs.com/v1/proxy/?quest=${u}` },
  { name: 'corsproxy.io', build: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
  { name: 'corsfix', build: (u) => `https://proxy.corsfix.com/?${u}` },
  { name: 'everyorigin', build: (u) => `https://everyorigin.org/get?url=${encodeURIComponent(u)}`, kind: 'json' },
  { name: 'AllOrigins-get', build: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, kind: 'json' },
  { name: 'cors.workers.dev', build: (u) => `https://test.cors.workers.dev/?${u}` },
  { name: 'cors.lol', build: (u) => `https://api.cors.lol/?url=${encodeURIComponent(u)}` },
  { name: 'thingproxy', build: (u) => `https://thingproxy.freeboard.io/fetch/${u}`, maxBytes: 100_000 },
];

export interface ProxyHealth {
  ok: number; // decayed success count
  fail: number; // decayed failure count
  emaMs: number; // EMA of success latency (0 = unknown)
  qualityEma: number; // EMA of content-quality score, 0..1 (0.5 = unknown)
  lastOkTs: number;
  lastTs: number; // last time this record was touched (for decay)
  streak: number; // consecutive failures (drives the circuit-breaker)
  cooldownUntil: number; // circuit open until this ts
}

const HEALTH_KEY = 'hn:proxyhealth';
const HALF_LIFE_MS = 3 * 24 * 3600 * 1000; // decay old counts so a past outage isn't permanent
const COOLDOWN_BASE_MS = 60_000; // circuit-breaker base backoff
const COOLDOWN_MAX_MS = 30 * 60_000;
const FAIL_STREAK_TRIP = 3; // consecutive fails before the circuit opens
const EXPLORE_P = 0.1; // ε: occasionally probe a cooled/low-ranked proxy to detect recovery
export const PROXY_TIMEOUT_MS = 8000; // per-attempt bound so a hung proxy can't stall the chain

type HealthMap = Record<string, ProxyHealth>;

function fresh(): ProxyHealth {
  return { ok: 0, fail: 0, emaMs: 0, qualityEma: 0.5, lastOkTs: 0, lastTs: 0, streak: 0, cooldownUntil: 0 };
}

function loadHealth(): HealthMap {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(HEALTH_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean: HealthMap = {};
    for (const [k, v] of Object.entries(parsed)) { const h = v as ProxyHealth; if (h && typeof h === 'object' && Number.isFinite(h.ok) && Number.isFinite(h.fail)) clean[k] = h; } // drop malformed entries (no NaN scores)
    return clean;
  } catch {
    return {};
  }
}

function saveHealth(m: HealthMap): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(HEALTH_KEY, JSON.stringify(m));
  } catch { /* best-effort: storage full/unavailable */ }
}

function decayed(h: ProxyHealth, now: number): ProxyHealth {
  if (!h.lastTs) return h;
  // Clamp to 1: a future lastTs (clock skew / corrupt store) must decay counts, never inflate them.
  const f = Math.min(1, Math.pow(0.5, (now - h.lastTs) / HALF_LIFE_MS));
  // ≥1 half-life idle ⇒ evidence neutral, so also clear streak/cooldown (an old outage must not re-trip max backoff on one fresh fail).
  const stale = f < 0.5;
  return { ...h, ok: h.ok * f, fail: h.fail * f, streak: stale ? 0 : h.streak, cooldownUntil: stale ? 0 : h.cooldownUntil };
}

// Laplace-smoothed `(ok+1)/(n+2)`: untried sits at 0.5, one success beats untried, cautious on small n.
function successRate(ok: number, n: number): number {
  return (ok + 1) / (n + 2);
}

export interface RecordOutcome {
  ok: boolean;
  ms?: number;
  quality?: number; // 0..1 from scoreContent (only meaningful on success)
}

export function recordOutcome(name: string, o: RecordOutcome, now = Date.now()): void {
  const m = loadHealth();
  const h = decayed(m[name] ?? fresh(), now);
  if (o.ok) {
    h.ok += 1;
    h.streak = 0;
    h.cooldownUntil = 0;
    h.lastOkTs = now;
    if (o.ms != null) h.emaMs = h.emaMs ? h.emaMs * 0.7 + o.ms * 0.3 : o.ms;
    if (o.quality != null) h.qualityEma = h.qualityEma * 0.7 + o.quality * 0.3;
  } else {
    h.fail += 1;
    h.streak += 1;
    if (h.streak >= FAIL_STREAK_TRIP) {
      const backoff = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * Math.pow(2, h.streak - FAIL_STREAK_TRIP));
      h.cooldownUntil = now + backoff;
    }
  }
  h.lastTs = now;
  m[name] = h;
  saveHealth(m);
}

function scoreProxy(h: ProxyHealth): number {
  const n = h.ok + h.fail;
  const reliability = successRate(h.ok, n); // 0..1
  const quality = h.qualityEma; // 0..1
  const latencyPenalty = h.emaMs ? Math.min(0.5, h.emaMs / 20000) : 0.1; // 0..0.5
  return 0.55 * reliability + 0.45 * quality - 0.4 * latencyPenalty;
}

export interface RankOpts {
  sizeHint?: number; // expected response size; skip proxies whose maxBytes is below it
  now?: number;
  explore?: boolean | number; // force/deny the ε-probe (tests); default ε=EXPLORE_P
}

// Order candidates best-first for THIS browser by health score; skip open circuits (unless an ε-probe fires) + over-cap proxies; a fresh browser gets seed order.
export function rankProxies(proxies: ReaderProxy[] = PROXIES, opts: RankOpts = {}): ReaderProxy[] {
  const now = opts.now ?? Date.now();
  const m = loadHealth();
  const p = typeof opts.explore === 'number' ? opts.explore : opts.explore === true ? 1 : opts.explore === false ? 0 : EXPLORE_P;
  const probing = Math.random() < p;
  const sized = proxies.filter((px) => !(opts.sizeHint != null && px.maxBytes != null && opts.sizeHint > px.maxBytes));
  const open = sized.filter((px) => { const h = m[px.name]; return !(h && h.cooldownUntil > now); });
  // Every circuit open: still surface candidates (best-scored first) as a recovery probe, never empty.
  const eligible = probing || open.length === 0 ? sized : open;
  const seedIdx = new Map(proxies.map((px, i) => [px.name, i] as const)); // seed order = stable tiebreak
  return eligible.sort((a, b) => {
    const sa = m[a.name] ? scoreProxy(decayed(m[a.name], now)) : scoreProxy(fresh());
    const sb = m[b.name] ? scoreProxy(decayed(m[b.name], now)) : scoreProxy(fresh());
    if (Math.abs(sa - sb) > 1e-9) return sb - sa;
    return (seedIdx.get(a.name) ?? 0) - (seedIdx.get(b.name) ?? 0);
  });
}

export interface ProxyStat {
  name: string;
  tries: number;
  okPct: number;
  avgMs: number;
  quality: number;
  cooling: boolean;
}

export function proxyHealthSnapshot(now = Date.now()): ProxyStat[] {
  const m = loadHealth();
  return PROXIES.map((px) => {
    const raw = m[px.name];
    const h = raw ? decayed(raw, now) : undefined; // report the same decayed view the ranker scores on
    const n = h ? h.ok + h.fail : 0;
    return {
      name: px.name,
      tries: Math.round(n),
      okPct: n > 0 ? Math.round((h!.ok / n) * 100) : 0,
      avgMs: h ? Math.round(h.emaMs) : 0,
      quality: h ? Math.round(h.qualityEma * 100) / 100 : 0,
      cooling: !!raw && raw.cooldownUntil > now,
    };
  });
}

export function resetProxyHealth(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(HEALTH_KEY);
  } catch { /* best-effort */ }
}

// Decode bytes with the page's REAL charset (Content-Type, else <meta>, else UTF-8) — else a non-UTF-8 page is replacement-char jibberish.
export function decodeBytes(buf: ArrayBuffer | Uint8Array, contentType?: string | null): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let charset = '';
  const fromHeader = contentType?.match(/charset=["']?([\w-]+)/i);
  if (fromHeader) charset = fromHeader[1];
  if (!charset) {
    let head = ''; // ASCII peek of the first 2KB to find a <meta charset> without a full decode
    for (let i = 0; i < Math.min(bytes.length, 2048); i++) head += String.fromCharCode(bytes[i]);
    const meta =
      head.match(/<meta[^>]+charset=["']?([\w-]+)/i) ||
      head.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i);
    if (meta) charset = meta[1];
  }
  // TextDecoder normalizes labels itself (case-insensitive, WHATWG label set), so pass the raw
  // trimmed label — do NOT strip separators (that turned `shift_jis` into the invalid `shiftjis`).
  try {
    return new TextDecoder(charset.trim() || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes); // unknown label ⇒ safe fallback
  }
}

export type ProxyAttribution =
  | 'clean'
  | 'thin' // valid HTML, extraction is short/boilerplate-ish but not clearly a source problem
  | 'proxy-error' // tiny / blocker / error page — bad bytes
  | 'proxy-encoding' // mojibake — charset mishandled
  | 'js-source' // body isn't in the HTML at all (JS-rendered / paywalled) — unrecoverable here
  | 'parser'; // body WAS in the HTML but our extraction missed it — fixable on our side

export interface ContentScore {
  quality: number; // 0..1
  attribution: ProxyAttribution;
  ok: boolean; // usable as content?
  signals: { rawLen: number; mojibake: number; blocked: boolean; textLen: number; stopword: number; overlap: number; proseInRaw: number };
}

// Unambiguous challenge/block fingerprints (boilerplate + vendor assets) — matched ANYWHERE, never generic words a legit article might use.
const BLOCKER =
  /cf-browser-verification|challenges\.cloudflare\.com|attention required! \| cloudflare|enable (java)?script and cookies|checking your browser before|verifying you are human|needs to review the security of your connection|error 1020|performance & security by cloudflare|you have been blocked|you are unable to access|ddos protection by|request unsuccessful\.? incapsula|_incapsula_|hcaptcha\.com|\/recaptcha\/|perimeterx|px-captcha|datadome|captcha-delivery\.com|you (do not|don'?t) have permission to access|permission to access this resource|please verify you are (a )?human/i;

/** Does already-extracted text read as a bot-wall / block page? Keeps such a body out of ranking. */
export function looksLikeBlocker(text: string): boolean {
  return BLOCKER.test(text);
}
const STOP = new Set(
  ('the a an and or but of to in on for with from by is are was were be been it its this that as at how why what when your you our we they i he she them their ' +
    'le la les de des du un une et est en que qui dans pour sur pas ne se ce il elle nous vous ' +
    'der die das und ist den von zu mit dem ein eine auf fur nicht sich auch als ' +
    'el los las del y por con para no su lo ' +
    'il lo di che per non si sono ' +
    'o os do da em nao').split(/\s+/)
);

function titleOverlap(title: string | undefined, text: string): number {
  if (!title) return 1;
  const words = (t: string) => (t.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []).filter((w) => !STOP.has(w));
  const tw = [...new Set(words(title))];
  if (tw.length < 3) return 1; // nothing distinctive to check against ⇒ don't penalise
  const body = new Set(words(text).slice(0, 4000));
  return tw.filter((w) => body.has(w)).length / tw.length;
}

function proseInRaw(raw: string): number {
  const ps = raw.match(/<p\b[^>]*>([\s\S]*?)<\/p>/gi) ?? [];
  let n = 0;
  for (const p of ps) n += p.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
  return n;
}

export interface ScoreOpts {
  title?: string;
  minText?: number; // floor below which extraction is "too short"
}

// Grade an extracted result and attribute a bad one: `raw` = charset-decoded HTML, `extracted` = its text.
export function scoreContent(raw: string, extracted: string, opts: ScoreOpts = {}): ContentScore {
  const minText = opts.minText ?? 200;
  const rawLen = raw.length;
  const text = extracted.replace(/\s+/g, ' ').trim();
  const textLen = text.length;
  const mojibake = rawLen ? ((raw.match(/\uFFFD/g)?.length ?? 0) + (raw.match(/[ÃÂ][\u0080-\u00BF]|â€/g)?.length ?? 0)) / rawLen : 0;
  // textLen gate: a fingerprint means a blocker only with no usable article, so a real article is NEVER false-rejected (a contentful blocker is contained downstream).
  const blocked = BLOCKER.test(raw.slice(0, 8000)) && textLen < minText;
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const stopword = words.length ? words.filter((w) => STOP.has(w)).length / words.length : 0;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const latinish = letters ? words.join('').length / letters > 0.6 : false; // stopword density is meaningful only for (mostly-)Latin text
  const overlap = titleOverlap(opts.title, text);
  const prose = proseInRaw(raw);
  const signals = { rawLen, mojibake, blocked, textLen, stopword, overlap, proseInRaw: prose };

  let attribution: ProxyAttribution;
  let quality: number;
  if ((rawLen < 300 && textLen < minText) || blocked) {
    attribution = 'proxy-error';
    quality = 0;
  } else if (mojibake > 0.02) {
    attribution = 'proxy-encoding';
    quality = 0;
  } else if (textLen < minText) {
    attribution = prose > 800 ? 'parser' : 'js-source';
    quality = prose > 800 ? 0.2 : 0.1;
  } else if (latinish && (stopword < 0.15 || overlap < 0.15)) {
    attribution = 'thin';
    quality = 0.4;
  } else {
    attribution = 'clean';
    quality = 0.6 + 0.2 * Math.min(1, textLen / 2000) + 0.2 * Math.min(1, overlap); // scale by real, on-topic prose
  }
  return { quality, attribution, ok: attribution === 'clean' || attribution === 'thin', signals };
}

function unwrapJson(body: string): string {
  try {
    const j = JSON.parse(body) as { contents?: unknown };
    return typeof j.contents === 'string' ? j.contents : '';
  } catch {
    return '';
  }
}

export interface ProxiedResult<T> {
  ok: boolean;
  value: T | null;
  proxy: string;
  quality: number;
  attribution: ProxyAttribution | null;
}

export interface ProxiedOpts<T> {
  validate: (html: string) => { ok: boolean; value: T; quality: number; attribution?: ProxyAttribution };
  sizeHint?: number;
  timeoutMs?: number;
  proxies?: ReaderProxy[];
}

// Fetch `url` through the health-ranked chain: the first proxy whose decoded body passes `validate`
// wins; every attempt (bounded by a timeout) updates that proxy's health so the chain self-tunes.
export async function proxiedFetch<T>(url: string, opts: ProxiedOpts<T>): Promise<ProxiedResult<T>> {
  const ranked = rankProxies(opts.proxies ?? PROXIES, { sizeHint: opts.sizeHint });
  const timeoutMs = opts.timeoutMs ?? PROXY_TIMEOUT_MS;
  for (const proxy of ranked) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(proxy.build(url), { headers: { Accept: 'text/html,text/plain' }, signal: ctrl.signal });
      if (!res.ok) {
        recordOutcome(proxy.name, { ok: false });
        continue;
      }
      let html = decodeBytes(await res.arrayBuffer(), res.headers.get('content-type'));
      if (proxy.kind === 'json') html = unwrapJson(html);
      const v = opts.validate(html);
      if (v.ok) {
        recordOutcome(proxy.name, { ok: true, ms: Date.now() - t0, quality: v.quality });
        return { ok: true, value: v.value, proxy: proxy.name, quality: v.quality, attribution: v.attribution ?? null };
      }
      recordOutcome(proxy.name, { ok: false }); // reachable but bad content — counts against the proxy
    } catch {
      recordOutcome(proxy.name, { ok: false }); // timeout / network / aborted
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, value: null, proxy: '', quality: 0, attribution: null };
}
