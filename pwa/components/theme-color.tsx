'use client';

import { useEffect } from 'react';
import { useTheme } from 'next-themes';

/** The phone's status bar wears the current world: theme-color follows the
 *  live --oz-bg token (tokens.css stays the only place a color is written). */
export function ThemeColor() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--oz-bg').trim();
    if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  }, [resolvedTheme]);
  return null;
}
