import { type ProjectTemplate } from '@scribe/shared';

interface TemplateFile {
  readonly path: string;
  readonly content: string;
}

const BLANK: readonly TemplateFile[] = [{ path: 'main.tex', content: '' }];

const ARTICLE: readonly TemplateFile[] = [
  {
    path: 'main.tex',
    content: `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath, amssymb, amsthm}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{Untitled}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Welcome to Scribe.

\\end{document}
`,
  },
];

const REPORT: readonly TemplateFile[] = [
  {
    path: 'main.tex',
    content: `\\documentclass[11pt]{report}
\\usepackage[utf8]{inputenc}

\\title{Untitled Report}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle
\\tableofcontents

\\chapter{Introduction}

\\end{document}
`,
  },
];

const BEAMER: readonly TemplateFile[] = [
  {
    path: 'main.tex',
    content: `\\documentclass{beamer}
\\usetheme{metropolis}

\\title{Untitled}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{frame}{Hello}
  Welcome to Scribe.
\\end{frame}

\\end{document}
`,
  },
];

const CV: readonly TemplateFile[] = [
  {
    path: 'main.tex',
    content: `\\documentclass[11pt,a4paper]{moderncv}
\\moderncvstyle{classic}
\\moderncvcolor{blue}

\\name{Your}{Name}
\\title{Title}

\\begin{document}
\\makecvtitle

\\section{Experience}
\\cventry{2024--Present}{Role}{Company}{Location}{}{Description.}

\\end{document}
`,
  },
];

const LETTER: readonly TemplateFile[] = [
  {
    path: 'main.tex',
    content: `\\documentclass{letter}
\\signature{Your Name}
\\address{Your Address}

\\begin{document}
\\begin{letter}{Recipient Name \\\\ Recipient Address}
\\opening{Dear Recipient,}

Body goes here.

\\closing{Sincerely,}
\\end{letter}
\\end{document}
`,
  },
];

const TEMPLATES: Readonly<Record<ProjectTemplate, readonly TemplateFile[]>> = {
  blank: BLANK,
  article: ARTICLE,
  report: REPORT,
  beamer: BEAMER,
  cv: CV,
  letter: LETTER,
};

export function filesForTemplate(template: ProjectTemplate): readonly TemplateFile[] {
  return TEMPLATES[template];
}
