import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import ur from './locales/ur.json';

/**
 * Languages we ship a bundle for. `en` is the canonical source —
 * every other language's JSON file may be partial; missing keys
 * automatically fall back to `en` (see `fallbackLng` below).
 *
 * `dir: 'rtl'` triggers `<html dir="rtl">` and Tailwind's
 * logical-property classes (`ps-` / `pe-` / `ms-` / `me-`) flip
 * automatically. Languages without an explicit `dir` default to
 * left-to-right.
 */
export interface SupportedLanguage {
  readonly code: string;
  /** Endonym — the language's name in itself. Shown in the switcher. */
  readonly label: string;
  readonly dir: 'ltr' | 'rtl';
}

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'fr', label: 'Français', dir: 'ltr' },
  { code: 'es', label: 'Español', dir: 'ltr' },
  { code: 'de', label: 'Deutsch', dir: 'ltr' },
  { code: 'ur', label: 'اردو', dir: 'rtl' },
];

const LANG_STORAGE_KEY = 'scribe:lang';

/** Resolve the language to start with on first paint:
 *   1. Honoured `localStorage` choice if the user has picked one.
 *   2. Closest `navigator.language` match (e.g. `fr-CA` → `fr`).
 *   3. Fall back to English.
 *  Synchronous so the first render is already in the right
 *  language and direction. */
function resolveInitialLanguage(): string {
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = window.localStorage.getItem(LANG_STORAGE_KEY);
    if (stored !== null && SUPPORTED_LANGUAGES.some((l) => l.code === stored)) {
      return stored;
    }
  } catch {
    // localStorage might be blocked by the host (privacy mode,
    // third-party context). Just fall through to detection.
  }
  const nav = (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase();
  const base = nav.split('-')[0] ?? '';
  const hit = SUPPORTED_LANGUAGES.find((l) => l.code === base);
  return hit?.code ?? 'en';
}

const initialLang = resolveInitialLanguage();

void i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    fr: { translation: fr },
    es: { translation: es },
    de: { translation: de },
    ur: { translation: ur },
  },
  lng: initialLang,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** Apply `<html lang="…" dir="ltr|rtl">` so CSS logical properties
 *  flip and assistive tech announces the right pronunciation. */
function applyHtmlAttributes(code: string): void {
  if (typeof document === 'undefined') return;
  const lang = SUPPORTED_LANGUAGES.find((l) => l.code === code) ?? SUPPORTED_LANGUAGES[0];
  if (lang === undefined) return;
  document.documentElement.lang = lang.code;
  document.documentElement.dir = lang.dir;
}

// Initial paint — set the right attrs before any component renders.
applyHtmlAttributes(initialLang);
// And keep them in sync on every subsequent switch.
i18next.on('languageChanged', (code: string) => {
  applyHtmlAttributes(code);
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, code);
  } catch {
    // Persist failure is fine — the switcher state still works
    // for the rest of the session.
  }
});

export { i18next as i18n };
