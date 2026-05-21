import { PanelResizeHandle } from 'react-resizable-panels';

interface SplitterProps {
  readonly orientation: 'vertical' | 'horizontal';
}

/**
 * Thin styled wrapper around PanelResizeHandle. Vertical = handle between
 * left/right panels (drag horizontally); Horizontal = handle between
 * top/bottom panels (drag vertically). Names match the visual axis of
 * the bar itself.
 */
export function Splitter({ orientation }: SplitterProps) {
  const isVertical = orientation === 'vertical';
  return (
    <PanelResizeHandle
      className={
        isVertical
          ? 'group relative w-px bg-border transition-colors hover:bg-primary/40 data-[resize-handle-state=drag]:bg-primary'
          : 'group relative h-px bg-border transition-colors hover:bg-primary/40 data-[resize-handle-state=drag]:bg-primary'
      }
    >
      {/* Larger invisible hit-target so the 1px bar is easy to grab. */}
      <span
        aria-hidden="true"
        className={
          isVertical
            ? 'absolute inset-y-0 -left-1 w-3 cursor-col-resize'
            : 'absolute inset-x-0 -top-1 h-3 cursor-row-resize'
        }
      />
    </PanelResizeHandle>
  );
}
