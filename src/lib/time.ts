export function timeAgo(unixSeconds?: number): string {
  if (!unixSeconds) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export function hoursSince(unixSeconds?: number): number {
  if (!unixSeconds) return Infinity;
  return (Date.now() / 1000 - unixSeconds) / 3600;
}

export function domainOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function faviconUrl(domain: string, size = 32): string {
  if (!domain) return '';
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

/** Only allow http(s) links as hrefs (guards against javascript:/data: URLs). */
export function safeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const p = new URL(url);
    return p.protocol === 'http:' || p.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
