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

export function stripHtml(html?: string | null): string {
  if (!html) return '';
  const el = document.createElement('div');
  el.innerHTML = DOMPurify.sanitize(html);
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
  el.querySelectorAll('p,div,li,section,article,tr,blockquote,h1,h2,h3,h4,h5,h6,br').forEach((n) => n.append('\n'));
  return (el.textContent || '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Minimal, safe Markdown -> HTML for LLM output (bold, code, bullets, headings). */
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
