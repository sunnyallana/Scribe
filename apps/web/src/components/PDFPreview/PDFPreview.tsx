import { Button, Skeleton } from '@scribe/ui';
import { ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut } from 'lucide-react';
// Vite-friendly worker URL. `?worker&url` resolves to a chunk URL that the
// browser fetches lazily — keeps the main bundle small.
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url';
import * as pdfjs from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
}

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const DEFAULT_ZOOM_INDEX = 2;

/** Page height in PDF points (1/72 in), unaffected by viewport scale. */
function pdfPageHeight(viewport: pdfjs.PageViewport): number {
  const view = viewport.viewBox;
  return (view[3] ?? 0) - (view[1] ?? 0);
}

export function PDFPreview({ url, compiling, highlight, onInverseSync }: PDFPreviewProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);
  const viewportRef = useRef<pdfjs.PageViewport | null>(null);
  const clickMarkerRef = useRef<HTMLDivElement>(null);
  // Increments whenever a new doc finishes loading so the render effect
  // below re-fires even when pageNumber/zoom haven't changed.
  const [docVersion, setDocVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (url === null) {
      docRef.current = null;
      setPageCount(0);
      setPageNumber(1);
      return;
    }
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const loadingTask = pdfjs.getDocument(url);
        const doc = await loadingTask.promise;
        if (cancelled) {
          await doc.destroy();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        setPageNumber((prev) => Math.min(prev, doc.numPages));
        setDocVersion((v) => v + 1);
      } catch (err) {
        if (!cancelled) {
          // PDF.js throws plain strings in some code paths
          // (e.g. password-protected docs) and `Error` instances in
          // others. `String(err)` falls back to a useful description
          // either way instead of the generic "Failed to load PDF".
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

  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (doc === null || canvas === null) return;

    let cancelled = false;
    void (async () => {
      try {
        renderTaskRef.current?.cancel();
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const scale = ZOOM_LEVELS[zoomIndex] ?? 1;
        // Render at the device pixel ratio for crisp text on HiDPI screens,
        // but display at the logical (CSS) size so layout stays the same.
        const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
        const renderViewport = page.getViewport({ scale: scale * dpr });
        const layoutViewport = page.getViewport({ scale });
        viewportRef.current = layoutViewport;
        const ctx = canvas.getContext('2d');
        if (ctx === null) return;
        canvas.width = renderViewport.width;
        canvas.height = renderViewport.height;
        canvas.style.width = `${layoutViewport.width.toString()}px`;
        canvas.style.height = `${layoutViewport.height.toString()}px`;
        const task = page.render({ canvasContext: ctx, viewport: renderViewport });
        renderTaskRef.current = task;
        await task.promise;

        if (highlight?.page === pageNumber) {
          drawHighlight(layoutViewport, highlight);
        } else {
          clearHighlight();
        }

        await renderTextLayer(page, layoutViewport);
      } catch (err) {
        if (
          err instanceof Error &&
          err.message !== 'Rendering cancelled' &&
          err.name !== 'RenderingCancelledException'
        ) {
          setError(err.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageNumber, zoomIndex, highlight, docVersion]);

  function drawHighlight(
    viewport: pdfjs.PageViewport,
    h: NonNullable<PDFPreviewProps['highlight']>,
  ): void {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    // SyncTeX `v` is top-down from page origin (TeX convention); pdf.js
    // expects pdf-y in bottom-up convention for convertToViewportPoint.
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

  function clearHighlight(): void {
    const overlay = overlayRef.current;
    if (overlay !== null) overlay.style.display = 'none';
  }

  async function renderTextLayer(
    page: pdfjs.PDFPageProxy,
    viewport: pdfjs.PageViewport,
  ): Promise<void> {
    const container = textLayerRef.current;
    if (container === null) return;
    container.replaceChildren();
    // pdf.js >=4 uses `setLayerDimensions` internally, which writes
    // `width: calc(var(--scale-factor) * Wpx)`. Without this variable the
    // text layer collapses to 0×0 and text spans pile up at the origin.
    container.style.setProperty('--scale-factor', viewport.scale.toString());
    const textContent = await page.getTextContent();
    // pdf.js >=4 exposes a `TextLayer` class; older builds expose `renderTextLayer`.
    // Use whichever is present so we don't break across versions.
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

  function flashClickMarker(viewportX: number, viewportY: number): void {
    const marker = clickMarkerRef.current;
    if (marker === null) return;
    marker.style.left = `${(viewportX - 12).toString()}px`;
    marker.style.top = `${(viewportY - 12).toString()}px`;
    marker.style.opacity = '1';
    marker.style.transform = 'scale(1)';
    // Trigger a CSS transition out.
    window.setTimeout(() => {
      marker.style.opacity = '0';
      marker.style.transform = 'scale(2.5)';
    }, 30);
  }

  function handleTextLayerDoubleClick(e: React.MouseEvent<HTMLDivElement>): void {
    if (onInverseSync === undefined) return;
    const viewport = viewportRef.current;
    const container = textLayerRef.current;
    if (viewport === null || container === null) return;
    const rect = container.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    flashClickMarker(vx, vy);
    // pdf.js types declare this as any[]; it's actually a [x, y] tuple of numbers.
    const pdfPoint: number[] = viewport.convertToPdfPoint(vx, vy) as number[];
    const pdfX = pdfPoint[0] ?? 0;
    const pdfYBottomUp = pdfPoint[1] ?? 0;
    // SyncTeX `v` is measured top-down from page origin; pdf.js's PDF
    // coords are bottom-up. Flip y before handing it to lookupInverse.
    const pageHeight = pdfPageHeight(viewport);
    const pdfYTopDown = pageHeight - pdfYBottomUp;
    onInverseSync(pageNumber, pdfX, pdfYTopDown);
  }

  if (url === null && !compiling) {
    return (
      <div className="flex h-full items-center justify-center bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        {t('compile.noPdf')}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-muted/30">
      <div className="flex items-center gap-2 border-b bg-background px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('compile.prevPage')}
          onClick={() => { setPageNumber((p) => Math.max(1, p - 1)); }}
          disabled={pageNumber <= 1 || loading}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground">
          {pageNumber} / {pageCount || '—'}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('compile.nextPage')}
          onClick={() => { setPageNumber((p) => Math.min(pageCount, p + 1)); }}
          disabled={pageNumber >= pageCount || loading}
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
        <div className="mx-2 h-4 w-px bg-border" />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('compile.zoomOut')}
          onClick={() => { setZoomIndex((i) => Math.max(0, i - 1)); }}
          disabled={zoomIndex === 0}
        >
          <ZoomOut className="h-4 w-4" aria-hidden="true" />
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground">
          {Math.round((ZOOM_LEVELS[zoomIndex] ?? 1) * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('compile.zoomIn')}
          onClick={() => { setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1)); }}
          disabled={zoomIndex === ZOOM_LEVELS.length - 1}
        >
          <ZoomIn className="h-4 w-4" aria-hidden="true" />
        </Button>
        {compiling ? (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            {t('compile.running')}
          </span>
        ) : null}
      </div>
      <div className="relative flex-1 overflow-auto p-4">
        {loading ? (
          <Skeleton className="h-[840px] w-[612px] mx-auto" />
        ) : error !== null ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : url === null ? null : (
          <div className="relative mx-auto inline-block shadow-md">
            <canvas ref={canvasRef} aria-label={t('compile.pdfCanvas')} />
            <div
              ref={textLayerRef}
              onDoubleClick={handleTextLayerDoubleClick}
              title={t('compile.inverseSyncHint')}
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
                display: 'none',
                pointerEvents: 'none',
                backgroundColor: 'rgba(255, 220, 0, 0.4)',
                border: '1px solid rgba(255, 180, 0, 0.8)',
                transition: 'opacity 200ms',
              }}
            />
            <div
              ref={clickMarkerRef}
              aria-hidden="true"
              style={{
                position: 'absolute',
                width: 24,
                height: 24,
                borderRadius: 9999,
                pointerEvents: 'none',
                opacity: 0,
                backgroundColor: 'rgba(59, 130, 246, 0.5)',
                border: '2px solid rgba(59, 130, 246, 0.9)',
                transition: 'opacity 400ms ease-out, transform 400ms ease-out',
                transform: 'scale(1)',
                transformOrigin: 'center center',
                zIndex: 5,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
