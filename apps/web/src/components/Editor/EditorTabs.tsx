import { type ProjectFile } from '@scribe/shared';
import { BookText, FileText, Image as ImageIcon, X } from 'lucide-react';
import { type MouseEvent, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Multi-file tab strip. Sits at the top of the editor pane, showing
 * every file the user has opened (not just the active one). Click to
 * switch, X / middle-click to close, Ctrl+W shortcut to close the
 * active tab (wired up by the consumer — keyboard scope belongs to
 * the page, not this stateless strip).
 *
 * The strip is intentionally scrollable rather than wrapping or
 * dropping into a menu: heavy users open 6–10 files on a thesis and a
 * single horizontal scroll preserves spatial memory of tab order.
 */
interface EditorTabsProps {
  readonly tabs: readonly ProjectFile[];
  readonly activeFileId: ProjectFile['id'] | null;
  readonly onSelect: (file: ProjectFile) => void;
  readonly onClose: (file: ProjectFile) => void;
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function iconFor(file: ProjectFile) {
  if (file.type === 'bib' || file.path.toLowerCase().endsWith('.bib')) return BookText;
  if (file.type === 'image') return ImageIcon;
  return FileText;
}

export function EditorTabs({ tabs, activeFileId, onSelect, onClose }: EditorTabsProps) {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the active tab in view when it changes — selecting a file
  // from the tree that's currently scrolled off the right side
  // should auto-scroll into the visible portion of the strip.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeFileId]);

  // Convert vertical wheel into horizontal scroll on the tab strip
  // — the conventional UX in IDE tab bars (VS Code, Cursor). Users
  // expect to spin the wheel without holding Shift.
  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollerRef.current;
    if (el === null) return;
    // Only intercept primarily-vertical scroll events; trackpad
    // pinch-to-zoom or natural horizontal swipes pass through.
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      el.scrollLeft += event.deltaY;
    }
  }, []);

  if (tabs.length === 0) return null;

  return (
    <div
      ref={scrollerRef}
      onWheel={onWheel}
      className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b bg-muted/40 scrollbar-thin"
      role="tablist"
      aria-label={t('tabs.label')}
    >
      {tabs.map((file) => {
        const isActive = file.id === activeFileId;
        const Icon = iconFor(file);
        return (
          <button
            key={file.id}
            ref={isActive ? activeRef : undefined}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={file.path}
            // Middle-click closes — universal IDE / browser tab
            // convention. We can't rely on plain `onClick` to
            // distinguish, so we use onAuxClick which only fires
            // for non-primary buttons.
            onAuxClick={(e: MouseEvent<HTMLButtonElement>) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(file);
              }
            }}
            onClick={() => { onSelect(file); }}
            className={`group relative flex min-w-0 items-center gap-1.5 border-r px-2.5 text-xs transition-colors ${
              isActive
                ? 'bg-background font-medium text-foreground'
                : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
            }`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="max-w-[16ch] truncate">{basename(file.path)}</span>
            {/* Close button — visible on hover for inactive tabs,
                always visible for the active tab (so you don't lose
                track of how to close the file you're staring at). */}
            <span
              role="button"
              tabIndex={-1}
              aria-label={t('tabs.closeFile', { path: basename(file.path) })}
              title={t('tabs.closeFile', { path: basename(file.path) })}
              onClick={(e) => {
                e.stopPropagation();
                onClose(file);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onClose(file);
                }
              }}
              className={`ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm transition-opacity hover:bg-muted ${
                isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'
              }`}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
