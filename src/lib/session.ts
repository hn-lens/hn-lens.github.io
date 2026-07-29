/**
 * WHAT A SESSION IS. One definition, and everything about "where was I" derives from it.
 *
 *   A session is one continuous sitting with the app in one tab.
 *   Your POSITION in a feed — the pinned order and the paging depth — STARTS fresh when you open a
 *   new tab or press Refresh, and CONTINUES across everything else, INCLUDING a reload: reading a
 *   story, opening a discussion, switching feed tab, and reloading all keep you exactly where you were.
 *
 * Reloading is the important one for POSITION. A reload used to also discard the pinned order and
 * reset paging depth, treating it as "the reader asking for a fresh start". But people reload for
 * reasons that have nothing to do with wanting a new list — a flaky network, a stale tab, muscle
 * memory — so a reload keeping the pinned order + paging is what stops "I read an item, came back,
 * and everything had moved". Only a new tab or an explicit Refresh re-ranks and re-pages.
 *
 * ONE exception, deliberately (design #4, see lib/readSweep.ts): the read SWEEP (which already-read
 * stories For You hides) IS recomputed on every fresh load INCLUDING a reload, so arriving fresh
 * shows fresh stories. That is safe here where the old per-load snapshot was not, because it is
 * announced + reversible, lands at the top, and keeps the pinned order + paging (see readSweep.ts).
 * So a reload keeps your PLACE but refreshes which read items are hidden.
 *
 * The sweep changes at exactly three boundaries: a browser RELOAD, opening a NEW TAB (both are fresh
 * document loads that re-run the seed in main.tsx), and the explicit Refresh BUTTON. It is NEVER
 * recomputed on in-app navigation — the home icon, a feed-tab switch, or opening/closing a
 * discussion — because those CONTINUE the session (main.tsx does not re-run and nothing re-seeds).
 * Guarded by scripts/sessionsweeptest.mjs.
 *
 * WHY `sessionStorage` IS THE PRIMITIVE. It already has exactly these semantics: scoped to one tab,
 * survives a reload, absent in a new tab. Every piece of "where I was" state therefore lives in it
 * rather than in module scope (which a reload destroys) or localStorage (which a new tab inherits).
 */

/** Every session-scoped key. */
export const SESSION_KEYS = ['hn:pinnedOrder', 'hn:depth', 'hn:readSweep', 'hn:readSweep:prev', 'hn:hiddenStubs'] as const;

export function readSession<T>(key: (typeof SESSION_KEYS)[number], fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeSession(key: (typeof SESSION_KEYS)[number], value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or quota — losing position is a degraded experience, never an error */
  }
}

export function dropSession(key: (typeof SESSION_KEYS)[number]): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

