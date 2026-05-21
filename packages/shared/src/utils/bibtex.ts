/**
 * Minimal BibTeX parser. Handles the common `@type{key, field = "value", ...}`
 * shape, balanced braces, and quoted strings. Not feature-complete (no @string,
 * no @preamble, no abbreviation expansion), but good enough for editor cite
 * autocomplete and a basic Bibliography panel.
 */

export interface BibEntry {
  readonly type: string;
  readonly key: string;
  readonly fields: Readonly<Record<string, string>>;
}

class Scanner {
  private pos = 0;
  constructor(readonly src: string) {}

  eof(): boolean {
    return this.pos >= this.src.length;
  }

  peek(): string {
    return this.src[this.pos] ?? '';
  }

  next(): string {
    const c = this.src[this.pos] ?? '';
    this.pos += 1;
    return c;
  }

  skipWhitespaceAndComments(): void {
    while (!this.eof()) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.pos += 1;
        continue;
      }
      if (c === '%') {
        while (!this.eof() && this.next() !== '\n') {
          /* skip line */
        }
        continue;
      }
      break;
    }
  }

  /** Read characters until any of the provided stops; do not consume the stop. */
  readUntil(stops: ReadonlySet<string>): string {
    let out = '';
    while (!this.eof() && !stops.has(this.peek())) {
      out += this.next();
    }
    return out;
  }

  /** Read a braced value: starts at `{` (already consumed); supports nesting. */
  readBraced(): string {
    let depth = 1;
    let out = '';
    while (!this.eof() && depth > 0) {
      const c = this.next();
      if (c === '{') {
        depth += 1;
        out += c;
      } else if (c === '}') {
        depth -= 1;
        if (depth > 0) out += c;
      } else {
        out += c;
      }
    }
    return out;
  }

  /** Read a quoted value: starts at `"` (already consumed). */
  readQuoted(): string {
    let out = '';
    while (!this.eof()) {
      const c = this.next();
      if (c === '"') break;
      if (c === '\\' && !this.eof()) {
        out += c;
        out += this.next();
        continue;
      }
      out += c;
    }
    return out;
  }
}

const FIELD_STOPS = new Set(['=', ',', '}', '\n']);
const KEY_STOPS = new Set([',', '}', ' ', '\n', '\t', '\r']);

export function parseBibTeX(input: string): BibEntry[] {
  const scanner = new Scanner(input);
  const entries: BibEntry[] = [];

  while (!scanner.eof()) {
    scanner.skipWhitespaceAndComments();
    if (scanner.eof()) break;
    if (scanner.peek() !== '@') {
      scanner.next();
      continue;
    }
    scanner.next(); // consume @

    let type = '';
    while (!scanner.eof() && /[a-zA-Z]/.test(scanner.peek())) {
      type += scanner.next();
    }
    type = type.toLowerCase();
    if (type === 'comment' || type === 'preamble' || type === 'string') {
      // Skip the body
      scanner.skipWhitespaceAndComments();
      if (scanner.peek() === '{') {
        scanner.next();
        scanner.readBraced();
      }
      continue;
    }

    scanner.skipWhitespaceAndComments();
    if (scanner.next() !== '{') continue; // malformed
    scanner.skipWhitespaceAndComments();

    const key = scanner.readUntil(KEY_STOPS).trim();
    scanner.skipWhitespaceAndComments();
    if (scanner.peek() === ',') scanner.next();

    const fields: Record<string, string> = {};

    while (!scanner.eof()) {
      scanner.skipWhitespaceAndComments();
      if (scanner.peek() === '}') {
        scanner.next();
        break;
      }
      const name = scanner.readUntil(FIELD_STOPS).trim().toLowerCase();
      scanner.skipWhitespaceAndComments();
      if (scanner.peek() !== '=') {
        // Field without value — skip rest of line
        scanner.readUntil(new Set(['\n', '}']));
        continue;
      }
      scanner.next(); // =
      scanner.skipWhitespaceAndComments();

      let value = '';
      const first = scanner.peek();
      if (first === '{') {
        scanner.next();
        value = scanner.readBraced();
      } else if (first === '"') {
        scanner.next();
        value = scanner.readQuoted();
      } else {
        // Number or bare identifier (treated as literal text).
        value = scanner.readUntil(new Set([',', '}', '\n']));
      }

      if (name.length > 0) {
        fields[name] = value.trim().replace(/\s+/g, ' ');
      }

      scanner.skipWhitespaceAndComments();
      if (scanner.peek() === ',') scanner.next();
    }

    if (key.length > 0) {
      entries.push({ type, key, fields });
    }
  }

  return entries;
}

export function bibEntryToString(entry: BibEntry): string {
  const fieldLines = Object.entries(entry.fields)
    .map(([k, v]) => `  ${k} = {${v}}`)
    .join(',\n');
  return `@${entry.type}{${entry.key},\n${fieldLines}\n}`;
}

/** Compact one-line display for a Bibliography panel row. */
export function bibEntryPreview(entry: BibEntry): string {
  const author = entry.fields.author ?? entry.fields.editor ?? '';
  const year = entry.fields.year ?? '';
  const title = entry.fields.title ?? '';
  const parts = [author, year, title].filter((p) => p.length > 0);
  return parts.join(' · ');
}
