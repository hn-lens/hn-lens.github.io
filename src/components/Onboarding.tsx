import { useState } from 'react';
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

export default function Onboarding() {
  const hasOnboarded = usePrefs((s) => s.hasOnboarded);
  const existingBoost = usePrefs((s) => s.keywordsBoost);
  const set = usePrefs((s) => s.set);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (hasOnboarded) return null;
  // Don't interrupt automated runs — they represent returning users and shouldn't get
  // a first-run modal over every test. The onboarding harness opts in explicitly.
  const forced = typeof localStorage !== 'undefined' && localStorage.getItem('hn:onboard') === 'force';
  if (!forced && typeof navigator !== 'undefined' && navigator.webdriver) return null;

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
      aria-label="Welcome to HN Lens — pick your interests"
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-border bg-surface p-5 shadow-2xl sm:rounded-2xl">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles className="size-5 text-accent" /> Welcome to HN Lens
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
                    : 'border-border bg-surface text-muted hover:text-fg')
                }
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
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
