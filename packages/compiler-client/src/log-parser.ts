import type { CompileLogEntry } from './error-types.js';

const FILE_PUSH = /\(([^()\s]+\.(?:tex|sty|cls|ltx|aux))/g;
const ERROR_LINE = /^!\s*(.+)$/;
const LATEX_WARNING = /^(LaTeX|Package|Class)\s+(\w*)\s*Warning:\s*(.+?)(?:\son\s+input\s+line\s+(\d+))?\.?$/i;
const LATEX_INFO = /^(LaTeX|Package|Class)\s+(\w*)\s*Info:\s*(.+?)(?:\son\s+input\s+line\s+(\d+))?\.?$/i;
const BAD_BOX = /^(Overfull|Underfull)\s+\\([hv])box.*?at\s+lines?\s+(\d+)(?:--(\d+))?/i;
const ERROR_LINE_REF = /^l\.(\d+)(?:\s+(.*))?$/;
const UNDEFINED_REF = /^(LaTeX|Package|Class)\s+Warning:\s+(Citation|Reference)\s+`([^']+)'\s+(?:on\s+page\s+\d+\s+)?undefined\s*(?:on\s+input\s+line\s+(\d+))?/i;
const TECTONIC_NOTE = /^(note|warning|error):\s+(.*)$/i;

interface FileStackFrame {
  readonly file: string;
}

class FileStack {
  private readonly frames: FileStackFrame[] = [];

  push(file: string): void {
    this.frames.push({ file });
  }

  pop(): void {
    this.frames.pop();
  }

  current(): string | undefined {
    const top = this.frames[this.frames.length - 1];
    return top?.file;
  }
}

function countTrailingClose(line: string): number {
  let count = 0;
  for (let i = line.length - 1; i >= 0; i -= 1) {
    if (line[i] === ')') count += 1;
    else if (line[i] === ' ' || line[i] === '\t') continue;
    else break;
  }
  return count;
}

function processFileTracking(line: string, stack: FileStack): void {
  let opens = 0;
  for (const match of line.matchAll(FILE_PUSH)) {
    const file = match[1];
    if (file !== undefined) {
      stack.push(file);
      opens += 1;
    }
  }
  // Closes that don't correspond to an open in the same line. We approximate by
  // counting trailing closing parens; this is the convention pdflatex uses.
  const closes = countTrailingClose(line);
  const netCloses = Math.max(0, closes - opens);
  for (let i = 0; i < netCloses; i += 1) {
    stack.pop();
  }
}

interface PendingError {
  readonly message: string;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly raw: string;
}

/**
 * Parse a tectonic / pdflatex log into structured entries. Caller supplies the
 * concatenated stdout+stderr (or the .log file body). Output is ordered.
 */
export function parseCompileLog(log: string): CompileLogEntry[] {
  const lines = log.split(/\r?\n/);
  const stack = new FileStack();
  const entries: CompileLogEntry[] = [];
  let pendingError: PendingError | null = null;

  function flushError(line?: number): void {
    if (pendingError === null) return;
    entries.push({
      level: 'error',
      message: pendingError.message,
      ...(pendingError.file !== undefined ? { file: pendingError.file } : {}),
      ...(line !== undefined ? { line } : pendingError.line !== undefined ? { line: pendingError.line } : {}),
      raw: pendingError.raw,
    });
    pendingError = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Resolve a pending error when we see its line marker.
    const lineRef = pendingError !== null ? ERROR_LINE_REF.exec(line) : null;
    if (lineRef !== null) {
      flushError(Number(lineRef[1]));
      continue;
    }

    processFileTracking(line, stack);

    const errMatch = ERROR_LINE.exec(line);
    if (errMatch !== null) {
      flushError();
      const currentFile = stack.current();
      pendingError = {
        message: errMatch[1] ?? line,
        ...(currentFile !== undefined ? { file: currentFile } : {}),
        raw: line,
      };
      continue;
    }

    const warn = LATEX_WARNING.exec(line);
    if (warn !== null) {
      const file = stack.current();
      const lineNum = warn[4] !== undefined ? Number(warn[4]) : undefined;
      entries.push({
        level: 'warning',
        message: `${warn[1] ?? 'LaTeX'}${warn[2] !== undefined && warn[2] !== '' ? ` (${warn[2]})` : ''}: ${warn[3] ?? ''}`.trim(),
        ...(file !== undefined ? { file } : {}),
        ...(lineNum !== undefined ? { line: lineNum } : {}),
        raw: line,
      });
      continue;
    }

    const undef = UNDEFINED_REF.exec(line);
    if (undef !== null) {
      const file = stack.current();
      const lineNum = undef[4] !== undefined ? Number(undef[4]) : undefined;
      entries.push({
        level: 'warning',
        message: `${undef[2] ?? 'Reference'} '${undef[3] ?? ''}' is undefined`,
        ...(file !== undefined ? { file } : {}),
        ...(lineNum !== undefined ? { line: lineNum } : {}),
        raw: line,
      });
      continue;
    }

    const info = LATEX_INFO.exec(line);
    if (info !== null) {
      const file = stack.current();
      const lineNum = info[4] !== undefined ? Number(info[4]) : undefined;
      entries.push({
        level: 'info',
        message: `${info[1] ?? 'LaTeX'}${info[2] !== undefined && info[2] !== '' ? ` (${info[2]})` : ''}: ${info[3] ?? ''}`.trim(),
        ...(file !== undefined ? { file } : {}),
        ...(lineNum !== undefined ? { line: lineNum } : {}),
        raw: line,
      });
      continue;
    }

    const box = BAD_BOX.exec(line);
    if (box !== null) {
      const file = stack.current();
      entries.push({
        level: 'warning',
        message: `${box[1] ?? ''} \\${box[2] ?? ''}box`.trim(),
        ...(file !== undefined ? { file } : {}),
        line: Number(box[3]),
        raw: line,
      });
      continue;
    }

    const tect = TECTONIC_NOTE.exec(line);
    if (tect !== null) {
      const kind = (tect[1] ?? '').toLowerCase();
      const level = kind === 'error' ? 'error' : kind === 'warning' ? 'warning' : 'info';
      const currentFile = stack.current();
      entries.push({
        level,
        message: tect[2] ?? '',
        ...(currentFile !== undefined ? { file: currentFile } : {}),
        raw: line,
      });
      continue;
    }
  }

  flushError();
  return entries;
}
