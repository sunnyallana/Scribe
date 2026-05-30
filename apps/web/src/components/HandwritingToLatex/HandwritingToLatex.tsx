import { type AIImageInput } from '@scribe/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@scribe/ui';
import { Check, Image as ImageIcon, Loader2, PenLine, Trash2, Undo2, Upload } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useAIStream } from '../../hooks/useAIStream';

import { imageInputFromDataUrl } from './dataUrl';

/** Logical drawing-surface size. The backing store is scaled by the device
 *  pixel ratio for crisp ink; pointer coordinates are mapped back into this
 *  space so the capture works at any displayed size. */
const CANVAS_W = 560;
const CANVAS_H = 240;
/** Cap the longest side of uploaded images. Keeps payloads small and stays
 *  within typical provider per-image limits. */
const MAX_IMAGE_DIM = 1568;
const INK = '#111827';
const INK_WIDTH = 2.5;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface HandwritingToLatexProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onInsert: (latex: string) => void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('file read failed'));
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      reject(new Error('image decode failed'));
    };
    img.src = src;
  });
}

/** Read a user-provided file, downscale it onto a white background, and
 *  return the API image shape. Falls back to the raw data URL if a 2D
 *  context isn't available. */
async function imageInputFromFile(file: File): Promise<AIImageInput | null> {
  const dataUrl = await readFileAsDataUrl(file);
  let img: HTMLImageElement;
  try {
    img = await loadImage(dataUrl);
  } catch {
    return imageInputFromDataUrl(dataUrl);
  }
  const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return imageInputFromDataUrl(dataUrl);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return imageInputFromDataUrl(canvas.toDataURL('image/png'));
}

export function HandwritingToLatex({ open, onOpenChange, onInsert }: HandwritingToLatexProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'draw' | 'upload'>('draw');
  const [uploaded, setUploaded] = useState<AIImageInput | null>(null);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [latex, setLatex] = useState('');
  const stream = useAIStream();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const strokesRef = useRef<Point[][]>([]);
  const drawingRef = useRef(false);

  const redraw = useCallback(() => {
    const ctx = canvasRef.current?.getContext('2d') ?? null;
    if (ctx === null) return;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.restore();
    ctx.strokeStyle = INK;
    ctx.lineWidth = INK_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of strokesRef.current) {
      const first = stroke[0];
      if (first === undefined) continue;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < stroke.length; i += 1) {
        const p = stroke[i];
        if (p !== undefined) ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }, []);

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(CANVAS_W * dpr);
    canvas.height = Math.round(CANVAS_H * dpr);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }, [redraw]);

  // (Re)initialise the canvas whenever the Draw tab becomes visible.
  useEffect(() => {
    if (open && tab === 'draw') setupCanvas();
  }, [open, tab, setupCanvas]);

  // Keep the editable result in sync with the streamed tokens. After the
  // stream finishes, `stream.text` is stable so user edits stick.
  useEffect(() => {
    setLatex(stream.text);
  }, [stream.text]);

  // Reset everything when the dialog closes.
  useEffect(() => {
    if (!open) {
      setTab('draw');
      setUploaded(null);
      setHasDrawn(false);
      setLatex('');
      strokesRef.current = [];
      stream.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const image = await imageInputFromFile(file);
    if (image !== null) {
      setUploaded(image);
      setTab('upload');
    }
  }, []);

  // Paste an image from the clipboard while the dialog is open.
  useEffect(() => {
    if (!open) return undefined;
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (items === undefined) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file !== null) {
            e.preventDefault();
            void handleFile(file);
            break;
          }
        }
      }
    }
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('paste', onPaste);
    };
  }, [open, handleFile]);

  function pointerPos(e: ReactPointerEvent<HTMLCanvasElement>): Point {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const scaleY = CANVAS_H / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    strokesRef.current.push([pointerPos(e)]);
    setHasDrawn(true);
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const stroke = strokesRef.current[strokesRef.current.length - 1];
    if (stroke === undefined) return;
    const prev = stroke[stroke.length - 1];
    const next = pointerPos(e);
    stroke.push(next);
    const ctx = e.currentTarget.getContext('2d');
    if (ctx === null || prev === undefined) return;
    ctx.strokeStyle = INK;
    ctx.lineWidth = INK_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
  }

  function endStroke(e: ReactPointerEvent<HTMLCanvasElement>) {
    drawingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function clearCanvas() {
    strokesRef.current = [];
    setHasDrawn(false);
    redraw();
  }

  function undoStroke() {
    strokesRef.current.pop();
    setHasDrawn(strokesRef.current.length > 0);
    redraw();
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file !== undefined) void handleFile(file);
    e.target.value = '';
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file !== undefined) void handleFile(file);
  }

  const canConvert = tab === 'upload' ? uploaded !== null : hasDrawn;

  function handleConvert() {
    let image: AIImageInput | null = null;
    if (tab === 'upload') {
      image = uploaded;
    } else {
      const canvas = canvasRef.current;
      if (canvas !== null && hasDrawn) {
        image = imageInputFromDataUrl(canvas.toDataURL('image/png'));
      }
    }
    if (image === null) return;
    setLatex('');
    void stream.run({ feature: 'recognize-equation', selection: '', image });
  }

  function handleInsert() {
    const value = latex.trim();
    if (value.length === 0) return;
    onInsert(value);
    onOpenChange(false);
  }

  const uploadedPreview =
    uploaded !== null ? `data:${uploaded.mediaType};base64,${uploaded.data}` : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="h-4 w-4" aria-hidden="true" />
            {t('handwriting.title')}
          </DialogTitle>
          <DialogDescription>{t('handwriting.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-1" role="tablist" aria-label={t('handwriting.title')}>
            <Button
              type="button"
              size="sm"
              variant={tab === 'draw' ? 'default' : 'ghost'}
              role="tab"
              aria-selected={tab === 'draw'}
              className="gap-1.5"
              onClick={() => {
                setTab('draw');
              }}
            >
              <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
              {t('handwriting.tabDraw')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={tab === 'upload' ? 'default' : 'ghost'}
              role="tab"
              aria-selected={tab === 'upload'}
              className="gap-1.5"
              onClick={() => {
                setTab('upload');
              }}
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              {t('handwriting.tabUpload')}
            </Button>
          </div>

          {tab === 'draw' ? (
            <div className="space-y-2">
              <canvas
                ref={canvasRef}
                aria-label={t('handwriting.title')}
                className="h-[240px] w-full max-w-[560px] touch-none rounded-md border bg-white"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={endStroke}
                onPointerLeave={endStroke}
                onPointerCancel={endStroke}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  onClick={undoStroke}
                  disabled={!hasDrawn}
                >
                  <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('handwriting.undo')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  onClick={clearCanvas}
                  disabled={!hasDrawn}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('handwriting.clear')}
                </Button>
              </div>
            </div>
          ) : (
            <div
              onDrop={onDrop}
              onDragOver={(e) => {
                e.preventDefault();
              }}
              className="flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-md border border-dashed p-4 text-center"
            >
              {uploadedPreview !== null ? (
                <img
                  src={uploadedPreview}
                  alt={t('handwriting.title')}
                  className="max-h-[200px] max-w-full rounded border bg-white object-contain"
                />
              ) : (
                <>
                  <ImageIcon className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                  <p className="text-xs text-muted-foreground">{t('handwriting.uploadHint')}</p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={onFileChange}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  fileInputRef.current?.click();
                }}
              >
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                {uploadedPreview !== null ? t('handwriting.replace') : t('handwriting.uploadCta')}
              </Button>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            {stream.streaming ? (
              <Button variant="ghost" size="sm" onClick={stream.cancel} className="gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                {t('handwriting.converting')}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleConvert}
                disabled={!canConvert}
                className="gap-1.5"
                title={!canConvert ? t('handwriting.empty') : undefined}
              >
                <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
                {t('handwriting.convert')}
              </Button>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="handwriting-result">
              {t('handwriting.resultLabel')}
            </label>
            <textarea
              id="handwriting-result"
              name="handwriting-result"
              value={latex}
              readOnly={stream.streaming}
              onChange={(e) => {
                setLatex(e.target.value);
              }}
              placeholder={t('handwriting.resultPlaceholder')}
              className="min-h-[96px] w-full resize-y rounded-md border bg-muted/30 p-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {stream.error !== null ? (
            <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
              {stream.error}
            </p>
          ) : null}

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={handleInsert}
              disabled={stream.streaming || latex.trim().length === 0}
              className="gap-1.5"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {t('handwriting.insert')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
