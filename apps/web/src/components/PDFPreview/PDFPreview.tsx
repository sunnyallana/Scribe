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
}

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const DEFAULT_ZOOM_INDEX = 2;

export function PDFPreview({ url, compiling, highlight }: PDFPreviewProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);

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
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF');
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
        const viewport = page.getViewport({ scale });
        const ctx = canvas.getContext('2d');
        if (ctx === null) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width.toString()}px`;
        canvas.style.height = `${viewport.height.toString()}px`;
        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;

        if (highlight?.page === pageNumber) {
          drawHighlight(viewport, highlight);
        } else {
          clearHighlight();
        }
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
  }, [pageNumber, zoomIndex, highlight]);

  function drawHighlight(
    viewport: pdfjs.PageViewport,
    h: NonNullable<PDFPreviewProps['highlight']>,
  ): void {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    // SyncTeX gives top-left in PDF units; pdf.js's viewport.convertToViewportPoint
    // accepts (x, y) and returns viewport coords. The types from pdfjs-dist
    // declare it as `any[]`; we know it's a [x, y] tuple of numbers.
    const point: number[] = viewport.convertToViewportPoint(h.x, h.y) as number[];
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
          </div>
        )}
      </div>
    </div>
  );
}
