/**
 * One row in the SyncTeX file. Each record begins with a one-byte type
 * that tells us how to interpret the rest. Picking the right record for
 * an inverse lookup depends heavily on this — `x` (current point) marks
 * exact glyph positions, `h` is a line-level horizontal box, `(`/`[`
 * are pure structural markers with no useful geometry, etc.
 */
export type SyncTeXRecordKind = 'h' | 'v' | 'x' | 'g' | 'k' | 'a' | '(' | '[';

export interface SyncTeXRecord {
  readonly kind: SyncTeXRecordKind;
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
const BOX_LINE =
  /^([hvxgka([])\s*(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+)(?:,(-?\d+))?)?)?$/;

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
      // Capture the leading byte — `h`, `v`, `x`, `g`, `k`, `a`,
      // `(`, `[` — so the inverse-lookup ranker can prefer
      // specific kinds (e.g. `x` records mark exact glyph
      // positions; `(` and `[` are pure structural markers).
      records.push({
        kind: box[1] as SyncTeXRecordKind,
        fileId: Number(box[2]),
        line: Number(box[3]),
        page: currentPage,
        h: Number(box[4]),
        v: Number(box[5]),
        ...(box[6] !== undefined ? { width: Number(box[6]) } : {}),
        ...(box[7] !== undefined ? { height: Number(box[7]) } : {}),
        ...(box[8] !== undefined ? { depth: Number(box[8]) } : {}),
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

export interface SyncTeXSourceLocation {
  readonly filename: string;
  readonly line: number;
}

/**
 * Look up (file, line) for a PDF coordinate. `x` and `y` are in PDF
 * points (1 pt, origin top-left).
 *
 * The algorithm has *three* steps because that's how visual reading
 * actually decomposes — "which row, which column, which token":
 *
 *   1. **Filter** — drop records on other pages, drop pure-structural
 *      records (`(` and `[` carry no useful position), and apply the
 *      caller's project-file predicate so system `.cls`/`.sty` records
 *      don't pollute the candidate set.
 *
 *   2. **Snap to a visual line.** Bucket the remaining records by
 *      their `v` (baseline) coordinate using a tolerance of half a
 *      typical line-height — records within ~6 pt of each other
 *      vertically are treated as the *same* visual line. Pick the
 *      bucket whose representative `v` is closest to the click's
 *      target `v`. This first cut is decisive: once we've locked the
 *      visual line, the answer's source-line number can only come
 *      from a record in this bucket.
 *
 *   3. **Within the bucket, find the right column.** Scan records
 *      sorted by `h`:
 *        a. Prefer the RIGHTMOST record whose `h ≤ targetH` — i.e.
 *           "the token the click landed at or after". This mirrors
 *           Skim / Sumatra inverse-search: in a wrapped paragraph
 *           that spans source lines, the click should belong to the
 *           token the cursor is *inside*, not whichever neighbour
 *           happens to be euclidean-closest.
 *        b. If the click is to the left of every record (click in
 *           the line's left margin), pick the leftmost record.
 *        c. Ties on horizontal position resolve by record-kind
 *           preference: `x` (exact glyph) beats `h`/`v` (box) beats
 *           `g`/`k` (glue/kern) — `x` records are emitted at every
 *           token boundary and are therefore the source-line ground
 *           truth.
 *
 * `filter` is the multi-file accuracy lever. SyncTeX records every
 * file the engine touched — including dozens of system .cls / .sty /
 * .fd files whose records form the outer page layout (title blocks,
 * column rules, headers). When the caller passes a project-file
 * predicate, the entire system-file fleet is removed up-front so the
 * remaining records (necessarily from user source) localise the
 * click to the exact user-written line.
 */
export function lookupInverse(
  index: SyncTeXIndex,
  page: number,
  x: number,
  y: number,
  filter?: (filename: string) => boolean,
): SyncTeXSourceLocation | null {
  const targetH = x * SP_PER_PT - index.xOffset;
  const targetV = y * SP_PER_PT - index.yOffset;

  // Records of the same visual line have `v` values within this
  // tolerance. ~6 pt is half of a 12-pt line-height — large enough
  // to catch baseline jitter (subscripts, math), small enough to
  // distinguish adjacent lines.
  const LINE_BUCKET_SP = 65536 * 6; // 6 pt

  // Tiebreak preference among records sharing (visual-line, column).
  // Lower wins. `x` records carry the most precise source-line info;
  // `h`/`v` are box bounds; `g`/`k` are interstitial; `a` is a void
  // hbox (least precise).
  const KIND_RANK: Record<SyncTeXRecordKind, number> = {
    x: 0,
    h: 1,
    v: 2,
    g: 3,
    k: 3,
    a: 4,
    '(': Infinity,
    '[': Infinity,
  };

  // ---- Step 1: filter ----
  // One pass through the records to gather what survives. Cheap —
  // we already iterate everything below anyway.
  const candidates: SyncTeXRecord[] = [];
  for (const record of index.records) {
    if (record.page !== page) continue;
    if (!Number.isFinite(KIND_RANK[record.kind])) continue;
    if (filter !== undefined) {
      const filename = index.files.get(record.fileId);
      if (filename === undefined || !filter(filename)) continue;
    }
    candidates.push(record);
  }
  const first = candidates[0];
  if (first === undefined) return null;

  // ---- Step 2: snap to a visual line ----
  // Find the record whose `v` is closest to targetV; its `v` becomes
  // the bucket centre, and every record within LINE_BUCKET_SP of
  // that `v` is in the same bucket. This is more robust than a fixed
  // grid because line spacing varies (math display lines, headings,
  // figure captions) — we let the doc define its own line positions.
  let pivotV = first.v;
  let pivotVdist = Math.abs(pivotV - targetV);
  for (const record of candidates) {
    const d = Math.abs(record.v - targetV);
    if (d < pivotVdist) {
      pivotV = record.v;
      pivotVdist = d;
    }
  }
  const bucket = candidates.filter((r) => Math.abs(r.v - pivotV) <= LINE_BUCKET_SP);

  // ---- Step 3: within bucket, find the right column ----
  // (a) Rightmost record with h <= targetH wins (we landed *into*
  //     this token). (b) If no record has h <= targetH (click was
  //     to the left of all of them), pick the leftmost. (c) Ties on
  //     h resolve by kind rank.
  let best: SyncTeXRecord | null = null;
  let bestH = -Infinity; // for (a)
  let bestRankAtBestH = Infinity;
  let leftmost: SyncTeXRecord | null = null; // for (b)
  let leftmostH = Infinity;
  for (const record of bucket) {
    if (record.h <= targetH) {
      const rank = KIND_RANK[record.kind];
      if (record.h > bestH || (record.h === bestH && rank < bestRankAtBestH)) {
        best = record;
        bestH = record.h;
        bestRankAtBestH = rank;
      }
    }
    if (record.h < leftmostH) {
      leftmost = record;
      leftmostH = record.h;
    }
  }
  const winner = best ?? leftmost;
  if (winner === null) return null;
  const filename = index.files.get(winner.fileId);
  if (filename === undefined) return null;
  return { filename, line: winner.line };
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
