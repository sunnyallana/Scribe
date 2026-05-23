import { hoverTooltip, type Tooltip } from '@codemirror/view';

import type { Extension } from '@codemirror/state';

/**
 * A resolved hover preview. The editor extension is dumb about
 * sources — the host supplies the callbacks, this extension just
 * decides when to call them based on what's under the cursor.
 *
 * Empty `body` means "found nothing useful" and the tooltip is
 * suppressed (we don't want a popover saying "no info" for every
 * unknown identifier — too noisy).
 */
export interface HoverPreview {
  /** Short header line, e.g. "Equation · eq:foo" or "Citation". */
  readonly title: string;
  /** Multi-line body. Rendered in a monospace block for ref
   *  previews (raw LaTeX source); plain text for citations. */
  readonly body: string;
  /** When true, the body is treated as LaTeX source and rendered
   *  in a `<pre><code>` block; when false (citations), it's plain
   *  text with line breaks preserved. */
  readonly mono: boolean;
}

export interface HoverPreviewSources {
  /** Lookup the equation / figure / theorem block where `name` is
   *  defined via `\label{name}`. Should search across every file
   *  in the project, not just the current document. */
  readonly resolveLabel?: (name: string) => HoverPreview | null;
  /** Lookup the bibliography entry for citation key `name`. */
  readonly resolveCitation?: (name: string) => HoverPreview | null;
}

/** Token patterns we recognise under the cursor. The capture group
 *  is the identifier inside `{...}`. We scan a small window around
 *  the cursor rather than the whole line because a single line can
 *  contain multiple `\cite{a}\cite{b}` calls and we want the right
 *  one. */
const REF_LIKE = /\\(?:ref|eqref|pageref|autoref|cref|Cref)\{([a-zA-Z0-9:_\-+./]+)\}/;
const CITE_LIKE = /\\(?:cite|citep|citet|citeauthor|citeyear|nocite)\{([^}]+)\}/;

function findTokenAt(line: string, cursorCol: number): { kind: 'ref' | 'cite'; name: string; from: number; to: number } | null {
  // Scan the line for any matching ref/cite span containing
  // the cursor column. CodeMirror gives us 0-based offsets.
  const allRe = /\\(?:ref|eqref|pageref|autoref|cref|Cref|cite|citep|citet|citeauthor|citeyear|nocite)\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = allRe.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (cursorCol < start || cursorCol > end) continue;
    const refTest = REF_LIKE.exec(m[0]);
    const citeTest = CITE_LIKE.exec(m[0]);
    if (refTest !== null) {
      return { kind: 'ref', name: refTest[1] ?? '', from: start, to: end };
    }
    if (citeTest !== null) {
      // For a multi-key cite like `\cite{a,b,c}`, pick the key
      // closest to the cursor — most useful UX.
      const keys = (citeTest[1] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
      if (keys.length === 0) return null;
      // Best-effort: locate the comma-split positions and bucket
      // the cursor into a key index.
      const openBrace = m[0].indexOf('{');
      const relCol = cursorCol - start - openBrace - 1;
      let acc = 0;
      let chosen = keys[0] ?? '';
      for (const k of keys) {
        const next = acc + k.length;
        if (relCol >= acc && relCol <= next + 1) { chosen = k; break; }
        acc = next + 1; // +1 for the comma
      }
      return { kind: 'cite', name: chosen, from: start, to: end };
    }
  }
  return null;
}

/** CodeMirror hover-tooltip extension wiring. The provider stays
 *  stable across renders even when `sources` mutates because we
 *  read through a ref-style closure. */
export function hoverPreview(getSources: () => HoverPreviewSources): Extension {
  return hoverTooltip((view, pos): Tooltip | null => {
    const line = view.state.doc.lineAt(pos);
    const colInLine = pos - line.from;
    const token = findTokenAt(line.text, colInLine);
    if (token === null) return null;
    const sources = getSources();
    const preview = token.kind === 'ref'
      ? (sources.resolveLabel?.(token.name) ?? null)
      : (sources.resolveCitation?.(token.name) ?? null);
    if (preview === null || preview.body === '') return null;

    return {
      pos: line.from + token.from,
      end: line.from + token.to,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-hover-preview';
        // Inline styles only — we keep the editor package free of
        // Tailwind. Host pages can override via the .cm-hover-preview
        // class if they want.
        dom.style.maxWidth = '32rem';
        dom.style.maxHeight = '16rem';
        dom.style.overflow = 'auto';
        dom.style.padding = '6px 10px';
        dom.style.fontSize = '11px';
        dom.style.lineHeight = '1.4';
        dom.style.background = 'var(--cm-tooltip-bg, #1f2937)';
        dom.style.color = 'var(--cm-tooltip-fg, #f3f4f6)';
        dom.style.border = '1px solid rgba(255,255,255,0.08)';
        dom.style.borderRadius = '4px';
        dom.style.boxShadow = '0 4px 14px rgba(0,0,0,0.25)';

        const title = document.createElement('div');
        title.textContent = preview.title;
        title.style.fontWeight = '600';
        title.style.marginBottom = '4px';
        title.style.opacity = '0.85';
        dom.appendChild(title);

        if (preview.mono) {
          const pre = document.createElement('pre');
          pre.textContent = preview.body;
          pre.style.margin = '0';
          pre.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
          pre.style.fontSize = '10.5px';
          pre.style.whiteSpace = 'pre-wrap';
          pre.style.wordBreak = 'break-word';
          dom.appendChild(pre);
        } else {
          const p = document.createElement('div');
          p.textContent = preview.body;
          p.style.whiteSpace = 'pre-wrap';
          dom.appendChild(p);
        }
        return { dom };
      },
    };
  }, { hideOnChange: true, hoverTime: 200 });
}
