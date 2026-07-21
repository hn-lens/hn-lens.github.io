// HN Lens has TWO design axes, both user-switchable and independent:
//
//   1. DESIGN (palette + typography + corner radius + surface treatment) — the
//      `themeName` pref → data-theme="<id>" on <html>. 31 designs; the default
//      'reader' lives in :root/.dark, the rest in [data-theme='<id>'] blocks.
//
//   2. LAYOUT (structure — how cards/feed/nav are arranged) — the `layout` pref →
//      data-layout="<id>" on <html>. 14 genuinely different layouts (see index.css
//      [data-layout='<id>'] blocks). The special pref value 'auto' means "use this
//      design's default layout" (each design below names one), so switching design
//      also changes structure — but you can pin any layout to override.

export type LayoutId =
  | 'cards'
  | 'list'
  | 'compact'
  | 'magazine'
  | 'zen'
  | 'rail'
  | 'grid'
  | 'timeline'
  | 'media'
  | 'newspaper'
  | 'cover'
  | 'bento'
  | 'feature'
  | 'masonry';

export interface ThemeDef {
  id: string;
  label: string;
  defaultLayout: LayoutId; // used when the layout pref is 'auto'
}

export const THEMES: ThemeDef[] = [
  { id: 'reader', label: 'Reader — calm & quiet (default)', defaultLayout: 'cards' },
  { id: 'paper', label: 'Paper — newspaper serif', defaultLayout: 'zen' },
  { id: 'terminal', label: 'Terminal — monospace green', defaultLayout: 'compact' },
  { id: 'brutalist', label: 'Brutalist — hard edges', defaultLayout: 'list' },
  { id: 'soft', label: 'Soft — rounded pastel', defaultLayout: 'cards' },
  { id: 'solarized', label: 'Solarized — classic', defaultLayout: 'cards' },
  { id: 'nord', label: 'Nord — arctic frost', defaultLayout: 'magazine' },
  { id: 'gruvbox', label: 'Gruvbox — retro warm', defaultLayout: 'list' },
  { id: 'dracula', label: 'Dracula — purple night', defaultLayout: 'cards' },
  { id: 'sepia', label: 'Sepia — warm reader', defaultLayout: 'zen' },
  { id: 'ocean', label: 'Ocean — deep teal', defaultLayout: 'magazine' },
  { id: 'forest', label: 'Forest — mossy green', defaultLayout: 'cards' },
  { id: 'sunset', label: 'Sunset — warm coral', defaultLayout: 'magazine' },
  { id: 'rose', label: 'Rose — blossom pink', defaultLayout: 'cards' },
  { id: 'mono', label: 'Mono — grayscale', defaultLayout: 'list' },
  { id: 'contrast', label: 'High contrast — bold', defaultLayout: 'list' },
  { id: 'cyber', label: 'Cyberpunk — neon', defaultLayout: 'compact' },
  { id: 'mocha', label: 'Mocha — catppuccin', defaultLayout: 'cards' },
  { id: 'slate', label: 'Slate — corporate', defaultLayout: 'rail' },
  { id: 'candy', label: 'Candy — playful pills', defaultLayout: 'magazine' },
  // ── 5 more designs, each showcasing one of the 5 new layouts ──
  { id: 'amber', label: 'Amber — honey & gold', defaultLayout: 'media' },
  { id: 'crimson', label: 'Crimson — bold ruby red', defaultLayout: 'cover' },
  { id: 'emerald', label: 'Emerald — jewel green', defaultLayout: 'grid' },
  { id: 'royal', label: 'Royal — blue & gold', defaultLayout: 'newspaper' },
  { id: 'obsidian', label: 'Obsidian — OLED black & lime', defaultLayout: 'timeline' },
  // ── 6 research-backed design languages (palette + corners + font + surface treatment) ──
  { id: 'geist', label: 'Geist — engineering precision', defaultLayout: 'list' },
  { id: 'linear', label: 'Linear — dark glass', defaultLayout: 'cards' },
  { id: 'bento', label: 'Bento — modular tiles', defaultLayout: 'bento' },
  { id: 'editorial', label: 'Editorial — magazine serif', defaultLayout: 'feature' },
  { id: 'clay', label: 'Claymorphism — soft 3D', defaultLayout: 'masonry' },
  { id: 'swiss', label: 'Swiss — typographic grid', defaultLayout: 'newspaper' },
];

export const THEME_IDS: string[] = THEMES.map((t) => t.id);
export const DEFAULT_THEME_ID = 'reader';

// Layout picker options. 'auto' follows the chosen design's defaultLayout.
export const LAYOUTS: Array<{ id: string; label: string }> = [
  { id: 'auto', label: 'Auto (match theme design)' },
  { id: 'cards', label: 'Comfortable cards' },
  { id: 'list', label: 'Classic list (dense, numbered)' },
  { id: 'compact', label: 'Compact rows (single line)' },
  { id: 'magazine', label: 'Magazine grid (+ hero)' },
  { id: 'zen', label: 'Zen reader (wide, no sidebar)' },
  { id: 'rail', label: 'Left-rail navigation' },
  { id: 'grid', label: 'Grid tiles (3-column)' },
  { id: 'timeline', label: 'Timeline (spine + dots)' },
  { id: 'media', label: 'Media rows (large)' },
  { id: 'newspaper', label: 'Newspaper columns (flow)' },
  { id: 'cover', label: 'Cover bands (bold)' },
  { id: 'bento', label: 'Bento (mixed-size tiles)' },
  { id: 'feature', label: 'Feature (hero + list)' },
  { id: 'masonry', label: 'Masonry (staggered columns)' },
];

export const LAYOUT_IDS: LayoutId[] = [
  'cards',
  'list',
  'compact',
  'magazine',
  'zen',
  'rail',
  'grid',
  'timeline',
  'media',
  'newspaper',
  'cover',
  'bento',
  'feature',
  'masonry',
];
export const DEFAULT_LAYOUT_PREF = 'auto';

export function isValidThemeId(id: string): boolean {
  return THEME_IDS.includes(id);
}

// A layout PREF is valid if it's a concrete layout OR the 'auto' sentinel.
export function isValidLayoutPref(id: string): boolean {
  return id === 'auto' || (LAYOUT_IDS as string[]).includes(id);
}

// Resolve the concrete layout to render, given the layout pref + current design.
// 'auto' (or anything invalid) falls back to the design's default layout.
export function effectiveLayout(themeName: string, layoutPref: string): LayoutId {
  if (layoutPref !== 'auto' && (LAYOUT_IDS as string[]).includes(layoutPref)) {
    return layoutPref as LayoutId;
  }
  const t = THEMES.find((x) => x.id === themeName);
  return t ? t.defaultLayout : 'cards';
}
