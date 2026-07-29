/**
 * The Hacker Lens mark — a stack of news items with the one the local model surfaced highlighted,
 * and a punched-out "spark" for the on-device processing node.
 *
 * WHY IT IS DRAWN FROM SEMANTIC TOKENS. The design brief supplied a per-theme table of `--logo-*`
 * colours. Hand-maintaining that table would mean 31 designs x 2 modes = 62 triples kept in sync by
 * memory — precisely the stale-hand-list shape that has caused defects here before, where adding a
 * 32nd design would silently inherit the wrong palette. Instead the mark inherits the tokens the
 * rest of the app already uses, so every existing and future design is covered for free AND the
 * mark inherits the contrast normalisation those tokens are guaranteed to satisfy. That guarantee is
 * on the TOKEN, not on the painted mark: the thin tiers rasterise at partial coverage below ~32px
 * and measure lower than the token's own ratio.
 *
 * `--logo-muted` / `--logo-secondary` / `--logo-accent` still exist as the brief specified: they are
 * declared in `index.css` as aliases of `--edge` / `--muted` / `--accent`, so a designer can still
 * override the mark for one theme without touching this component. The faintest tier is `--edge`
 * (the >=3:1 non-text token) and NOT `--border`, which is a deliberately sub-3:1 decorative
 * hairline — aliasing to that made the guarantee claimed above untrue for exactly the tier most
 * likely to disappear.
 *
 * The spark is painted with `--bg` rather than a hard-coded dark, so the punch-out reads as a hole
 * in every mode instead of a dark dot on a light header.
 */
export default function Logo({ className = 'size-6' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      /* Cropped to the mark's own bounds (x 96-416, y 136-392) with a little breathing room. The
         static app-icon keeps the full 512 square because a launcher icon needs its own padding,
         but inline at 24px that padding left the mark drawing at ~15x12px inside its box. */
      viewBox="80 120 352 288"
      className={className}
      role="img"
      aria-label="Hacker Lens"
    >
      <rect x="180" y="136" width="152" height="16" rx="8" fill="var(--logo-muted)" />
      <rect x="180" y="376" width="152" height="16" rx="8" fill="var(--logo-muted)" />
      <rect x="150" y="184" width="212" height="24" rx="12" fill="var(--logo-secondary)" />
      <rect x="150" y="328" width="212" height="24" rx="12" fill="var(--logo-secondary)" />
      <rect x="96" y="240" width="320" height="56" rx="28" fill="var(--logo-accent)" />
      <circle cx="136" cy="268" r="12" fill="var(--bg)" />
    </svg>
  );
}
