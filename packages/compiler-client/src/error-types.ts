export const compileEntryLevels = ['error', 'warning', 'info', 'debug'] as const;
export type CompileEntryLevel = (typeof compileEntryLevels)[number];

export const compileStatuses = ['queued', 'running', 'success', 'error', 'cancelled'] as const;
export type CompileStatus = (typeof compileStatuses)[number];

export const compileEngines = ['tectonic', 'pdflatex', 'xelatex', 'lualatex'] as const;
export type CompileEngine = (typeof compileEngines)[number];

export interface CompileLogEntry {
  readonly level: CompileEntryLevel;
  readonly message: string;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly raw?: string | undefined;
  /** Producer of this entry: "tectonic" / "latexmk" / "chktex" /
   *  undefined (treated as compile-engine). The log panel groups
   *  entries by this so lint warnings stay visually separate from
   *  engine output. */
  readonly source?: string | undefined;
}

export interface CompileResultSummary {
  readonly status: CompileStatus;
  readonly entries: readonly CompileLogEntry[];
  readonly pdfStorageKey?: string | undefined;
  readonly logStorageKey?: string | undefined;
  readonly synctexStorageKey?: string | undefined;
  readonly durationMs: number;
  readonly compiledAt: string;
}
