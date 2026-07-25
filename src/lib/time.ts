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
  // Go DIRECT to faviconV2 rather than via the s2/favicons alias.
  //
  // This used to route through s2 on the stated grounds that "s2 serves a default icon (200)"
  // whereas faviconV2 404s, making the redirect the lesser evil. That premise was simply false, and
  // measuring it is what showed so: s2 301-redirects EVERY domain to this same faviconV2 endpoint
  // and then returns whatever it returns — `example.com` is a 404 through both paths. So the app was
  // paying for the redirect and getting the 404s anyway. Favicons were 40% of the requests on a
  // default feed page, half of them pure redirect overhead, repeated on every Load-more.
  //
  // Going direct removes one request per domain and changes nothing else: a domain with no known
  // favicon still 404s, and `Favicon.tsx` already handles that by falling back to a letter monogram
  // via onError. (This endpoint is exactly where s2 was sending us, so it is no less official than
  // before — but it is an undocumented Google endpoint either way, which is precisely why the
  // feature is behind the `remoteFavicons` privacy toggle and degrades to monograms when it fails.)
  const target = encodeURIComponent(`https://${domain}`);
  return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${target}&size=${size}`;
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
