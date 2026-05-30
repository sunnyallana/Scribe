import { describe, expect, it } from 'vitest';

import { imageInputFromDataUrl } from './dataUrl';

describe('imageInputFromDataUrl', () => {
  it('parses a base64 PNG data URL', () => {
    expect(imageInputFromDataUrl('data:image/png;base64,QUJD')).toEqual({
      mediaType: 'image/png',
      data: 'QUJD',
    });
  });

  it('parses a jpeg data URL', () => {
    expect(imageInputFromDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toEqual({
      mediaType: 'image/jpeg',
      data: '/9j/4AAQ',
    });
  });

  it('returns null for non-data URLs', () => {
    expect(imageInputFromDataUrl('https://example.com/x.png')).toBeNull();
  });

  it('returns null for data URLs that are not base64', () => {
    expect(imageInputFromDataUrl('data:image/png,raw')).toBeNull();
  });

  it('returns null when the payload is empty', () => {
    expect(imageInputFromDataUrl('data:image/png;base64,')).toBeNull();
  });
});
