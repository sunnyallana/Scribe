import { Button } from '@scribe/ui';
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface MathSymbol {
  readonly label: string;
  readonly latex: string;
  readonly keywords?: readonly string[];
}

interface MathCategory {
  readonly id: string;
  readonly title: string;
  readonly symbols: readonly MathSymbol[];
}

interface MathPaletteProps {
  readonly onInsert: (latex: string) => void;
  readonly onClose: () => void;
}

const CATEGORIES: readonly MathCategory[] = [
  {
    id: 'greek',
    title: 'Greek',
    symbols: [
      { label: 'α', latex: '\\alpha', keywords: ['alpha'] },
      { label: 'β', latex: '\\beta', keywords: ['beta'] },
      { label: 'γ', latex: '\\gamma', keywords: ['gamma'] },
      { label: 'δ', latex: '\\delta', keywords: ['delta'] },
      { label: 'ε', latex: '\\epsilon', keywords: ['epsilon'] },
      { label: 'ζ', latex: '\\zeta', keywords: ['zeta'] },
      { label: 'η', latex: '\\eta', keywords: ['eta'] },
      { label: 'θ', latex: '\\theta', keywords: ['theta'] },
      { label: 'ι', latex: '\\iota', keywords: ['iota'] },
      { label: 'κ', latex: '\\kappa', keywords: ['kappa'] },
      { label: 'λ', latex: '\\lambda', keywords: ['lambda'] },
      { label: 'μ', latex: '\\mu', keywords: ['mu'] },
      { label: 'ν', latex: '\\nu', keywords: ['nu'] },
      { label: 'ξ', latex: '\\xi', keywords: ['xi'] },
      { label: 'π', latex: '\\pi', keywords: ['pi'] },
      { label: 'ρ', latex: '\\rho', keywords: ['rho'] },
      { label: 'σ', latex: '\\sigma', keywords: ['sigma'] },
      { label: 'τ', latex: '\\tau', keywords: ['tau'] },
      { label: 'υ', latex: '\\upsilon', keywords: ['upsilon'] },
      { label: 'φ', latex: '\\phi', keywords: ['phi'] },
      { label: 'χ', latex: '\\chi', keywords: ['chi'] },
      { label: 'ψ', latex: '\\psi', keywords: ['psi'] },
      { label: 'ω', latex: '\\omega', keywords: ['omega'] },
      { label: 'Γ', latex: '\\Gamma', keywords: ['Gamma'] },
      { label: 'Δ', latex: '\\Delta', keywords: ['Delta'] },
      { label: 'Θ', latex: '\\Theta', keywords: ['Theta'] },
      { label: 'Λ', latex: '\\Lambda', keywords: ['Lambda'] },
      { label: 'Ξ', latex: '\\Xi', keywords: ['Xi'] },
      { label: 'Π', latex: '\\Pi', keywords: ['Pi'] },
      { label: 'Σ', latex: '\\Sigma', keywords: ['Sigma'] },
      { label: 'Φ', latex: '\\Phi', keywords: ['Phi'] },
      { label: 'Ψ', latex: '\\Psi', keywords: ['Psi'] },
      { label: 'Ω', latex: '\\Omega', keywords: ['Omega'] },
    ],
  },
  {
    id: 'operators',
    title: 'Operators',
    symbols: [
      { label: '±', latex: '\\pm', keywords: ['pm', 'plus minus'] },
      { label: '∓', latex: '\\mp', keywords: ['mp', 'minus plus'] },
      { label: '×', latex: '\\times', keywords: ['times', 'multiply'] },
      { label: '÷', latex: '\\div', keywords: ['div', 'divide'] },
      { label: '∗', latex: '\\ast', keywords: ['ast', 'star'] },
      { label: '⋅', latex: '\\cdot', keywords: ['cdot', 'dot'] },
      { label: '∘', latex: '\\circ', keywords: ['circ', 'compose'] },
      { label: '∙', latex: '\\bullet', keywords: ['bullet'] },
      { label: '⊕', latex: '\\oplus', keywords: ['oplus'] },
      { label: '⊗', latex: '\\otimes', keywords: ['otimes'] },
      { label: '⊙', latex: '\\odot', keywords: ['odot'] },
      { label: '⋆', latex: '\\star', keywords: ['star'] },
    ],
  },
  {
    id: 'relations',
    title: 'Relations',
    symbols: [
      { label: '≤', latex: '\\leq', keywords: ['leq', 'le'] },
      { label: '≥', latex: '\\geq', keywords: ['geq', 'ge'] },
      { label: '≠', latex: '\\neq', keywords: ['neq', 'ne'] },
      { label: '≈', latex: '\\approx', keywords: ['approx'] },
      { label: '≡', latex: '\\equiv', keywords: ['equiv'] },
      { label: '∼', latex: '\\sim', keywords: ['sim'] },
      { label: '≃', latex: '\\simeq', keywords: ['simeq'] },
      { label: '≅', latex: '\\cong', keywords: ['cong'] },
      { label: '∝', latex: '\\propto', keywords: ['propto'] },
      { label: '≪', latex: '\\ll', keywords: ['ll'] },
      { label: '≫', latex: '\\gg', keywords: ['gg'] },
      { label: '⊂', latex: '\\subset', keywords: ['subset'] },
      { label: '⊃', latex: '\\supset', keywords: ['supset'] },
      { label: '⊆', latex: '\\subseteq', keywords: ['subseteq'] },
      { label: '⊇', latex: '\\supseteq', keywords: ['supseteq'] },
      { label: '∈', latex: '\\in', keywords: ['in', 'element'] },
      { label: '∉', latex: '\\notin', keywords: ['notin'] },
      { label: '∋', latex: '\\ni', keywords: ['ni'] },
    ],
  },
  {
    id: 'arrows',
    title: 'Arrows',
    symbols: [
      { label: '→', latex: '\\to', keywords: ['to', 'right arrow'] },
      { label: '←', latex: '\\leftarrow', keywords: ['leftarrow'] },
      { label: '↔', latex: '\\leftrightarrow', keywords: ['leftrightarrow'] },
      { label: '⇒', latex: '\\Rightarrow', keywords: ['Rightarrow', 'implies'] },
      { label: '⇐', latex: '\\Leftarrow', keywords: ['Leftarrow'] },
      { label: '⇔', latex: '\\Leftrightarrow', keywords: ['Leftrightarrow', 'iff'] },
      { label: '↑', latex: '\\uparrow', keywords: ['uparrow'] },
      { label: '↓', latex: '\\downarrow', keywords: ['downarrow'] },
      { label: '⇑', latex: '\\Uparrow', keywords: ['Uparrow'] },
      { label: '⇓', latex: '\\Downarrow', keywords: ['Downarrow'] },
      { label: '↦', latex: '\\mapsto', keywords: ['mapsto'] },
      { label: '↪', latex: '\\hookrightarrow', keywords: ['hookrightarrow'] },
    ],
  },
  {
    id: 'sets',
    title: 'Sets & Logic',
    symbols: [
      { label: '∅', latex: '\\emptyset', keywords: ['emptyset'] },
      { label: '∪', latex: '\\cup', keywords: ['cup', 'union'] },
      { label: '∩', latex: '\\cap', keywords: ['cap', 'intersect'] },
      { label: '∖', latex: '\\setminus', keywords: ['setminus'] },
      { label: 'ℕ', latex: '\\mathbb{N}', keywords: ['N', 'natural'] },
      { label: 'ℤ', latex: '\\mathbb{Z}', keywords: ['Z', 'integers'] },
      { label: 'ℚ', latex: '\\mathbb{Q}', keywords: ['Q', 'rationals'] },
      { label: 'ℝ', latex: '\\mathbb{R}', keywords: ['R', 'reals'] },
      { label: 'ℂ', latex: '\\mathbb{C}', keywords: ['C', 'complex'] },
      { label: '∀', latex: '\\forall', keywords: ['forall'] },
      { label: '∃', latex: '\\exists', keywords: ['exists'] },
      { label: '∄', latex: '\\nexists', keywords: ['nexists'] },
      { label: '¬', latex: '\\neg', keywords: ['neg', 'not'] },
      { label: '∧', latex: '\\land', keywords: ['land', 'and'] },
      { label: '∨', latex: '\\lor', keywords: ['lor', 'or'] },
      { label: '⊤', latex: '\\top', keywords: ['top'] },
      { label: '⊥', latex: '\\bot', keywords: ['bot'] },
    ],
  },
  {
    id: 'big-ops',
    title: 'Big Operators',
    symbols: [
      { label: '∑', latex: '\\sum_{i=1}^{n} ', keywords: ['sum'] },
      { label: '∏', latex: '\\prod_{i=1}^{n} ', keywords: ['prod', 'product'] },
      { label: '∫', latex: '\\int_{a}^{b} ', keywords: ['int', 'integral'] },
      { label: '∬', latex: '\\iint ', keywords: ['iint'] },
      { label: '∭', latex: '\\iiint ', keywords: ['iiint'] },
      { label: '∮', latex: '\\oint ', keywords: ['oint'] },
      { label: '⋃', latex: '\\bigcup_{i} ', keywords: ['bigcup'] },
      { label: '⋂', latex: '\\bigcap_{i} ', keywords: ['bigcap'] },
      { label: '⊕', latex: '\\bigoplus ', keywords: ['bigoplus'] },
      { label: '⊗', latex: '\\bigotimes ', keywords: ['bigotimes'] },
      { label: 'lim', latex: '\\lim_{n \\to \\infty} ', keywords: ['lim', 'limit'] },
      { label: 'sup', latex: '\\sup ', keywords: ['sup'] },
      { label: 'inf', latex: '\\inf ', keywords: ['inf'] },
      { label: 'max', latex: '\\max ', keywords: ['max'] },
      { label: 'min', latex: '\\min ', keywords: ['min'] },
    ],
  },
  {
    id: 'accents',
    title: 'Accents',
    symbols: [
      { label: 'â', latex: '\\hat{a}', keywords: ['hat'] },
      { label: 'ā', latex: '\\bar{a}', keywords: ['bar'] },
      { label: 'ã', latex: '\\tilde{a}', keywords: ['tilde'] },
      { label: 'ȧ', latex: '\\dot{a}', keywords: ['dot'] },
      { label: 'ä', latex: '\\ddot{a}', keywords: ['ddot'] },
      { label: 'à', latex: '\\grave{a}', keywords: ['grave'] },
      { label: 'á', latex: '\\acute{a}', keywords: ['acute'] },
      { label: 'ǎ', latex: '\\check{a}', keywords: ['check'] },
      { label: 'â⃗', latex: '\\vec{a}', keywords: ['vec'] },
      { label: '⟨a⟩', latex: '\\langle a \\rangle', keywords: ['langle', 'rangle'] },
    ],
  },
  {
    id: 'delimiters',
    title: 'Delimiters & Structures',
    symbols: [
      { label: '⟨ ⟩', latex: '\\langle  \\rangle', keywords: ['langle', 'rangle'] },
      { label: '⌊ ⌋', latex: '\\lfloor  \\rfloor', keywords: ['lfloor', 'floor'] },
      { label: '⌈ ⌉', latex: '\\lceil  \\rceil', keywords: ['lceil', 'ceil'] },
      { label: '|x|', latex: '\\left| x \\right|', keywords: ['abs'] },
      { label: 'frac', latex: '\\frac{a}{b}', keywords: ['frac', 'fraction'] },
      { label: 'sqrt', latex: '\\sqrt{x}', keywords: ['sqrt'] },
      { label: 'sqrt[n]', latex: '\\sqrt[n]{x}', keywords: ['sqrt'] },
      { label: 'x^n', latex: 'x^{n}', keywords: ['power', 'sup'] },
      { label: 'x_n', latex: 'x_{n}', keywords: ['sub', 'subscript'] },
      { label: 'matrix', latex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', keywords: ['matrix', 'pmatrix'] },
      { label: 'cases', latex: '\\begin{cases} a & x > 0 \\\\ b & x \\leq 0 \\end{cases}', keywords: ['cases'] },
      { label: 'align', latex: '\\begin{align}\n  a &= b \\\\\n  c &= d\n\\end{align}', keywords: ['align'] },
    ],
  },
];

function matches(symbol: MathSymbol, query: string): boolean {
  if (query === '') return true;
  const q = query.toLowerCase();
  if (symbol.label.toLowerCase().includes(q)) return true;
  if (symbol.latex.toLowerCase().includes(q)) return true;
  return (symbol.keywords ?? []).some((k) => k.toLowerCase().includes(q));
}

export function MathPalette({ onInsert, onClose }: MathPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    return CATEGORIES.map((cat) => ({
      ...cat,
      symbols: cat.symbols.filter((s) => matches(s, query)),
    })).filter((cat) => cat.symbols.length > 0);
  }, [query]);

  return (
    <div className="flex h-full flex-col border-l bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-medium">{t('math.title')}</h2>
        <Button variant="ghost" size="icon" aria-label={t('common.close')} onClick={onClose}>
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="border-b px-3 py-2">
        <input
          type="search"
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
          placeholder={t('math.searchPlaceholder')}
          className="w-full rounded border bg-transparent px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div className="flex-1 overflow-auto p-2">
        {filtered.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('math.empty')}</p>
        ) : null}
        {filtered.map((cat) => (
          <section key={cat.id} className="mb-3">
            <h3 className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {cat.title}
            </h3>
            <div className="grid grid-cols-6 gap-1">
              {cat.symbols.map((s) => (
                <button
                  key={`${cat.id}-${s.latex}`}
                  type="button"
                  title={s.latex}
                  onClick={() => { onInsert(s.latex); }}
                  className="flex h-8 items-center justify-center rounded border bg-muted/30 text-sm hover:bg-accent hover:text-accent-foreground"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
