import { Button, Input, Skeleton } from '@scribe/ui';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Loader2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
// Vite-friendly worker URL. `?worker&url` resolves to a chunk URL that the
// browser fetches lazily — keeps the main bundle small.
import * as pdfjs from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { downloadCompiledPdf } from '../../lib/projectExports';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface PDFPreviewProps {
  readonly url: string | null;
  readonly compiling: boolean;
  /** Highlight a specific (page, x, y, width, height) when supplied (forward SyncTeX). */
  readonly highlight?: {
    readonly page: number;
    readonly x: number;
    readonly y: number;
    readonly width?: number;
    readonly height?: number;
  } | null;
  /** Called when the user double-clicks on PDF text. Page is 1-based, x/y in PDF points. */
  readonly onInverseSync?: (page: number, x: number, y: number) => void;
  /** Base filename for the in-toolbar download button. Defaults to
   *  "document" when omitted (e.g. standalone usage in tests). */
  readonly downloadFilename?: string;
}

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
// 1.25 (125 %) — text and equations render comfortably at modern laptop
// resolutions without the user reaching for the zoom-in button on every
// open. Overleaf, Acrobat, and Apple Preview all default to ~1.25–1.5.
const DEFAULT_ZOOM_INDEX = 3;
/**
 * Minimum device-pixel oversampling. On a 1× display (most office
 * monitors), native PDF.js rendering happens at 96 DPI which makes
 * type look soft; bumping the canvas backing-store to 2× and CSS-
 * scaling it down restores Overleaf-class sharpness with no extra
 * user action. On HiDPI laptops `devicePixelRatio` is already ≥2,
 * so this floor is a no-op there.
 */
const MIN_OVERSAMPLE = 2;
/** Above this page count we switch to single-page mode by default —
 *  stacking 200 canvases murders memory even with virtualization. The
 *  user can still type any page into the jump input. */
const PAGED_MODE_THRESHOLD = 50;
/** How many pages above/below the visible window we keep canvases
 *  rendered. Two on each side = smooth scrolling without paying for the
 *  whole document up front. */
const RENDER_WINDOW = 2;

/** Page height in PDF points (1/72 in), unaffected by viewport scale. */
function pdfPageHeight(viewport: pdfjs.PageViewport): number {
  const view = viewport.viewBox;
  return (view[3] ?? 0) - (view[1] ?? 0);
}

interface PageMeta {
  readonly width: number;
  readonly height: number;
}

export function PDFPreview({
  url,
  compiling,
  highlight,
  onInverseSync,
  downloadFilename,
}: PDFPreviewProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  // Zoom is a per-user preference, not per-document — persist it
  // in localStorage so reopening the app (or refreshing) restores
  // the chosen magnification. Falls back to DEFAULT_ZOOM_INDEX
  // when no preference is stored or `localStorage` is blocked.
  const [zoomIndex, setZoomIndex] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_ZOOM_INDEX;
    try {
      const raw = window.localStorage.getItem('scribe:pdf:zoom');
      if (raw === null) return DEFAULT_ZOOM_INDEX;
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0 && n < ZOOM_LEVELS.length) return n;
    } catch {
      /* ignore */
    }
    return DEFAULT_ZOOM_INDEX;
  });
  // Persist on every change.
  useEffect(() => {
    try {
      window.localStorage.setItem('scribe:pdf:zoom', zoomIndex.toString());
    } catch {
      /* ignore */
    }
  }, [zoomIndex]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  /** Manual override for paged mode. `auto` picks based on page count. */
  const [pageModePreference, setPageModePreference] = useState<'auto' | 'continuous' | 'paged'>(
    'auto',
  );
  /** Per-page logical (CSS pixel) dimensions at current zoom. Used to
   *  size placeholder boxes so scroll position is stable before render. */
  const [pageMetas, setPageMetas] = useState<readonly PageMeta[]>([]);
  /** Quick-jump input value (controlled). */
  const [jumpInput, setJumpInput] = useState('');
  /** Bumped after pageMetas finishes loading so the render effect refires. */
  const [metaVersion, setMetaVersion] = useState(0);

  const isPaged =
    pageModePreference === 'paged' ||
    (pageModePreference === 'auto' && pageCount > PAGED_MODE_THRESHOLD);
  const zoom = ZOOM_LEVELS[zoomIndex] ?? 1;

  // ── Load document ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (url === null) {
      docRef.current = null;
      setPageCount(0);
      setCurrentPage(1);
      setPageMetas([]);
      return;
    }
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const loadingTask = pdfjs.getDocument({
          url,
          // GPU-accelerated image and pattern decode where the
          // browser supports it. On modern Chrome / Edge / Firefox
          // this is a meaningful speedup for figure-heavy pages
          // (think IEEE templates with embedded screenshots).
          enableHWA: true,
          // Render off the main thread into an OffscreenCanvas
          // when the runtime exposes one. Frees up the UI thread
          // during scroll-driven re-renders so we don't drop
          // frames in continuous-scroll mode.
          isOffscreenCanvasSupported: true,
          // Substitute embedded fonts that lack glyphs (e.g. an
          // exotic accent character) with the closest system font
          // instead of leaving a blank rectangle.
          useSystemFonts: true,
        });
        const doc = await loadingTask.promise;
        if (cancelled) {
          await doc.destroy();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        setCurrentPage((prev) => Math.min(prev, doc.numPages));
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message.length > 0 ? message : 'Failed to load PDF');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  // ── Compute logical dimensions for every page at the active zoom ──
  // We only inspect getViewport (no rendering), so this is cheap even
  // for hundreds of pages. The numbers drive placeholder sizing so the
  // scrollbar reflects the true doc height before any canvas paints.
  useEffect(() => {
    let cancelled = false;
    const doc = docRef.current;
    if (doc === null) {
      setPageMetas([]);
      return;
    }
    void (async () => {
      try {
        const metas: PageMeta[] = [];
        for (let i = 1; i <= doc.numPages; i += 1) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const vp = page.getViewport({ scale: zoom });
          metas.push({ width: vp.width, height: vp.height });
        }
        if (!cancelled) {
          setPageMetas(metas);
          setMetaVersion((v) => v + 1);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageCount, zoom]);

  // ── Track which page is "current" via scroll position ─────────────
  const handleScroll = useCallback(() => {
    if (isPaged) return;
    const scroller = scrollRef.current;
    if (scroller === null || pageMetas.length === 0) return;
    const scrollTop = scroller.scrollTop;
    const viewportMidline = scrollTop + scroller.clientHeight / 2;
    // Pages are stacked vertically with PAGE_GAP between them. Walk
    // accumulated offsets until we find the page that contains the
    // viewport midline.
    let offset = PAGE_GAP_TOP;
    for (let i = 0; i < pageMetas.length; i += 1) {
      const meta = pageMetas[i];
      if (meta === undefined) continue;
      const pageEnd = offset + meta.height;
      if (viewportMidline < pageEnd + PAGE_GAP / 2) {
        if (currentPage !== i + 1) setCurrentPage(i + 1);
        return;
      }
      offset = pageEnd + PAGE_GAP;
    }
  }, [isPaged, pageMetas, currentPage]);

  // Re-evaluate "current page" when meta changes (zoom).
  useEffect(() => {
    handleScroll();
  }, [handleScroll, metaVersion]);

  // ── Jump to a specific page ───────────────────────────────────────
  const scrollToPage = useCallback(
    (target: number, opts?: { instant?: boolean }) => {
      const safe = Math.min(Math.max(1, target), pageCount);
      setCurrentPage(safe);
      if (isPaged) return; // single-page mode handles render via state
      const scroller = scrollRef.current;
      if (scroller === null) return;
      let offset = PAGE_GAP_TOP;
      for (let i = 0; i < safe - 1; i += 1) {
        const meta = pageMetas[i];
        if (meta !== undefined) offset += meta.height + PAGE_GAP;
      }
      scroller.scrollTo({
        top: offset - PAGE_GAP,
        behavior: opts?.instant === true ? 'auto' : 'smooth',
      });
    },
    [pageCount, pageMetas, isPaged],
  );

  // When forward-sync highlight arrives, jump to that page automatically.
  useEffect(() => {
    if (highlight === null || highlight === undefined) return;
    scrollToPage(highlight.page);
  }, [highlight, scrollToPage]);

  // ── Quick-jump submit ─────────────────────────────────────────────
  const submitJump = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const n = Number.parseInt(jumpInput.trim(), 10);
      if (!Number.isFinite(n) || n < 1) return;
      scrollToPage(n);
      setJumpInput('');
    },
    [jumpInput, scrollToPage],
  );

  // ── Render guards ─────────────────────────────────────────────────
  if (url === null && !compiling) {
    return (
      <div className="flex h-full items-center justify-center bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        {t('compile.noPdf')}
      </div>
    );
  }

  // Visible page range (for windowed rendering). In single-page mode,
  // only the active page renders.
  const visibleRange = isPaged
    ? { from: currentPage, to: currentPage }
    : {
        from: Math.max(1, currentPage - RENDER_WINDOW),
        to: Math.min(pageCount, currentPage + RENDER_WINDOW),
      };

  return (
    // Surrounding "desk" tone. A neutral warm gray (#f1eee8-ish in
    // light mode via `bg-stone-100`) reduces the page-to-desk
    // contrast vs `bg-muted/30`, which previously sat much closer
    // to white and made the page edges fight against the wall. In
    // dark mode the existing dark slate stays — the theme-aware
    // `dark:` variants below preserve the contrast direction.
    <div className="flex h-full flex-col bg-stone-100 dark:bg-stone-900">
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2">
        {/* Page nav */}
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="First page"
            onClick={() => {
              scrollToPage(1);
            }}
            disabled={currentPage <= 1 || loading || pageCount === 0}
          >
            <ChevronsLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('compile.prevPage')}
            onClick={() => {
              scrollToPage(currentPage - 1);
            }}
            disabled={currentPage <= 1 || loading || pageCount === 0}
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
        <form onSubmit={submitJump} className="flex items-center gap-1.5">
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={jumpInput}
            onChange={(e) => {
              setJumpInput(e.target.value);
            }}
            onFocus={(e) => {
              e.target.select();
            }}
            placeholder={currentPage.toString()}
            className="h-7 w-14 text-center text-xs tabular-nums"
            aria-label="Jump to page"
          />
          <span className="text-xs tabular-nums text-muted-foreground">/ {pageCount || '—'}</span>
        </form>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('compile.nextPage')}
            onClick={() => {
              scrollToPage(currentPage + 1);
            }}
            disabled={currentPage >= pageCount || loading || pageCount === 0}
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Last page"
            onClick={() => {
              scrollToPage(pageCount);
            }}
            disabled={currentPage >= pageCount || loading || pageCount === 0}
          >
            <ChevronsRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
        <div className="mx-1 h-4 w-px bg-border" />
        {/* Zoom */}
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('compile.zoomOut')}
            onClick={() => {
              setZoomIndex((i) => Math.max(0, i - 1));
            }}
            disabled={zoomIndex === 0}
          >
            <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <span className="min-w-[3rem] text-center text-xs tabular-nums text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('compile.zoomIn')}
            onClick={() => {
              setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1));
            }}
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
          >
            <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t('export.downloadPdf')}
          title={t('export.downloadPdf')}
          disabled={url === null}
          onClick={() => {
            if (url === null) return;
            void downloadCompiledPdf(url, downloadFilename ?? 'document').catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              toast.error(t('export.pdfFailed', { error: msg }));
            });
          }}
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        {pageCount > PAGED_MODE_THRESHOLD ? (
          <>
            <div className="mx-1 h-4 w-px bg-border" />
            <Button
              variant={isPaged ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setPageModePreference((p) =>
                  p === 'paged' || (p === 'auto' && isPaged) ? 'continuous' : 'paged',
                );
              }}
              title={isPaged ? 'Switch to continuous scroll' : 'Switch to one-page-at-a-time'}
            >
              {isPaged ? 'Paged' : 'Scroll'}
            </Button>
          </>
        ) : null}
        {compiling ? (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            {t('compile.running')}
          </span>
        ) : null}
      </div>
      <div
        ref={scrollRef}
        className="scribe-scroll relative flex-1 overflow-auto"
        onScroll={handleScroll}
      >
        {loading && pageMetas.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6">
            <Skeleton className="h-[840px] w-[612px]" />
          </div>
        ) : error !== null ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : url === null ? null : (
          <div
            className="flex flex-col items-center"
            style={{ paddingTop: PAGE_GAP_TOP, paddingBottom: PAGE_GAP_TOP }}
          >
            {pageMetas.map((meta, idx) => {
              const pageNo = idx + 1;
              const inWindow = pageNo >= visibleRange.from && pageNo <= visibleRange.to;
              return (
                <div
                  key={`page-${pageNo}`}
                  data-page={pageNo}
                  style={{
                    width: meta.width,
                    height: meta.height,
                    marginBottom: pageNo === pageMetas.length ? 0 : PAGE_GAP,
                    // Pure white — the previous warm tint
                    // (rgb(252, 251, 246)) read as yellowed paper
                    // against the cool-grey desk. Page boundary is
                    // still defined by the boxShadow stack below.
                    backgroundColor: 'rgb(255, 255, 255)',
                    // Layered shadow: a thin warm ring just outside
                    // the page edge (defines the boundary without a
                    // pixel-hard line) + two soft drop shadows for
                    // genuine "paper on desk" depth. Much gentler on
                    // the eye than the previous `shadow-md` (which
                    // is a single fairly hard shadow).
                    boxShadow:
                      '0 0 0 1px rgba(0, 0, 0, 0.06),' +
                      ' 0 1px 2px rgba(0, 0, 0, 0.04),' +
                      ' 0 6px 16px -4px rgba(15, 23, 42, 0.18)',
                  }}
                  className="relative"
                >
                  {inWindow && docRef.current !== null ? (
                    <PageCanvas
                      doc={docRef.current}
                      pageNumber={pageNo}
                      zoom={zoom}
                      highlight={highlight?.page === pageNo ? highlight : null}
                      onInverseSync={onInverseSync}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                      {pageNo}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// Page spacing on the "desk". The wider the gap, the more the
// pages feel like distinct paper sheets rather than a continuous
// scroll-strip. 24/32 matches the spacing Apple Preview uses.
const PAGE_GAP = 24;
const PAGE_GAP_TOP = 32;

interface PageCanvasProps {
  readonly doc: pdfjs.PDFDocumentProxy;
  readonly pageNumber: number;
  readonly zoom: number;
  readonly highlight: PDFPreviewProps['highlight'];
  readonly onInverseSync: PDFPreviewProps['onInverseSync'];
}

/** Renders a single PDF page into a canvas + text layer. Memoized via
 *  React.memo so its host wrapper doesn't re-render every neighbour when
 *  one page's render finishes. */
function PageCanvas({ doc, pageNumber, zoom, highlight, onInverseSync }: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<pdfjs.PageViewport | null>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let cancelled = false;
    void (async () => {
      try {
        renderTaskRef.current?.cancel();
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        // Backing-store oversample. Take the max of the device's own
        // dpr and `MIN_OVERSAMPLE` (2) so even commodity 1× monitors
        // get a 2× backing store that the browser then linear-filters
        // down — the same trick Overleaf uses for crisp glyph edges.
        const nativeDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
        const dpr = Math.max(nativeDpr, MIN_OVERSAMPLE);
        const renderViewport = page.getViewport({ scale: zoom * dpr });
        const layoutViewport = page.getViewport({ scale: zoom });
        viewportRef.current = layoutViewport;
        // `alpha: false` means the canvas isn't compositing onto a
        // transparent background — the browser can skip the alpha
        // channel on each pixel and PDF.js paints onto an opaque
        // surface, both of which produce sharper text edges than the
        // default RGBA pipeline.
        const ctx = canvas.getContext('2d', { alpha: false });
        if (ctx === null) return;
        // Quality knobs for any rasterised content (embedded images
        // or shaded patterns). PDF text itself is drawn via vector
        // paths, but rasters benefit from these.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        canvas.width = renderViewport.width;
        canvas.height = renderViewport.height;
        canvas.style.width = `${layoutViewport.width.toString()}px`;
        canvas.style.height = `${layoutViewport.height.toString()}px`;
        const task = page.render({
          canvasContext: ctx,
          viewport: renderViewport,
          // Pure white page. The previous warm tint
          // (rgb(252, 251, 246)) gave a yellowed-paper feel that
          // clashed with the rest of the chrome — switch to clean
          // white and let the surrounding `bg-stone-100` desk plus
          // the wrapper's boxShadow provide the page boundary.
          background: 'rgb(255, 255, 255)',
          // `display` = on-screen viewing intent — same as what
          // Chrome's built-in viewer uses; favours legibility over
          // print-fidelity.
          intent: 'display',
        });
        renderTaskRef.current = task;
        await task.promise;
        if (cancelled) return;

        if (highlight !== null && highlight !== undefined) {
          drawHighlight(layoutViewport, highlight, overlayRef.current);
        }
        await renderTextLayer(page, layoutViewport, textLayerRef.current);
      } catch (err) {
        // RenderingCancelledException is expected when zoom/page changes.
        if (
          err instanceof Error &&
          err.message !== 'Rendering cancelled' &&
          err.name !== 'RenderingCancelledException'
        ) {
          // Surface the error via console; the parent toolbar shows a
          // status banner on real failures.

          console.warn(`PDF page ${pageNumber.toString()} render failed`, err);
        }
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [doc, pageNumber, zoom, highlight]);

  function handleTextLayerDoubleClick(e: React.MouseEvent<HTMLDivElement>): void {
    if (onInverseSync === undefined) return;
    const viewport = viewportRef.current;
    const container = textLayerRef.current;
    if (viewport === null || container === null) return;
    const rect = container.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    const pdfPoint: number[] = viewport.convertToPdfPoint(vx, vy) as number[];
    const pdfX = pdfPoint[0] ?? 0;
    const pdfYBottomUp = pdfPoint[1] ?? 0;
    const pageHeight = pdfPageHeight(viewport);
    const pdfYTopDown = pageHeight - pdfYBottomUp;
    onInverseSync(pageNumber, pdfX, pdfYTopDown);
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        className="block"
        aria-label={`Page ${pageNumber.toString()}`}
        // `image-rendering: auto` keeps the browser's high-quality
        // bilinear scaler when CSS-resizing the 2× backing store
        // down to logical pixels (crisp-edges would *avoid* that
        // scaler and look pixelated). `backface-visibility: hidden`
        // promotes the canvas to its own compositor layer, which
        // some Chrome builds need to avoid sub-pixel rounding on
        // scroll.
        style={{ imageRendering: 'auto', backfaceVisibility: 'hidden' }}
      />
      <div
        ref={textLayerRef}
        onDoubleClick={handleTextLayerDoubleClick}
        title="Double-click to jump to source"
        className="pdf-text-layer"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          overflow: 'hidden',
          opacity: 0.999,
          lineHeight: 1,
          userSelect: 'text',
          cursor: 'text',
        }}
      />
      <div
        ref={overlayRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          display: highlight === null || highlight === undefined ? 'none' : 'block',
          pointerEvents: 'none',
          backgroundColor: 'rgba(255, 220, 0, 0.4)',
          border: '1px solid rgba(255, 180, 0, 0.8)',
          transition: 'opacity 200ms',
        }}
      />
    </>
  );
}

function drawHighlight(
  viewport: pdfjs.PageViewport,
  h: NonNullable<PDFPreviewProps['highlight']>,
  overlay: HTMLDivElement | null,
): void {
  if (overlay === null) return;
  const pageHeight = pdfPageHeight(viewport);
  const pdfYBottomUp = pageHeight - h.y;
  const point: number[] = viewport.convertToViewportPoint(h.x, pdfYBottomUp) as number[];
  const px = point[0] ?? 0;
  const py = point[1] ?? 0;
  const w = (h.width ?? 200) * viewport.scale;
  const ht = (h.height ?? 16) * viewport.scale;
  overlay.style.display = 'block';
  overlay.style.left = `${px.toString()}px`;
  overlay.style.top = `${(py - ht).toString()}px`;
  overlay.style.width = `${w.toString()}px`;
  overlay.style.height = `${ht.toString()}px`;
}

async function renderTextLayer(
  page: pdfjs.PDFPageProxy,
  viewport: pdfjs.PageViewport,
  container: HTMLDivElement | null,
): Promise<void> {
  if (container === null) return;
  container.replaceChildren();
  container.style.setProperty('--scale-factor', viewport.scale.toString());
  const textContent = await page.getTextContent();
  const pdfjsAny = pdfjs as unknown as {
    readonly TextLayer?: new (opts: {
      readonly textContentSource: unknown;
      readonly container: HTMLElement;
      readonly viewport: pdfjs.PageViewport;
    }) => { render: () => Promise<void> };
    readonly renderTextLayer?: (opts: {
      readonly textContentSource: unknown;
      readonly container: HTMLElement;
      readonly viewport: pdfjs.PageViewport;
    }) => { promise: Promise<void> };
  };
  if (typeof pdfjsAny.TextLayer === 'function') {
    const tl = new pdfjsAny.TextLayer({
      textContentSource: textContent,
      container,
      viewport,
    });
    await tl.render();
  } else if (typeof pdfjsAny.renderTextLayer === 'function') {
    await pdfjsAny.renderTextLayer({
      textContentSource: textContent,
      container,
      viewport,
    }).promise;
  }
}
