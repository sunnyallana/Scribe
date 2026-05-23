import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

import type { Extension } from '@codemirror/state';

export type ScribeEditorTheme = 'light' | 'dark' | 'high-contrast';

interface Palette {
  readonly background: string;
  readonly foreground: string;
  readonly gutter: string;
  readonly gutterForeground: string;
  readonly cursor: string;
  readonly selection: string;
  readonly keyword: string;
  readonly comment: string;
  readonly string: string;
  readonly command: string;
  readonly number: string;
  readonly brace: string;
  readonly link: string;
}

const lightColors: Palette = {
  background: 'transparent',
  foreground: 'hsl(222 47% 11%)',
  gutter: 'hsl(220 14% 96%)',
  gutterForeground: 'hsl(220 9% 46%)',
  cursor: 'hsl(222 47% 11%)',
  selection: 'hsl(217 91% 90%)',
  keyword: 'hsl(266 100% 38%)',
  comment: 'hsl(220 9% 46%)',
  string: 'hsl(120 39% 35%)',
  command: 'hsl(217 91% 35%)',
  number: 'hsl(15 84% 40%)',
  brace: 'hsl(220 9% 30%)',
  link: 'hsl(217 91% 45%)',
};

const darkColors: Palette = {
  background: 'transparent',
  foreground: 'hsl(0 0% 95%)',
  gutter: 'hsl(220 13% 18%)',
  gutterForeground: 'hsl(220 9% 60%)',
  cursor: 'hsl(0 0% 95%)',
  selection: 'hsl(217 91% 30%)',
  keyword: 'hsl(280 90% 75%)',
  comment: 'hsl(220 9% 55%)',
  string: 'hsl(120 50% 70%)',
  command: 'hsl(199 89% 70%)',
  number: 'hsl(30 95% 70%)',
  brace: 'hsl(0 0% 80%)',
  link: 'hsl(199 89% 75%)',
};

const highContrastColors: Palette = {
  background: 'transparent',
  foreground: 'hsl(0 0% 100%)',
  gutter: 'hsl(0 0% 0%)',
  gutterForeground: 'hsl(0 0% 80%)',
  cursor: 'hsl(60 100% 60%)',
  selection: 'hsl(220 100% 40%)',
  keyword: 'hsl(60 100% 70%)',
  comment: 'hsl(0 0% 75%)',
  string: 'hsl(120 100% 70%)',
  command: 'hsl(180 100% 70%)',
  number: 'hsl(40 100% 70%)',
  brace: 'hsl(0 0% 100%)',
  link: 'hsl(180 100% 70%)',
};

function palette(theme: ScribeEditorTheme): Palette {
  if (theme === 'dark') return darkColors;
  if (theme === 'high-contrast') return highContrastColors;
  return lightColors;
}

function highlightStyle(p: Palette): HighlightStyle {
  return HighlightStyle.define([
    { tag: t.keyword, color: p.keyword },
    { tag: t.comment, color: p.comment, fontStyle: 'italic' },
    { tag: t.string, color: p.string },
    { tag: t.number, color: p.number },
    { tag: t.brace, color: p.brace },
    { tag: t.bracket, color: p.brace },
    { tag: t.tagName, color: p.command },
    { tag: t.atom, color: p.command },
    { tag: t.variableName, color: p.command },
    { tag: t.url, color: p.link },
    { tag: t.link, color: p.link, textDecoration: 'underline' },
    { tag: t.invalid, color: p.foreground, textDecoration: 'underline wavy' },
  ]);
}

export function latexTheme(theme: ScribeEditorTheme): Extension {
  const p = palette(theme);
  const isDark = theme === 'dark' || theme === 'high-contrast';
  return [
    EditorView.theme(
      {
        // The editor must be told to fill its parent and produce its
        // OWN scrollbar — otherwise the parent's `overflow-hidden`
        // clips the bottom of long files and the user has nothing to
        // scroll. `&` is the `.cm-editor` root; `.cm-scroller` is the
        // viewport CodeMirror renders into.
        '&': {
          height: '100%',
          color: p.foreground,
          backgroundColor: p.background,
        },
        '.cm-scroller': {
          // `auto` overflow shows the scrollbar only when the doc
          // overflows. The parent container is `overflow-hidden` so
          // this scroller is the only thing that scrolls.
          overflow: 'auto',
          // Avoid the iOS rubber-band jump on a sub-region scroll —
          // makes vertical scrolling feel native on touch devices.
          overscrollBehavior: 'contain',
          // Thin native scrollbar (Firefox + modern engines that
          // honour `scrollbar-*`). WebKit takes the rules below.
          scrollbarWidth: 'thin',
          scrollbarColor: `${isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.20)'} transparent`,
        },
        // WebKit-specific (Chrome / Edge / Safari). Float the thumb
        // over a transparent track so the scrollbar reads as "part
        // of the editor" rather than a system widget bolted on.
        '.cm-scroller::-webkit-scrollbar': {
          width: '10px',
          height: '10px',
        },
        '.cm-scroller::-webkit-scrollbar-track': {
          background: 'transparent',
        },
        '.cm-scroller::-webkit-scrollbar-thumb': {
          backgroundColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.20)',
          borderRadius: '8px',
          // `border + background-clip: padding-box` is the standard
          // trick for a "floating" thumb with internal padding around
          // it — the border doesn't paint, it just inset-shrinks
          // the visible thumb so it sits inside the gutter.
          border: '2px solid transparent',
          backgroundClip: 'padding-box',
        },
        '.cm-scroller::-webkit-scrollbar-thumb:hover': {
          backgroundColor: isDark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.35)',
          backgroundClip: 'padding-box',
        },
        '.cm-scroller::-webkit-scrollbar-corner': {
          background: 'transparent',
        },
        '.cm-content': {
          caretColor: p.cursor,
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
          fontSize: '14px',
          lineHeight: '1.6',
          padding: '12px 0',
          // Trailing room so the last line isn't flush against the
          // bottom edge — easier to read when scrolled to EOF.
          paddingBottom: '40vh',
        },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.cursor },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
          backgroundColor: p.selection,
        },
        '.cm-gutters': {
          backgroundColor: p.gutter,
          color: p.gutterForeground,
          border: 'none',
        },
        '.cm-activeLine': {
          backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
        },
        '.cm-activeLineGutter': {
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        },
        '.cm-tooltip': {
          backgroundColor: isDark ? 'hsl(220 13% 12%)' : 'hsl(0 0% 100%)',
          color: p.foreground,
          border: `1px solid ${isDark ? 'hsl(220 13% 28%)' : 'hsl(220 13% 88%)'}`,
        },
        '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
          backgroundColor: p.selection,
        },
      },
      { dark: isDark },
    ),
    syntaxHighlighting(highlightStyle(p)),
  ];
}
