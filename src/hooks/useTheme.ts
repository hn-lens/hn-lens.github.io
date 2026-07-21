import { usePrefs } from '../lib/prefs';

export function useTheme() {
  const theme = usePrefs((s) => s.theme);
  const toggle = usePrefs((s) => s.toggleTheme);
  const isDark = theme === 'dark';
  return { theme, isDark, toggle };
}
