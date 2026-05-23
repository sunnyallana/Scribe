//! Per-template seed files. Mirrors `server/src/services/templates.ts`
//! verbatim so new projects produced by either server are identical.

use scribe_shared::ProjectTemplate;

pub struct TemplateFile {
    pub path: &'static str,
    pub content: &'static str,
}

const BLANK: &[TemplateFile] = &[TemplateFile { path: "main.tex", content: "" }];

const ARTICLE: &[TemplateFile] = &[TemplateFile {
    path: "main.tex",
    content: "\\documentclass[11pt]{article}\n\
\\usepackage[utf8]{inputenc}\n\
\\usepackage{amsmath, amssymb, amsthm}\n\
\\usepackage{graphicx}\n\
\\usepackage{hyperref}\n\
\n\
\\title{Untitled}\n\
\\author{}\n\
\\date{\\today}\n\
\n\
\\begin{document}\n\
\\maketitle\n\
\n\
\\section{Introduction}\n\
Welcome to Scribe.\n\
\n\
\\end{document}\n",
}];

const REPORT: &[TemplateFile] = &[TemplateFile {
    path: "main.tex",
    content: "\\documentclass[11pt]{report}\n\
\\usepackage[utf8]{inputenc}\n\
\n\
\\title{Untitled Report}\n\
\\author{}\n\
\\date{\\today}\n\
\n\
\\begin{document}\n\
\\maketitle\n\
\\tableofcontents\n\
\n\
\\chapter{Introduction}\n\
\n\
\\end{document}\n",
}];

const BEAMER: &[TemplateFile] = &[TemplateFile {
    path: "main.tex",
    content: "\\documentclass{beamer}\n\
\\usetheme{metropolis}\n\
\n\
\\title{Untitled}\n\
\\author{}\n\
\\date{\\today}\n\
\n\
\\begin{document}\n\
\\maketitle\n\
\n\
\\begin{frame}{Hello}\n\
  Welcome to Scribe.\n\
\\end{frame}\n\
\n\
\\end{document}\n",
}];

const CV: &[TemplateFile] = &[TemplateFile {
    path: "main.tex",
    content: "\\documentclass[11pt,a4paper]{moderncv}\n\
\\moderncvstyle{classic}\n\
\\moderncvcolor{blue}\n\
\n\
\\name{Your}{Name}\n\
\\title{Title}\n\
\n\
\\begin{document}\n\
\\makecvtitle\n\
\n\
\\section{Experience}\n\
\\cventry{2024--Present}{Role}{Company}{Location}{}{Description.}\n\
\n\
\\end{document}\n",
}];

const LETTER: &[TemplateFile] = &[TemplateFile {
    path: "main.tex",
    content: "\\documentclass{letter}\n\
\\signature{Your Name}\n\
\\address{Your Address}\n\
\n\
\\begin{document}\n\
\\begin{letter}{Recipient Name \\\\ Recipient Address}\n\
\\opening{Dear Recipient,}\n\
\n\
Body goes here.\n\
\n\
\\closing{Sincerely,}\n\
\\end{letter}\n\
\\end{document}\n",
}];

pub fn files_for_template(template: ProjectTemplate) -> &'static [TemplateFile] {
    match template {
        ProjectTemplate::Blank => BLANK,
        ProjectTemplate::Article => ARTICLE,
        ProjectTemplate::Report => REPORT,
        ProjectTemplate::Beamer => BEAMER,
        ProjectTemplate::Cv => CV,
        ProjectTemplate::Letter => LETTER,
    }
}
