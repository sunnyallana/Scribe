export interface LatexCommandDef {
  readonly name: string;
  /** Optional template inserted at the cursor. `#1`, `#2`, … become tab stops. */
  readonly template?: string;
  readonly description?: string;
  readonly category?: string;
}

/**
 * A curated, intentionally small set of LaTeX commands. Covers the ~95% of
 * everyday writing. Full reference can be added on demand without changing
 * the API.
 */
export const latexCommands: readonly LatexCommandDef[] = [
  // Sectioning
  {
    name: '\\chapter',
    template: '\\chapter{#1}',
    description: 'Top-level section',
    category: 'sectioning',
  },
  { name: '\\section', template: '\\section{#1}', description: 'Section', category: 'sectioning' },
  {
    name: '\\subsection',
    template: '\\subsection{#1}',
    description: 'Subsection',
    category: 'sectioning',
  },
  {
    name: '\\subsubsection',
    template: '\\subsubsection{#1}',
    description: 'Subsubsection',
    category: 'sectioning',
  },
  {
    name: '\\paragraph',
    template: '\\paragraph{#1}',
    description: 'Paragraph heading',
    category: 'sectioning',
  },

  // Document
  {
    name: '\\documentclass',
    template: '\\documentclass{#1}',
    description: 'Document class',
    category: 'preamble',
  },
  {
    name: '\\usepackage',
    template: '\\usepackage{#1}',
    description: 'Load a package',
    category: 'preamble',
  },
  { name: '\\title', template: '\\title{#1}', description: 'Document title', category: 'preamble' },
  { name: '\\author', template: '\\author{#1}', description: 'Author', category: 'preamble' },
  { name: '\\date', template: '\\date{#1}', description: 'Date', category: 'preamble' },
  { name: '\\maketitle', description: 'Render the title block', category: 'preamble' },
  {
    name: '\\begin',
    template: '\\begin{#1}',
    description: 'Begin environment',
    category: 'environments',
  },
  {
    name: '\\end',
    template: '\\end{#1}',
    description: 'End environment',
    category: 'environments',
  },

  // Refs / cites / labels
  {
    name: '\\label',
    template: '\\label{#1}',
    description: 'Define a label',
    category: 'cross-refs',
  },
  { name: '\\ref', template: '\\ref{#1}', description: 'Cross-reference', category: 'cross-refs' },
  {
    name: '\\eqref',
    template: '\\eqref{#1}',
    description: 'Equation reference',
    category: 'cross-refs',
  },
  {
    name: '\\pageref',
    template: '\\pageref{#1}',
    description: 'Page reference',
    category: 'cross-refs',
  },
  { name: '\\cite', template: '\\cite{#1}', description: 'Citation', category: 'cross-refs' },
  {
    name: '\\bibliography',
    template: '\\bibliography{#1}',
    description: 'Bibliography source',
    category: 'cross-refs',
  },
  {
    name: '\\bibliographystyle',
    template: '\\bibliographystyle{#1}',
    description: 'Bibliography style',
    category: 'cross-refs',
  },

  // Math
  { name: '\\frac', template: '\\frac{#1}{#2}', description: 'Fraction', category: 'math' },
  { name: '\\sqrt', template: '\\sqrt{#1}', description: 'Square root', category: 'math' },
  { name: '\\sum', template: '\\sum_{#1}^{#2}', description: 'Sum', category: 'math' },
  { name: '\\int', template: '\\int_{#1}^{#2}', description: 'Integral', category: 'math' },
  { name: '\\prod', template: '\\prod_{#1}^{#2}', description: 'Product', category: 'math' },
  { name: '\\lim', template: '\\lim_{#1}', description: 'Limit', category: 'math' },
  { name: '\\alpha', description: 'Greek α', category: 'math' },
  { name: '\\beta', description: 'Greek β', category: 'math' },
  { name: '\\gamma', description: 'Greek γ', category: 'math' },
  { name: '\\delta', description: 'Greek δ', category: 'math' },
  { name: '\\epsilon', description: 'Greek ε', category: 'math' },
  { name: '\\pi', description: 'Greek π', category: 'math' },
  { name: '\\theta', description: 'Greek θ', category: 'math' },
  { name: '\\lambda', description: 'Greek λ', category: 'math' },
  { name: '\\mu', description: 'Greek μ', category: 'math' },
  { name: '\\sigma', description: 'Greek σ', category: 'math' },
  { name: '\\phi', description: 'Greek φ', category: 'math' },
  { name: '\\omega', description: 'Greek ω', category: 'math' },
  { name: '\\infty', description: 'Infinity', category: 'math' },
  { name: '\\partial', description: 'Partial derivative', category: 'math' },
  { name: '\\nabla', description: 'Nabla', category: 'math' },
  { name: '\\leq', description: 'Less than or equal', category: 'math' },
  { name: '\\geq', description: 'Greater than or equal', category: 'math' },
  { name: '\\neq', description: 'Not equal', category: 'math' },
  { name: '\\approx', description: 'Approximately equal', category: 'math' },
  { name: '\\rightarrow', description: 'Right arrow', category: 'math' },
  { name: '\\Rightarrow', description: 'Right double arrow', category: 'math' },

  // Text formatting
  { name: '\\textbf', template: '\\textbf{#1}', description: 'Bold text', category: 'formatting' },
  {
    name: '\\textit',
    template: '\\textit{#1}',
    description: 'Italic text',
    category: 'formatting',
  },
  {
    name: '\\emph',
    template: '\\emph{#1}',
    description: 'Emphasized text',
    category: 'formatting',
  },
  {
    name: '\\texttt',
    template: '\\texttt{#1}',
    description: 'Typewriter text',
    category: 'formatting',
  },
  {
    name: '\\underline',
    template: '\\underline{#1}',
    description: 'Underlined text',
    category: 'formatting',
  },

  // Lists / tables / figures
  { name: '\\item', template: '\\item #1', description: 'List item', category: 'lists' },
  {
    name: '\\caption',
    template: '\\caption{#1}',
    description: 'Figure/table caption',
    category: 'figures',
  },
  {
    name: '\\includegraphics',
    template: '\\includegraphics[width=#1]{#2}',
    description: 'Include image',
    category: 'figures',
  },

  // Misc
  { name: '\\footnote', template: '\\footnote{#1}', description: 'Footnote', category: 'misc' },
  { name: '\\input', template: '\\input{#1}', description: 'Include file', category: 'misc' },
  {
    name: '\\include',
    template: '\\include{#1}',
    description: 'Include file (new page)',
    category: 'misc',
  },
  { name: '\\newline', description: 'Line break', category: 'misc' },
  { name: '\\noindent', description: 'No indent', category: 'misc' },
];
