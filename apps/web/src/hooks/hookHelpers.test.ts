// Tests for the pure helpers extracted from the hook files. We don't
// `renderHook` here — the full hooks pull in supabase / Yjs / Tauri /
// WebSocket / RTCPeerConnection and would need a tower of mocks. The
// pure helpers carry the risk-bearing logic (status mapping, base64
// chunking, SyncTeX lookup, SDP munging) without any of that scaffolding.

import { describe, expect, it } from 'vitest';

import { parseSSELine } from './useAIStream';
import {
  arrayBufferToBase64,
  desktopEngineToCompilerEngine,
  isPlainTextSource,
  mapDesktopLog,
  mapDesktopStatus,
} from './useCompileSession';
import { base64ToBytes, bytesToBase64 } from './useYjsDoc';
import { tuneOpusSdp } from './useVoiceRoom';

describe('useCompileSession · mapDesktopStatus', () => {
  it('treats `completed` as success', () => {
    expect(mapDesktopStatus('completed')).toBe('success');
  });
  it('treats `failed` and `timedout` as error', () => {
    expect(mapDesktopStatus('failed')).toBe('error');
    expect(mapDesktopStatus('timedout')).toBe('error');
  });
  it('preserves `cancelled` as its own status', () => {
    expect(mapDesktopStatus('cancelled')).toBe('cancelled');
  });
  it('treats `running` (and any unknown state) as running', () => {
    expect(mapDesktopStatus('running')).toBe('running');
  });
});

describe('useCompileSession · mapDesktopLog', () => {
  it('maps stderr lines to warning level', () => {
    const out = mapDesktopLog({ jobId: 'j', stream: 'stderr', line: 'oops' });
    expect(out.level).toBe('warning');
    expect(out.message).toBe('oops');
    expect(out.raw).toBe('oops');
  });
  it('maps stdout lines to info level', () => {
    const out = mapDesktopLog({ jobId: 'j', stream: 'stdout', line: 'OK' });
    expect(out.level).toBe('info');
  });
});

describe('useCompileSession · isPlainTextSource', () => {
  // The routing of files into "send-as-text" vs "send-as-bytes" hinges
  // on this. A regression here would mojibake every .sty / .cls in
  // the project the moment a non-UTF-8 byte sneaks in.
  it.each([
    ['main.tex', true],
    ['refs.bib', true],
    ['MAIN.TEX', true], // case-insensitive
    ['nested/sec/intro.tex', true],
    ['style.sty', false],
    ['acmart.cls', false],
    ['figs/diagram.png', false],
    ['paper.pdf', false],
    ['notes.md', false],
    ['', false],
  ])('classifies %s correctly', (path, expected) => {
    expect(isPlainTextSource(path)).toBe(expected);
  });
});

describe('useCompileSession · arrayBufferToBase64', () => {
  it('round-trips small payloads through atob', () => {
    const buf = new TextEncoder().encode('hello world').buffer;
    const b64 = arrayBufferToBase64(buf);
    expect(b64).toBe('aGVsbG8gd29ybGQ=');
    expect(atob(b64)).toBe('hello world');
  });

  it('handles binary bytes including zero and 0xFF', () => {
    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
    const b64 = arrayBufferToBase64(bytes.buffer);
    // Decode back to verify exact bytes survived the chunked encode.
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual([0x00, 0x7f, 0x80, 0xff]);
  });

  it('chunked encode produces identical output for >64 KiB payloads', () => {
    // The whole reason for the chunking is to avoid the call-stack
    // blow-up at ~64 KiB on `String.fromCharCode(...bytes)`. Verify
    // a 100 KiB buffer round-trips identically.
    const size = 100 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = i & 0xff;
    const b64 = arrayBufferToBase64(bytes.buffer);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(size);
    expect(decoded[0]).toBe(0);
    expect(decoded[size - 1]).toBe(bytes[size - 1]);
  });
});

describe('useCompileSession · desktopEngineToCompilerEngine', () => {
  it('passes through engines the shared enum knows about', () => {
    for (const engine of ['pdflatex', 'xelatex', 'lualatex', 'tectonic'] as const) {
      expect(desktopEngineToCompilerEngine(engine)).toBe(engine);
    }
  });

  it('folds the `latexmk` orchestration name to pdflatex', () => {
    // latexmk isn't a distinct binary on the SPA-side enum, so the
    // synthetic CompileJob row labels the run as pdflatex (the
    // engine the orchestrator actually drives by default).
    expect(desktopEngineToCompilerEngine('latexmk')).toBe('pdflatex');
  });

  it('defaults unknown engines to pdflatex', () => {
    expect(desktopEngineToCompilerEngine('xetex')).toBe('pdflatex');
    expect(desktopEngineToCompilerEngine('')).toBe('pdflatex');
  });
});

describe('useYjsDoc · base64 round-trip', () => {
  it('encodes then decodes back to the original bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const round = base64ToBytes(bytesToBase64(bytes));
    expect(Array.from(round)).toEqual([1, 2, 3, 4, 5]);
  });

  it('survives a 100 KiB payload (above the call-stack limit)', () => {
    const size = 100 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 7) & 0xff;
    const round = base64ToBytes(bytesToBase64(bytes));
    expect(round.length).toBe(size);
    expect(round[0]).toBe(0);
    expect(round[size - 1]).toBe(bytes[size - 1]);
  });

  it('encodes empty input to empty base64', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    expect(base64ToBytes('').length).toBe(0);
  });
});

describe('useVoiceRoom · tuneOpusSdp', () => {
  // Tiny SDP excerpt with just enough lines for the rtpmap probe. The
  // real SDP from RTCPeerConnection is ~20 m-sections long, but the
  // function only cares about the `a=rtpmap:N opus/48000/2` line.
  const SDP_WITH_OPUS = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
  ].join('\r\n');

  it('replaces an existing fmtp line with the tuned parameters', () => {
    const out = tuneOpusSdp(SDP_WITH_OPUS);
    // The new fmtp must include every tuned param.
    expect(out).toMatch(/a=fmtp:111 [^\n]*minptime=10/);
    expect(out).toMatch(/usedtx=0/);
    expect(out).toMatch(/stereo=1/);
    expect(out).toMatch(/cbr=0/);
    expect(out).toMatch(/maxaveragebitrate=\d+/);
    // And the OLD fmtp line is gone (the regex replaced it in place).
    // The old line had ONLY two params; after replace it must have all six.
    const lines = out.split('\r\n').filter((l) => l.startsWith('a=fmtp:111'));
    expect(lines).toHaveLength(1);
  });

  it('inserts a fresh fmtp when none exists', () => {
    const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 opus/48000/2'].join('\r\n');
    const out = tuneOpusSdp(sdp);
    expect(out).toMatch(/a=rtpmap:96 opus\/48000\/2/);
    expect(out).toMatch(/a=fmtp:96 [^\n]*useinbandfec=1/);
  });

  it('matches the Opus payload type discovered in rtpmap, not a hard-coded value', () => {
    // Some browsers negotiate Opus on PT 109 instead of 111. The tuner
    // must follow whatever the SDP declared, not blindly write to 111.
    const sdp = ['m=audio 9 UDP/TLS/RTP/SAVPF 109', 'a=rtpmap:109 opus/48000/2'].join('\r\n');
    const out = tuneOpusSdp(sdp);
    expect(out).toMatch(/a=fmtp:109 [^\n]*minptime=10/);
    // No leakage into a different PT.
    expect(out).not.toMatch(/a=fmtp:111/);
  });

  it('leaves the SDP unchanged when no Opus rtpmap is present', () => {
    // No Opus offered (G.711 fallback) → nothing to tune. Returning the
    // SDP verbatim keeps the rest of the negotiation intact.
    const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 0', 'a=rtpmap:0 PCMU/8000'].join('\r\n');
    expect(tuneOpusSdp(sdp)).toBe(sdp);
  });

  it('matches `Opus` case-insensitively as some legacy stacks emit it', () => {
    const sdp = ['m=audio 9 ...', 'a=rtpmap:111 Opus/48000/2'].join('\r\n');
    expect(tuneOpusSdp(sdp)).toMatch(/a=fmtp:111 /);
  });
});

describe('useAIStream · parseSSELine', () => {
  it('decodes a `text` event from a data line', () => {
    expect(parseSSELine('data: {"text":"hello"}')).toEqual({ kind: 'text', text: 'hello' });
  });

  it('decodes an `error` event from a data line', () => {
    expect(parseSSELine('data: {"error":"rate limited"}')).toEqual({
      kind: 'error',
      error: 'rate limited',
    });
  });

  it('recognises the [DONE] terminator', () => {
    expect(parseSSELine('data: [DONE]')).toEqual({ kind: 'done' });
  });

  it('skips lines that do not start with data:', () => {
    // SSE comments + `event:` / `id:` / `retry:` lines should be quietly
    // ignored so a non-JSON heartbeat upstream doesn't crash the stream.
    expect(parseSSELine('event: ping').kind).toBe('skip');
    expect(parseSSELine(': heartbeat').kind).toBe('skip');
    expect(parseSSELine('').kind).toBe('skip');
  });

  it('skips data lines with non-JSON payloads instead of throwing', () => {
    // A malformed upstream — gateway returned a plaintext error
    // mid-stream, for example — must not poison the rest of the read
    // loop. The hook logs and continues.
    expect(parseSSELine('data: not valid json {').kind).toBe('skip');
  });

  it('skips data lines whose JSON has neither text nor error', () => {
    // Forward-compat: an upstream that emits a new event kind we don't
    // recognise yet should just be dropped, not crash.
    expect(parseSSELine('data: {"kind":"warmup"}').kind).toBe('skip');
    expect(parseSSELine('data: {}').kind).toBe('skip');
  });

  it('tolerates leading/trailing whitespace around the line', () => {
    expect(parseSSELine('  data: {"text":"hi"}  ')).toEqual({ kind: 'text', text: 'hi' });
  });

  it('preserves text content verbatim (including newlines and unicode)', () => {
    // Streaming responses often arrive a token at a time; the parser
    // must not normalise whitespace or strip characters from the
    // user-facing text.
    expect(parseSSELine('data: {"text":"line1\\nline2"}')).toEqual({
      kind: 'text',
      text: 'line1\nline2',
    });
    expect(parseSSELine('data: {"text":"\\u2603"}')).toEqual({ kind: 'text', text: '☃' });
  });

  it('treats empty-text events as text events (preserves provider intent)', () => {
    // Some providers emit `{ "text": "" }` to signal start-of-stream
    // or a heartbeat. The accumulator handles "" cleanly, so we don't
    // want to lose them.
    expect(parseSSELine('data: {"text":""}')).toEqual({ kind: 'text', text: '' });
  });
});
