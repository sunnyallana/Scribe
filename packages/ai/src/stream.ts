/**
 * Iterate over Server-Sent Events / NDJSON streams from a fetch Response.
 * Yields the data payload as a string, stripping the "data: " prefix for
 * SSE, or passing JSON lines through for NDJSON (Ollama).
 */
export async function* iterEventStream(
  response: Response,
  mode: 'sse' | 'ndjson',
): AsyncIterable<string> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        if (mode === 'sse') {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          yield payload;
        } else {
          yield line;
        }
      }
    }
    // Flush trailing chunk if no newline at EOF
    const last = buffer.trim();
    if (last !== '') {
      if (mode === 'sse') {
        if (last.startsWith('data:')) {
          const payload = last.slice(5).trim();
          if (payload !== '[DONE]') yield payload;
        }
      } else {
        yield last;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function safeJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}
