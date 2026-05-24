import { Button } from '@scribe/ui';
import { useQuery } from '@tanstack/react-query';
import { Download, Maximize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../lib/api';

import type { ProjectFile, ProjectId } from '@scribe/shared';

interface ImageViewerProps {
  readonly projectId: ProjectId;
  readonly file: ProjectFile;
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
const ZOOM_DEFAULT_IDX = 3;

/**
 * Lightweight viewer for raster images in a project (PNG, JPG, GIF,
 * WebP, SVG). The image is pulled from the file-content endpoint as
 * a blob — same auth path as the editor uses for `.tex` reads — and
 * turned into an object URL for the `<img>` element. Object URL is
 * revoked on unmount / file change to keep the browser from leaking
 * blob memory.
 *
 * The viewer ships zoom (with fit-to-pane reset), download, and a
 * "1×" button. Pan-on-drag is a single MouseEvent handler because
 * the image lives inside its own scroll container; no pinch-zoom
 * gesture handling needed.
 */
export function ImageViewer({ projectId, file }: ImageViewerProps) {
  const { t } = useTranslation();
  const [zoomIdx, setZoomIdx] = useState<number>(ZOOM_DEFAULT_IDX);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Get a signed Storage URL (5-min TTL on the server). Cached for
  // 4 minutes — well within the TTL — so re-opening the same file
  // doesn't re-roundtrip. The browser then loads the bytes directly
  // from Supabase Storage; no API hop for the image data itself.
  const urlQuery = useQuery({
    queryKey: ['file-download-url', projectId, file.id],
    queryFn: () => api.files.downloadUrl(projectId, file.id),
    staleTime: 4 * 60 * 1000,
  });
  const signedUrl = urlQuery.data?.url ?? null;
  const error = urlQuery.error instanceof Error ? urlQuery.error.message : null;

  // Reset zoom on file change so a re-opened image always starts at
  // 1×, not the previous file's zoom level.
  useEffect(() => {
    setZoomIdx(ZOOM_DEFAULT_IDX);
    setNaturalSize(null);
  }, [file.id]);

  const zoom = ZOOM_STEPS[zoomIdx] ?? 1;

  // "Fit to pane" — pick the zoom step that snaps the image inside
  // the current viewport. Useful for images that are huge or tiny
  // relative to the panel.
  const handleFit = useCallback(() => {
    const wrapper = scrollRef.current;
    if (wrapper === null || naturalSize === null) return;
    const fitScale = Math.min(
      wrapper.clientWidth / naturalSize.w,
      wrapper.clientHeight / naturalSize.h,
      1, // never upscale on fit — keeps small icons readable
    );
    // Find the closest discrete step ≤ fitScale.
    let bestIdx = 0;
    for (let i = 0; i < ZOOM_STEPS.length; i += 1) {
      if ((ZOOM_STEPS[i] ?? 0) <= fitScale) bestIdx = i;
    }
    setZoomIdx(bestIdx);
  }, [naturalSize]);

  const handleDownload = useCallback(() => {
    if (signedUrl === null) return;
    const a = document.createElement('a');
    a.href = signedUrl;
    a.download = file.path.substring(file.path.lastIndexOf('/') + 1);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [signedUrl, file.path]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b bg-background px-3 py-2">
        <span className="truncate text-sm font-medium" title={file.path}>
          {file.path}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => {
              setZoomIdx((i) => Math.max(0, i - 1));
            }}
            disabled={zoomIdx === 0}
            aria-label={t('compile.zoomOut')}
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
            onClick={() => {
              setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1));
            }}
            disabled={zoomIdx === ZOOM_STEPS.length - 1}
            aria-label={t('compile.zoomIn')}
          >
            <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => {
              setZoomIdx(ZOOM_DEFAULT_IDX);
            }}
            aria-label="1×"
            title="1×"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleFit}
            disabled={naturalSize === null}
            aria-label={t('image.fit')}
            title={t('image.fit')}
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleDownload}
            disabled={signedUrl === null}
            aria-label={t('common.download')}
            title={t('common.download')}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="scribe-scroll relative flex-1 overflow-auto">
        {error !== null ? (
          <div className="flex h-full items-center justify-center p-4 text-sm text-destructive">
            {t('image.loadFailed', { error })}
          </div>
        ) : signedUrl === null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('image.loading')}
          </div>
        ) : (
          <div className="flex min-h-full min-w-full items-center justify-center p-6">
            <img
              src={signedUrl}
              alt={file.path}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              style={{
                transform: `scale(${zoom.toString()})`,
                transformOrigin: 'center center',
                // `pixelated` for big-zoom + small images keeps PNG
                // icons crisp instead of mush; auto is right for
                // photos and SVG.
                imageRendering: zoom >= 2 ? 'pixelated' : 'auto',
                maxWidth: 'none',
                maxHeight: 'none',
                boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.06), 0 6px 16px -4px rgba(15, 23, 42, 0.18)',
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
