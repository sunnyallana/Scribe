export interface SyncTeXRecord {
  readonly fileId: number;
  readonly line: number;
  readonly page: number;
  /** Horizontal position in TeX scaled points (1pt = 65536 sp). */
  readonly h: number;
  /** Vertical position in TeX scaled points. */
  readonly v: number;
  readonly width?: number;
  readonly height?: number;
  readonly depth?: number;
}

export interface SyncTeXIndex {
  readonly files: ReadonlyMap<number, string>;
  /** Reverse: filename → file id. Filenames are stored verbatim from the .synctex. */
  readonly fileIdsByName: ReadonlyMap<string, number>;
  readonly records: readonly SyncTeXRecord[];
  /** Conversion factor from scaled points to PDF points (1pt). 65536 by convention. */
  readonly unit: number;
  /** Magnification (typically 1000). */
  readonly magnification: number;
  /** X offset of the page origin, in sp. */
  readonly xOffset: number;
  /** Y offset of the page origin, in sp. */
  readonly yOffset: number;
}

const INPUT_LINE = /^Input:(\d+):(.+)$/;
const UNIT_LINE = /^Unit:(\d+)$/;
const MAG_LINE = /^Magnification:(\d+)$/;
const XOFF_LINE = /^X Offset:(-?\d+)$/;
const YOFF_LINE = /^Y Offset:(-?\d+)$/;
const PAGE_OPEN = /^\{(\d+)$/;
const BOX_LINE = /^[hvxgka([]\s*(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+)(?:,(-?\d+))?)?)?$/;

/**
 * Parse a SyncTeX text body (post-gunzip) into a forward lookup index.
 * Caller is responsible for gunzipping `.synctex.gz`.
 */
export function parseSyncTeX(body: string): SyncTeXIndex {
  const files = new Map<number, string>();
  const fileIdsByName = new Map<string, number>();
  const records: SyncTeXRecord[] = [];
  let unit = 1;
  let magnification = 1000;
  let xOffset = 0;
  let yOffset = 0;
  let currentPage = 0;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;

    const input = INPUT_LINE.exec(line);
    if (input !== null) {
      const id = Number(input[1]);
      const path = input[2] ?? '';
      files.set(id, path);
      fileIdsByName.set(path, id);
      continue;
    }

    const unitM = UNIT_LINE.exec(line);
    if (unitM !== null) {
      unit = Number(unitM[1]);
      continue;
    }

    const magM = MAG_LINE.exec(line);
    if (magM !== null) {
      magnification = Number(magM[1]);
      continue;
    }

    const xM = XOFF_LINE.exec(line);
    if (xM !== null) {
      xOffset = Number(xM[1]);
      continue;
    }

    const yM = YOFF_LINE.exec(line);
    if (yM !== null) {
      yOffset = Number(yM[1]);
      continue;
    }

    const pageM = PAGE_OPEN.exec(line);
    if (pageM !== null) {
      currentPage = Number(pageM[1]);
      continue;
    }

    if (currentPage === 0) continue;

    const box = BOX_LINE.exec(line);
    if (box !== null) {
      records.push({
        fileId: Number(box[1]),
        line: Number(box[2]),
        page: currentPage,
        h: Number(box[3]),
        v: Number(box[4]),
        ...(box[5] !== undefined ? { width: Number(box[5]) } : {}),
        ...(box[6] !== undefined ? { height: Number(box[6]) } : {}),
        ...(box[7] !== undefined ? { depth: Number(box[7]) } : {}),
      });
    }
  }

  return {
    files,
    fileIdsByName,
    records,
    unit,
    magnification,
    xOffset,
    yOffset,
  };
}

export interface SyncTeXPosition {
  readonly page: number;
  /** PDF coordinates in points (1pt), origin top-left. */
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
}

const SP_PER_PT = 65536;

/**
 * Look up the PDF position for a given (file, line). Returns the best matching
 * record — the one whose line is closest to (but not after) the requested line,
 * with the smallest page if multiple match.
 */
export function lookupForward(
  index: SyncTeXIndex,
  filename: string,
  line: number,
): SyncTeXPosition | null {
  const fileId = resolveFileId(index, filename);
  if (fileId === undefined) return null;

  let best: SyncTeXRecord | null = null;
  for (const record of index.records) {
    if (record.fileId !== fileId) continue;
    if (record.line > line) continue;
    if (best === null) {
      best = record;
      continue;
    }
    if (record.line > best.line) {
      best = record;
    } else if (record.line === best.line && record.page < best.page) {
      best = record;
    }
  }

  if (best === null) return null;

  // Convert scaled-points to PDF points.
  const x = (best.h + index.xOffset) / SP_PER_PT;
  const y = (best.v + index.yOffset) / SP_PER_PT;
  return {
    page: best.page,
    x,
    y,
    ...(best.width !== undefined ? { width: best.width / SP_PER_PT } : {}),
    ...(best.height !== undefined ? { height: best.height / SP_PER_PT } : {}),
  };
}

function resolveFileId(index: SyncTeXIndex, filename: string): number | undefined {
  const direct = index.fileIdsByName.get(filename);
  if (direct !== undefined) return direct;

  // SyncTeX often stores filenames with a leading "./" or absolute paths.
  for (const [name, id] of index.fileIdsByName) {
    if (name === filename) return id;
    if (name === `./${filename}`) return id;
    if (name.endsWith(`/${filename}`)) return id;
    if (filename.endsWith(`/${name.replace(/^\.\//, '')}`)) return id;
  }
  return undefined;
}
