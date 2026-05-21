export const themes = ['light', 'dark', 'high-contrast', 'system'] as const;
export type Theme = (typeof themes)[number];

export const radius = {
  sm: 'calc(var(--radius) - 4px)',
  md: 'calc(var(--radius) - 2px)',
  lg: 'var(--radius)',
} as const;

export const motion = {
  fast: '120ms',
  base: '200ms',
  slow: '320ms',
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;
