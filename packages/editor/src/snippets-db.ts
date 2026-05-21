export interface SnippetDef {
  readonly trigger: string;
  readonly description: string;
  /**
   * Snippet body. Supports CodeMirror's `#{<label>}` placeholder syntax via
   * the snippet() extension in @codemirror/autocomplete.
   */
  readonly body: string;
}

export const latexSnippets: readonly SnippetDef[] = [
  {
    trigger: 'doc',
    description: 'Article document skeleton',
    body: '\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\n\\title{#{title}}\n\\author{#{author}}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n#{body}\n\n\\end{document}',
  },
  {
    trigger: 'beg',
    description: 'Begin/end environment',
    body: '\\begin{#{name}}\n\t#{body}\n\\end{#{name}}',
  },
  {
    trigger: 'fig',
    description: 'Figure with caption and label',
    body: '\\begin{figure}[#{position}]\n\t\\centering\n\t\\includegraphics[width=#{width}]{#{file}}\n\t\\caption{#{caption}}\n\t\\label{fig:#{label}}\n\\end{figure}',
  },
  {
    trigger: 'tab',
    description: 'Tabular table',
    body: '\\begin{table}[#{position}]\n\t\\centering\n\t\\begin{tabular}{#{cols}}\n\t\t#{body}\n\t\\end{tabular}\n\t\\caption{#{caption}}\n\t\\label{tab:#{label}}\n\\end{table}',
  },
  {
    trigger: 'eq',
    description: 'Numbered equation',
    body: '\\begin{equation}\n\t#{body}\n\t\\label{eq:#{label}}\n\\end{equation}',
  },
  {
    trigger: 'eq*',
    description: 'Unnumbered equation',
    body: '\\begin{equation*}\n\t#{body}\n\\end{equation*}',
  },
  {
    trigger: 'align',
    description: 'Aligned equations',
    body: '\\begin{align}\n\t#{body}\n\\end{align}',
  },
  {
    trigger: 'itemize',
    description: 'Bullet list',
    body: '\\begin{itemize}\n\t\\item #{first}\n\t\\item #{second}\n\\end{itemize}',
  },
  {
    trigger: 'enum',
    description: 'Numbered list',
    body: '\\begin{enumerate}\n\t\\item #{first}\n\t\\item #{second}\n\\end{enumerate}',
  },
];
