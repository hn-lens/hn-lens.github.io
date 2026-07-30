import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, TextareaHTMLAttributes } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

// A textarea that grows to fit its content (up to maxPx, then scrolls) so a multi-line value isn't
// clipped mid-word by a fixed-height box. `rows` is the minimum height.
export function AutoTextarea({
  value,
  maxPx = 460,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; maxPx?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
    el.style.overflowY = el.scrollHeight > maxPx ? 'auto' : 'hidden';
  }, [value, maxPx]);
  return <textarea ref={ref} value={value} {...rest} />;
}

export function Section({
  title,
  description,
  children,
  id,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  id?: string; // anchor id for the Settings table-of-contents / deep-links
}) {
  return (
    // scroll-mt keeps the section title clear of the sticky top nav when scrolled to.
    <section id={id} className="scroll-mt-20 rounded-xl border border-border bg-surface p-4 sm:p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

/**
 * The VISUAL of a switch (track + thumb) — presentational only, no button/role/handlers. Shared
 * by the Settings `Toggle` (below) AND the feed-header "Top comments" switch so both render one
 * consistent, legible recipe (before, they were two divergent hand-rolled switches — one invisible
 * OFF in light themes, one washed-out). Legible BY CONSTRUCTION across every theme×mode: an
 * always-visible `--edge` border (≥3:1), an OFF thumb in `--muted` (≥4.5:1 vs the track), and an ON
 * track of solid `--accent` with an `--accent-fg` thumb (the guaranteed text-on-accent color). The
 * thumb is vertically CENTERED (top-1/2 + -translate-y-1/2) so it can't sit low inside the border.
 */
export function SwitchVisual({ checked, size = 'md' }: { checked: boolean; size?: 'sm' | 'md' }) {
  const sm = size === 'sm';
  return (
    <span
      className={cn(
        'relative inline-block shrink-0 rounded-full border transition-colors',
        sm ? 'h-4 w-7' : 'h-6 w-11',
        checked ? 'border-accent bg-accent' : 'border-edge bg-surface-2'
      )}
    >
      <span
        className={cn(
          'absolute top-1/2 -translate-y-1/2 rounded-full shadow-sm transition-all',
          sm ? 'size-3' : 'size-5',
          checked
            ? cn(sm ? 'left-[14px]' : 'left-[22px]', 'bg-accent-fg')
            : 'left-0.5 bg-muted'
        )}
      />
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className="mt-0.5 shrink-0 rounded-full"
      >
        <SwitchVisual checked={checked} size="md" />
      </button>
    </label>
  );
}

export function Slider({
  label,
  value,
  min = 0,
  max = 2,
  step = 0.1,
  onChange,
  hint,
  inactive,
  decimals = 1,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  hint?: string;
  inactive?: boolean;
  // Decimal places for the value read-out. Defaults to 1 (right for the 0.0–2.0 ranking
  // weights); pass 0 for integer-valued sliders (e.g. Minimum points) so it doesn't show "0.0".
  decimals?: number;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className={cn('font-medium', inactive && 'text-subtle')}>{label}</span>
        <span className="tabular-nums text-muted">{value.toFixed(decimals)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="range-themed w-full accent-[var(--accent)]"
      />
      {hint && <p className="mt-0.5 text-xs text-subtle">{hint}</p>}
    </label>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TagEditor({
  label,
  values,
  onChange,
  placeholder,
  lowercase,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  lowercase?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    // Domains/keywords are case-insensitive; HN usernames are NOT — preserve case there.
    const v = lowercase === false ? draft.trim() : draft.trim().toLowerCase();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div>
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs"
          >
            {/* break a long domain/keyword tag so the chip can't overflow the page at 320px+Large */}
            <span className="min-w-0 [overflow-wrap:anywhere]">{v}</span>
            <button type="button" className="shrink-0" onClick={() => onChange(values.filter((x) => x !== v))}>
              <X className="size-3 text-subtle hover:text-fg" />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          aria-label={label}
          className="min-w-0 flex-1 rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={add}
          className="rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
        >
          Add
        </button>
      </div>
    </div>
  );
}
