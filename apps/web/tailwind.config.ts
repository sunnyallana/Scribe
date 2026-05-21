import { uiPreset } from '@scribe/ui/tailwind-preset';

import type { Config } from 'tailwindcss';

const config: Config = {
  presets: [uiPreset as Config],
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
};

export default config;
