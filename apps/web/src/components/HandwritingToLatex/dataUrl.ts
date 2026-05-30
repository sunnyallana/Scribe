import type { AIImageInput } from '@scribe/shared';

const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s;

/** Parse a `data:<mediaType>;base64,<data>` URL into the API image shape.
 *  Returns null when the input isn't a base64 data URL or has no payload. */
export function imageInputFromDataUrl(dataUrl: string): AIImageInput | null {
  const match = DATA_URL_RE.exec(dataUrl);
  if (match === null) return null;
  const mediaType = match[1];
  const data = match[2];
  if (mediaType === undefined || data === undefined || data.length === 0) {
    return null;
  }
  return { mediaType, data };
}
