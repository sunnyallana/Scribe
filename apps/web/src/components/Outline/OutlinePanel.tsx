import { Button } from '@scribe/ui';
import { FileText, ListTree, X } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface OutlinePanelProps {
  /**
   * Map of file path → file content. Pass at least one entry. For
   * single-file projects, that's the open file's content; for
   * multi-file projects, pass the main file plus every `\input`/
   * `\include` target so the outline aggregates them all.
   */
  readonly contents: ReadonlyMap<string, string>;
  /** The project's main file path. Used to root the `\input` walk so
   *  outline entries appear in *document order* — exactly the order
   *  the PDF prints. Falls back to alphabetic order when the main
   *  file is missing or empty. */
  readonly mainFile?: string | null;
  /** Cross-file jump. Receives the file path the outline entry came
   *  from and the line within that file. */
  readonly onJump: (filePath: string, line: number) => void;
  readonly onClose: () => void;
}

interface OutlineEntry {
  readonly level: number;
  readonly title: string;
  readonly line: number;
  /** Which file in the project this entry was parsed from. */
  readonly filePath: string;
}

const SECTION_REGEX =
  /^\s*\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\{([^}]*)\}/;

const LEVEL_BY_CMD: Readonly<Record<string, number>> = {
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

/** Match `\input{...}`, `\include{...}`, and `\subfile{...}` so we
 *  can recurse from the main file outward. Captures the path; LaTeX
 *  allows the `.tex` extension to be omitted. */
const INPUT_REGEX = /\\(?:input|include|subfile)\{([^}]+)\}/g;

/** Walk the project's file tree starting from `mainFile`, descending
 *  into each `\input{path}` reference and emitting section entries in
 *  document order. Files not reachable from main (or absent
 *  altogether) are appended at the end in alphabetic order so users
 *  with non-conventional layouts still see *something*.
 *
 *  Cycle-safe: a `visited` set prevents infinite recursion through
 *  accidental `\input` loops or shared preambles. */
function parseOutline(
  contents: ReadonlyMap<string, string>,
  mainFile: string | null | undefined,
): OutlineEntry[] {
  const ordered: OutlineEntry[] = [];
  const visited = new Set<string>();

  const lookupContent = (referenced: string): { path: string; text: string } | null => {
    // \input{sec/intro} may not include the .tex extension. Try the
    // path as-is, then with `.tex` appended, then a basename match
    // (covers projects where `\input` uses just the filename).
    const candidates = [referenced];
    if (!referenced.toLowerCase().endsWith('.tex')) candidates.push(`${referenced}.tex`);
    for (const candidate of candidates) {
      if (contents.has(candidate)) return { path: candidate, text: contents.get(candidate)! };
    }
    // Last resort: suffix match on path so `\input{intro}` resolves
    // to `sec/intro.tex`.
    for (const [path, text] of contents) {
      if (path.endsWith(`/${referenced}`) || path.endsWith(`/${referenced}.tex`)) {
        return { path, text };
      }
    }
    return null;
  };

  function descend(filePath: string): void {
    if (visited.has(filePath)) return;
    visited.add(filePath);
    const text = contents.get(filePath);
    if (text === undefined) return;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      // Strip line comments (simple: unescaped `%` to end-of-line).
      const cleaned = line.replace(/(^|[^\\])%.*$/g, '$1');

      const sectionMatch = SECTION_REGEX.exec(cleaned);
      if (sectionMatch !== null) {
        const cmd = (sectionMatch[1] ?? '').toLowerCase();
        const title = (sectionMatch[2] ?? '').trim();
        const level = LEVEL_BY_CMD[cmd] ?? 1;
        ordered.push({ level, title, line: i + 1, filePath });
        continue;
      }

      // Greedy: a single source line can carry several `\input`s
      // (rare but real), so iterate via `matchAll`.
      INPUT_REGEX.lastIndex = 0;
      let inputMatch: RegExpExecArray | null;
      while ((inputMatch = INPUT_REGEX.exec(cleaned)) !== null) {
        const target = (inputMatch[1] ?? '').trim();
        if (target === '') continue;
        const resolved = lookupContent(target);
        if (resolved !== null) descend(resolved.path);
      }
    }
  }

  if (mainFile !== null && mainFile !== undefined && contents.has(mainFile)) {
    descend(mainFile);
  }

  // Append any files we didn't reach via \input so the user always
  // sees their content. Sorted alphabetically for stability.
  const remaining = Array.from(contents.keys())
    .filter((p) => !visited.has(p))
    .sort();
  for (const path of remaining) descend(path);

  return ordered;
}

export function OutlinePanel({ contents, mainFile, onJump, onClose }: OutlinePanelProps) {
  const { t } = useTranslation();
  const entries = useMemo(
    () => parseOutline(contents, mainFile ?? null),
    [contents, mainFile],
  );

  // Determine whether the outline spans more than one file. If so we
  // emit a file-header row before each block to make the source of
  // each entry obvious.
  const multiFile = useMemo(() => {
    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.filePath);
      if (seen.size > 1) return true;
    }
    return false;
  }, [entries]);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <ListTree className="h-3.5 w-3.5" aria-hidden="true" />
          {t('outline.title')}
        </h3>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common.close')}
          className="h-6 w-6"
          onClick={onClose}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {entries.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">{t('outline.empty')}</p>
        ) : (
          <ul className="space-y-px p-2">
            {entries.map((e, idx) => {
              const prev = idx > 0 ? entries[idx - 1] : undefined;
              const showFileHeader = multiFile && (prev === undefined || prev.filePath !== e.filePath);
              return (
                <li key={`${e.filePath}:${e.line.toString()}:${idx.toString()}`}>
                  {showFileHeader ? (
                    <div className="mt-2 flex items-center gap-1 px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      <FileText className="h-3 w-3" aria-hidden="true" />
                      <span className="truncate" title={e.filePath}>{e.filePath}</span>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-accent/60"
                    style={{ paddingLeft: `${(e.level * 10 + 6).toString()}px` }}
                    onClick={() => { onJump(e.filePath, e.line); }}
                  >
                    <span className="flex-1 truncate">{e.title}</span>
                    <span className="ml-2 shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      L{e.line}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
