import { useState, useRef} from 'react';
import { Sparkles } from 'lucide-react';
import { usePrefs } from '../lib/prefs';

// Each interest maps to a few word-boundary boost keywords the ranker already
// understands (keywordsBoost). Picking interests seeds a personalized For You feed
// on first run instead of generic popularity.
const TOPICS: Array<{ label: string; keywords: string[] }> = [
  { label: 'AI / ML', keywords: ['ai', 'llm', 'ml'] },
  { label: 'Rust', keywords: ['rust'] },
  { label: 'Python', keywords: ['python'] },
  { label: 'Web / JS', keywords: ['javascript', 'react', 'web'] },
  { label: 'Startups', keywords: ['startup', 'yc'] },
  { label: 'Security', keywords: ['security', 'exploit'] },
  { label: 'Databases', keywords: ['database', 'sql'] },
  { label: 'Systems / Infra', keywords: ['kubernetes', 'linux'] },
  { label: 'Devtools', keywords: ['cli', 'compiler'] },
  { label: 'Science', keywords: ['science', 'research'] },
  { label: 'Hardware', keywords: ['hardware', 'chip'] },
  { label: 'Crypto', keywords: ['crypto', 'bitcoin'] },
];

import { useModalBehavior } from '../hooks/useModalBehavior';

export default function Onboarding() {
  const dialogRef = useRef<HTMLDivElement>(null);
  const hasOnboarded = usePrefs((s) => s.hasOnboarded);
  const existingBoost = usePrefs((s) => s.keywordsBoost);
  const set = usePrefs((s) => s.set);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Don't interrupt automated runs — they represent returning users and shouldn't get
  // a first-run modal over every test. The onboarding harness opts in explicitly.
  const forced = typeof localStorage !== 'undefined' && localStorage.getItem('hn:onboard') === 'force';
  const suppressed = !forced && typeof navigator !== 'undefined' && navigator.webdriver;
  // ONE source of truth for "is this modal actually on screen": the hook's `active` flag must match
  // the FULL render condition, not just one clause of it — a partial flag locked page scroll while
  // the dialog was suppressed and never rendered.
  const open = !hasOnboarded && !suppressed;
  useModalBehavior(dialogRef, open);

  if (!open) return null;

  const toggle = (label: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  const finish = (apply: boolean) => {
    if (apply && selected.size) {
      const kws = new Set(existingBoost);
      for (const t of TOPICS) if (selected.has(t.label)) t.keywords.forEach((k) => kws.add(k));
      set({ keywordsBoost: [...kws], hasOnboarded: true, defaultFeed: 'foryou' });
    } else {
      set({ hasOnboarded: true });
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      ref={dialogRef}
      tabIndex={-1}
      aria-label="Welcome to Hacker Lens — pick your interests"
      // Escape and a backdrop tap both dismiss (= Skip). Without them, on a tiny screen with large
      // text the exits sit below the scroll fold with no other way out (useModalBehavior deliberately
      // leaves Escape to each dialog; this one bind it).
      onKeyDown={(e) => { if (e.key === 'Escape') finish(false); }}
      onClick={(e) => { if (e.target === e.currentTarget) finish(false); }}
    >
      <div className="max-h-[90vh] w-full min-w-0 max-w-md overflow-y-auto rounded-t-2xl border border-border bg-surface p-5 shadow-2xl sm:rounded-2xl">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles className="size-5 text-accent" /> Welcome to Hacker Lens
        </h2>
        <p className="mt-1.5 text-sm text-muted">
          Pick a few interests and your <span className="font-medium text-fg">For You</span> feed
          starts personalized — otherwise it&apos;s just generic popularity. Everything stays in your
          browser; change it anytime in Settings.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {TOPICS.map((t) => {
            const on = selected.has(t.label);
            return (
              <button
                key={t.label}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(t.label)}
                className={
                  'rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ' +
                  (on
                    ? 'border-transparent bg-accent text-accent-fg'
                    : 'border-edge bg-surface text-muted hover:text-fg')
                }
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* STICKY footer so the exits stay on screen even when the topic list overflows a short
            viewport (320x568 + Large text put both buttons below the fold). Bleeds to the panel edges
            over its p-5 padding; content scrolls under the top border. */}
        <div className="sticky bottom-0 -mx-5 -mb-5 mt-5 flex items-center justify-end gap-2 border-t border-border bg-surface px-5 py-3">
          <button
            type="button"
            onClick={() => finish(false)}
            className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-fg"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={() => finish(true)}
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            {selected.size ? `Start with ${selected.size} interest${selected.size > 1 ? 's' : ''}` : 'Get started'}
          </button>
        </div>
      </div>
    </div>
  );
}
