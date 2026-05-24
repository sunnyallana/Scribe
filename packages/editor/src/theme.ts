import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

import type { Extension } from '@codemirror/state';

export type ScribeEditorTheme = 'light' | 'dark' | 'high-contrast';

// ───────────────────────────────────────────────────────────────────────────
// Root-cause note (kept here, where it matters):
//
// CodeMirror's `EditorView.theme(...)` snapshots the spec object once at
// construction time and registers it as a StyleModule — a `<style>` block
// injected into the document head with the values baked into the CSS text.
// Equivalently for `syntaxHighlighting(HighlightStyle.define(...))`: the
// HighlightStyle is registered as a constant set of rules.
//
// If we put literal colours here (`#171717`, `hsl(...)` strings, etc.),
// flipping the page-level `data-theme` attribute later does *nothing* —
// the editor stylesheet is frozen at mount, so the page chrome flips while
// the editor stays on the original palette until a full refresh rebuilds
// the StyleModule. That's the "code editor doesn't change until refresh"
// symptom users hit.
//
// The fix: every colour the editor stylesheet emits goes through a
// `var(--cm-...)` reference. The variables themselves live in
// `packages/ui/src/styles/globals.css` under each `[data-theme]` block.
// Now CM's injected `<style>` is literally `color: var(--cm-fg)`, and a
// theme toggle that updates the variable on `:root` cascades into the
// editor without any reconfigure, compartment, or React effect. The
// `latexTheme(theme)` parameter is preserved only for backward compat
// (and the `dark: true` boolean flag that CodeMirror uses internally to
// classify the theme — see comment below).
// ───────────────────────────────────────────────────────────────────────────

function highlightStyle(): HighlightStyle {
  return HighlightStyle.define([
    { tag: t.keyword, color: 'var(--cm-keyword)' },
    { tag: t.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
    { tag: t.string, color: 'var(--cm-string)' },
    { tag: t.number, color: 'var(--cm-number)' },
    { tag: t.brace, color: 'var(--cm-brace)' },
    { tag: t.bracket, color: 'var(--cm-brace)' },
    { tag: t.tagName, color: 'var(--cm-command)' },
    { tag: t.atom, color: 'var(--cm-command)' },
    { tag: t.variableName, color: 'var(--cm-command)' },
    { tag: t.url, color: 'var(--cm-link)' },
    { tag: t.link, color: 'var(--cm-link)', textDecoration: 'underline' },
    { tag: t.invalid, color: 'var(--cm-fg)', textDecoration: 'underline wavy' },
  ]);
}

// One StyleModule for the entire app lifetime. Identical string content
// across mounts, so CodeMirror's internal StyleModule deduper reuses
// the same `<style>` element — and a theme toggle updates the cascade
// without touching the module at all.
const editorStyleSheet = EditorView.theme(
  {
    // The editor must be told to fill its parent and produce its OWN
    // scrollbar — otherwise the parent's `overflow-hidden` clips the
    // bottom of long files and the user has nothing to scroll. `&` is
    // the `.cm-editor` root; `.cm-scroller` is the viewport CodeMirror
    // renders into.
    '&': {
      height: '100%',
      color: 'var(--cm-fg)',
      backgroundColor: 'transparent',
    },
    '.cm-scroller': {
      overflow: 'auto',
      overscrollBehavior: 'contain',
      scrollbarWidth: 'thin',
      scrollbarColor: 'var(--cm-scrollbar-thumb) transparent',
    },
    '.cm-scroller::-webkit-scrollbar': {
      width: '10px',
      height: '10px',
    },
    '.cm-scroller::-webkit-scrollbar-track': {
      background: 'transparent',
    },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      backgroundColor: 'var(--cm-scrollbar-thumb)',
      borderRadius: '8px',
      border: '2px solid transparent',
      backgroundClip: 'padding-box',
    },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': {
      backgroundColor: 'var(--cm-scrollbar-thumb-hover)',
      backgroundClip: 'padding-box',
    },
    '.cm-scroller::-webkit-scrollbar-corner': {
      background: 'transparent',
    },
    '.cm-content': {
      // Pin fg so unstyled tokens (stex's DEFAULT plugin returns
      // `undefined` from `styleIdentifier` for the body of
      // `\title{…}` / `\textit{…}` / similar unknown commands)
      // inherit the document ink rather than whatever the parent
      // surface leaks.
      color: 'var(--cm-fg)',
      caretColor: 'var(--cm-cursor)',
      fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
      fontSize: '14px',
      lineHeight: '1.6',
      padding: '12px 0',
      paddingBottom: '40vh',
    },
    '.cm-line': {
      color: 'var(--cm-fg)',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cm-cursor)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--cm-selection-bg)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--cm-gutter-bg)',
      color: 'var(--cm-gutter-fg)',
      border: 'none',
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--cm-active-line-bg)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--cm-active-line-gutter-bg)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--cm-tooltip-bg)',
      color: 'var(--cm-fg)',
      border: '1px solid var(--cm-tooltip-border)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--cm-selection-bg)',
    },
  },
  // The `dark: true/false` flag is per-StyleModule, so we can't flip
  // it on a theme toggle without re-registering. Leave it `false`; CM
  // only uses the flag to pick a fallback selection colour and a
  // `color-scheme` hint — both of which we already specify explicitly
  // above. The visible cascade is fully driven by the CSS vars.
  { dark: false },
);

const editorHighlighting = syntaxHighlighting(highlightStyle());

/**
 * Returns the editor's theme + syntax-highlight extensions. The `theme`
 * parameter is accepted for backward compatibility but no longer drives
 * the colour palette — every colour reaches the DOM through a
 * `var(--cm-*)` reference, and the variables themselves are defined
 * per-theme on `:root` in `packages/ui/src/styles/globals.css`. Toggle
 * `data-theme` and the editor flips with the rest of the chrome, no
 * reconfigure required.
 */
export function latexTheme(_theme?: ScribeEditorTheme): Extension {
  return [editorStyleSheet, editorHighlighting];
}
