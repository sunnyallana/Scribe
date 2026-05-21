export interface CompileTrigger {
  /** Request a compile; collapses multiple calls within the debounce window. */
  schedule(): void;
  /** Force an immediate compile, bypassing the debounce. */
  flush(): void;
  /** Cancel any pending compile. */
  cancel(): void;
}

export interface CompileTriggerOptions {
  readonly delayMs: number;
  readonly onCompile: () => void;
}

/**
 * Tiny debouncer used to throttle the editor → compile path. Lives in the
 * compiler-client package so both the editor's "compile on save" path and
 * any future automatic compile-on-idle logic share one implementation.
 */
export function createCompileTrigger({ delayMs, onCompile }: CompileTriggerOptions): CompileTrigger {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  return {
    schedule(): void {
      clear();
      timeoutId = setTimeout(() => {
        timeoutId = null;
        onCompile();
      }, delayMs);
    },
    flush(): void {
      clear();
      onCompile();
    },
    cancel(): void {
      clear();
    },
  };
}
