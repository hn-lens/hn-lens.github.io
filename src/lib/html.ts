import DOMPurify from 'dompurify';

// Ensure any links in HN-provided HTML open safely in a new tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof Element && node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

// Sanitising is PURE — the same input always yields the same output — but it parses the string with
// DOMParser every time, and comments re-render far more often than their text changes. Changing the
// comment sort on a large thread re-ran it once per rendered comment: 1,637 parses, a 300-381ms long
// task on a desktop and 1,200-1,461ms on a mid-range phone, to produce byte-identical HTML. The sort
// itself is 2.4ms; essentially all of the cost was re-sanitising unchanged text.
//
// A bounded LRU keyed on the raw string removes it. Bounded because a long thread can hold thousands
// of distinct bodies and this must not become an unbounded leak; insertion order gives cheap LRU
// eviction without a second structure.
//
// THE CAP MUST SIT ABOVE THE LARGEST REALISTIC THREAD, and 4000 did not.
//
// Rendering a thread is a CYCLIC scan over its comments, which is LRU's pathological case: once the
// working set exceeds the cap, every single lookup evicts the entry it is about to need next, so the
// hit rate does not degrade gracefully — it collapses. Measured in isolation: 4,000 distinct bodies
// gave a 100% hit rate at 0.6ms, and 4,100 gave 0% at 1,042ms. A 2.5% larger thread cost ~1,700x
// more. On a real 4,383-comment thread that was 12.8s to open on a throttled phone with a 10.2s
// blocking task — three to four times WORSE than the un-cached code this replaced, so the
// optimisation inverted past its own boundary.
//
// WHAT THE CAP ACTUALLY BUYS, stated precisely — an earlier version of this comment said 20,000
// cleared the largest thread "with an order of magnitude to spare", which is simply wrong: the
// largest threads are ~4-5k, so the margin is about 4x. It also reasoned only about a SINGLE
// thread, while the cache is per-page-load and CUMULATIVE across every thread opened in the tab —
// the quantity that has to stay under the cap is the whole session's working set, not one thread.
//
// The cliff cannot be engineered away by changing the eviction policy. Simulated over a cyclic scan
// at cap 20,000, hit rate for a working set 5% over the cap: LRU 0%, FIFO 0%, drop-oldest-half 0%.
// Recency ordering is exactly anti-correlated with what a re-render needs next, so every
// recency-based policy collapses together. Only refusing to insert once full degrades gracefully
// (hit rate = cap/working-set: 71% at 1.05x, 61% at 1.23x, 25% at 3x) — but that trades the cliff
// for permanently refusing to cache anything from a thread opened later in the session.
//
// LRU is kept because the dominant real pattern is NOT one oversized cyclic scan: it is a sequence
// of threads, where evicting the thread you navigated away from is the correct choice. What made
// the cliff reachable was the search index, which used to parse EVERY comment of EVERY thread on
// open (see CommentsView); it is now built only when someone actually searches, so an open costs
// roughly the comments the thread renders — measured at ~25% of a thread, or ~1,100 for the largest
// real one.
//
// The resulting budget: ~18 of the largest threads can be OPENED before the cap is reached.
// SEARCHING contributes nothing — the in-thread index is built with `searchText`, which never
// touches this cache — so only what is actually rendered counts. `sanitizeCacheStats()` exposes the
// live size, and a harness holds the open-path line so the eager-index regression cannot return.
//
// The memory ceiling is the real constraint and it is modest: entries are comment-sized strings, so
// a full cache is single-digit MB, and it is per-page-load.
const SANITIZE_CACHE = new Map<string, string>();
const SANITIZE_CACHE_MAX = 20000;
/** Longest input worth caching. Comfortably above any real HN comment, far below an article page. */
const MAX_CACHEABLE_CHARS = 20000;

export function sanitize(html?: string | null): string {
  if (!html) return '';
  const hit = SANITIZE_CACHE.get(html);
  if (hit !== undefined) {
    // Refresh recency so hot comments survive eviction on a very long thread.
    SANITIZE_CACHE.delete(html);
    SANITIZE_CACHE.set(html, hit);
    return hit;
  }
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  if (SANITIZE_CACHE.size >= SANITIZE_CACHE_MAX) {
    const oldest = SANITIZE_CACHE.keys().next().value;
    if (oldest !== undefined) SANITIZE_CACHE.delete(oldest);
  }
  // ONLY COMMENT-SIZED ENTRIES. The budget above is reasoned entirely in units of comments, and a
  // full cache is "single-digit MB" only if that holds — but every reader-proxy fetch also came
  // through here, storing a whole raw article page as the KEY and its sanitized copy as the VALUE.
  // At ~294KB a pair, twenty-five fetched articles blow the stated ceiling on their own while
  // occupying 25 of the 20,000 slots, so the count-based cap cannot see it. A page is fetched once
  // and already cached in IndexedDB by the article path, so nothing re-parses in a loop here.
  if (html.length <= MAX_CACHEABLE_CHARS) SANITIZE_CACHE.set(html, clean);
  return clean;
}

/**
 * How many distinct comment bodies have been sanitized this page-load, and the ceiling. Exposed for
 * the harnesses (via `window.__hnlens.html()`) as the observable for two properties that are
 * otherwise invisible from outside: that opening a discussion does NOT parse every comment in the
 * thread — only the ones actually rendered — and that a realistic session's working set stays under
 * the eviction cap. Both are costs a rendering-only test cannot see.
 */
export function sanitizeCacheStats(): { size: number; max: number } {
  return { size: SANITIZE_CACHE.size, max: SANITIZE_CACHE_MAX };
}

/**
 * Wrap bare http/https URLs in the VISIBLE TEXT of HTML with `<a>` links, WITHOUT touching
 * URLs that are already inside an `<a>` (so already-linked text isn't double-wrapped). HN
 * user `about` bios contain bare URLs with no anchor tags, so a profile's blog/GitHub/socials
 * render as un-clickable text; run this before `sanitize()` (which then keeps only http/https
 * hrefs and adds target/rel). Trailing sentence punctuation is kept out of the link.
 */
export function linkifyHtml(html?: string | null): string {
  if (!html) return '';
  const el = document.createElement('div');
  el.innerHTML = html;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('a')) continue; // already inside a link
    if (/https?:\/\//i.test(node.nodeValue || '')) targets.push(node as Text);
  }
  for (const t of targets) {
    const s = t.nodeValue || '';
    const frag = document.createDocumentFragment();
    const re = /https?:\/\/[^\s<>"')]+/gi;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      let url = m[0];
      // keep a trailing ) . , ; : ! ? out of the link
      const trail = url.match(/[.,;:!?)]+$/)?.[0] ?? '';
      if (trail) url = url.slice(0, url.length - trail.length);
      if (m.index > last) frag.append(s.slice(last, m.index));
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      frag.append(a);
      if (trail) frag.append(trail);
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.append(s.slice(last));
    t.parentNode?.replaceChild(frag, t);
  }
  return el.innerHTML;
}

/**
 * Wrap case-insensitive occurrences of `query` in <mark>, but ONLY within the visible text
 * of already-sanitized HTML — never inside a tag (so it can't corrupt an `<a href>` etc.).
 * Used to highlight in-thread comment-search matches. `query` is regex-escaped and the
 * wrapped text comes from the already-safe HTML (no user input is injected), so the result
 * stays safe to render. Pass an already-sanitized string.
 */
export function highlightHtml(safeHtml: string, query: string): string {
  const q = query.trim();
  if (!q || !safeHtml) return safeHtml;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc, 'gi');
  // Walks TEXT NODES rather than splitting the markup with a regex.
  //
  // Splitting on `<[^>]+>|[^<]+` separates tags from text, but ENTITIES live inside the text run:
  // searching "amp" against a comment containing `&amp;` matched the entity's own letters and
  // produced `&<mark>amp</mark>;`, which renders as the literal text "&amp;". Any query hitting
  // `amp`/`quot`/`gt`/`lt`/`#39` corrupted the comment it was supposed to help you find. In the DOM
  // an entity is already a single decoded character, so there is nothing to split; re-serialising
  // re-encodes it. Same technique as `linkifyHtml` above, for the same reason.
  const el = document.createElement('div');
  el.innerHTML = safeHtml;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('mark')) continue; // don't nest highlights
    if (re.test(node.nodeValue || '')) targets.push(node as Text);
    re.lastIndex = 0; // `g` flag: test() is stateful
  }
  for (const t of targets) {
    const text = t.nodeValue || '';
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++; // guard against a zero-length match looping forever
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    t.parentNode?.replaceChild(frag, t);
  }
  return el.innerHTML;
}

/**
 * A "link dump" = mostly bare URLs with little prose (a bare reference list, not a substantive
 * take). Used to DEMOTE such comments in the inline-top-comment pick AND the LLM-summary comment
 * selection, so a wall of links never beats a short insightful reply. Shared by both so the two
 * scorers can't drift apart. `text` should be plain-ish (stripped/cleaned) text.
 */
export function isLinkDump(text: string): boolean {
  const urls = text.match(/https?:\/\/\S+/gi) ?? [];
  const prose = text.replace(/https?:\/\/\S+/gi, '').trim();
  return urls.length >= 2 && prose.length < 60;
}

/**
 * Plain text for MATCHING, not for display. No DOM, no sanitizer: strips tags with a regex and
 * decodes the handful of entities HN emits. `stripHtml` costs a DOMPurify pass plus a full parse
 * and walk per comment — 3,760ms over 2,000 bodies against 110ms here — and none of that machinery
 * affects the result of a substring search. Output is never inserted into the page.
 */
export function searchText(html?: string | null): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#x27|#39|nbsp);/g, (_m, e) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", nbsp: ' ' })[e as string] ?? ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripHtml(html?: string | null): string {
  if (!html) return '';
  const el = document.createElement('div');
  // Through the CACHED sanitize, not DOMPurify directly — these two call sites bypassed the
  // memo entirely, which is why caching `sanitize` alone did not remove the re-parse cost.
  el.innerHTML = sanitize(html);
  // Insert a separator on BOTH sides of every block/line boundary before flattening, so no two
  // text runs mash. `textContent` alone turns `<p>a</p><p>b</p>` into "ab"; and because real HN
  // comments START with a bare text node (the first paragraph is NOT wrapped in `<p>`), APPENDING
  // only — which separates a block from what FOLLOWS it, never what PRECEDES it — left the common
  // "leading text<p>next" and "text<a>url</a>text" boundaries fused (seen live as
  // "…internet access.Least you can do" and "…window98-html-css-jshttps://github.com/…"). So we
  // insert at beforebegin AND afterend (sibling text nodes — valid on void `<br>` too), and list
  // the container tags (ul/ol/table/dl) so a bare "Reasons:<ul>…" boundary is separated as well.
  // Feeds comment previews, the thread gist, LLM input, embeddings, and the term profile.
  // Enumerating block tags means the list can be INCOMPLETE — and a partly-present family is the
  // trap: `tr`/`table`/`dl` were here but the CELL level (`td`/`th`) and the definition items
  // (`dt`/`dd`) were not, so real article tables and definition lists fused into junk
  // ("PriceFeatures$9Basic" instead of separated cells). That junk is user-visible in the reader
  // AND poisons the ranking term profile and the text sent to the LLM. Keep every level of each
  // family, not just its container.
  el.querySelectorAll(
    'p,div,li,br,a,blockquote,pre,tr,td,th,thead,tbody,tfoot,ul,ol,table,dl,dt,dd,figure,figcaption,details,summary,section,article,h1,h2,h3,h4,h5,h6'
  ).forEach((n) => {
    n.insertAdjacentText('beforebegin', ' ');
    n.insertAdjacentText('afterend', ' ');
  });
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract readable text from HTML while PRESERVING paragraph breaks (block
 * elements become blank-line-separated paragraphs). Used for the extracted-article
 * viewer so it renders as formatted prose, not one giant blob. Drops obvious
 * non-content (script/style/nav/header/footer/aside).
 */
export function htmlToText(html?: string | null): string {
  if (!html) return '';
  const el = document.createElement('div');
  // Through the CACHED sanitize, not DOMPurify directly — these two call sites bypassed the
  // memo entirely, which is why caching `sanitize` alone did not remove the re-parse cost.
  el.innerHTML = sanitize(html);
  el.querySelectorAll('script,style,nav,footer,header,aside,form,noscript').forEach((n) => n.remove());
  // Both-sides break insertion (see stripHtml) so a leading bare paragraph is split from the first
  // block too — HN "quote-then-respond" comments are a bare `&gt; quote` before the first `<p>`, and
  // append-only left them fused so a downstream per-line quote filter (ThreadGist) dropped the whole
  // comment. `<a>` is deliberately EXCLUDED so an inline link never splits a sentence into paragraphs.
  el.querySelectorAll(
    'p,div,li,section,article,tr,td,th,thead,tbody,tfoot,blockquote,pre,ul,ol,table,dl,dt,dd,figure,figcaption,details,summary,h1,h2,h3,h4,h5,h6,br'
  ).forEach((n) => {
    n.insertAdjacentText('beforebegin', '\n');
    n.insertAdjacentText('afterend', '\n');
  });
  return (el.textContent || '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Minimal, safe Markdown -> HTML for LLM output (bold, code, bullets, headings). */
/**
 * The ONE way to turn an HN comment's HTML into readable plain text for a preview/summary input.
 *
 * HN's dominant reply shape is quote-then-rebut (`> their claim` followed by the rebuttal), and a
 * naive `stripHtml` both collapses the newlines that delimit the quote AND keeps the quoted text —
 * so the quote fuses onto the reply and the preview attributes SOMEONE ELSE'S words to the replier,
 * often stating the exact opposite of their position. Three sites needed this and each grew its own
 * cleaner; two had the quote filter and the visible, default-on one did not. Factored here so they
 * cannot drift again.
 */
export function commentToText(html?: string | null): string {
  return htmlToText(html)
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mdLite(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    let line = esc(raw)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    // A NUMBERED line is deliberately left as a paragraph, so "1." reaches the reader as text.
    //
    // Converting `1. x` to `<ol><li>x</li></ol>` would DROP the ordinal: the digits live in the
    // markup's structure rather than its text, and the reader already sees them fine as text.
    // Bullets are different — `- x` carries no character worth keeping, so it becomes a real list,
    // and `.md-body` (index.css) restores the markers that Tailwind's preflight
    // `ol,ul,menu{list-style:none}` removes. That class is applied only where AI output is rendered,
    // never to plain `.hn-html`, which also renders every HN comment body.
    if (bullet) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${bullet[1]}</li>`;
      continue;
    }
    if (inList) {
      html += '</ul>';
      inList = false;
    }
    if (heading) {
      const lvl = Math.min(heading[1].length + 2, 6);
      html += `<h${lvl}>${heading[2]}</h${lvl}>`;
      continue;
    }
    if (line.trim() === '') continue;
    html += `<p>${line}</p>`;
  }
  if (inList) html += '</ul>';
  return sanitize(html);
}
