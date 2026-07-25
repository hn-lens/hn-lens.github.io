import DOMPurify from 'dompurify';

// Ensure any links in HN-provided HTML open safely in a new tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof Element && node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

export function sanitize(html?: string | null): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
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
  const re = new RegExp(`(${esc})`, 'gi');
  // Split into tag vs text segments; only highlight the text segments.
  return safeHtml.replace(/<[^>]+>|[^<]+/g, (seg) => (seg.startsWith('<') ? seg : seg.replace(re, '<mark>$1</mark>')));
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

export function stripHtml(html?: string | null): string {
  if (!html) return '';
  const el = document.createElement('div');
  el.innerHTML = DOMPurify.sanitize(html);
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
    'p,div,li,br,a,blockquote,pre,tr,td,th,ul,ol,table,dl,dt,dd,section,article,h1,h2,h3,h4,h5,h6'
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
  el.innerHTML = DOMPurify.sanitize(html);
  el.querySelectorAll('script,style,nav,footer,header,aside,form,noscript').forEach((n) => n.remove());
  // Both-sides break insertion (see stripHtml) so a leading bare paragraph is split from the first
  // block too — HN "quote-then-respond" comments are a bare `&gt; quote` before the first `<p>`, and
  // append-only left them fused so a downstream per-line quote filter (ThreadGist) dropped the whole
  // comment. `<a>` is deliberately EXCLUDED so an inline link never splits a sentence into paragraphs.
  el.querySelectorAll(
    'p,div,li,section,article,tr,td,th,blockquote,pre,ul,ol,table,dl,dt,dd,h1,h2,h3,h4,h5,h6,br'
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
