import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippet,
} from '@codemirror/autocomplete';

import { latexCommands } from './commands-db.js';
import { latexSnippets } from './snippets-db.js';

import type { Extension } from '@codemirror/state';

export interface AutocompleteSources {
  /** Labels parsed from `\label{...}` calls. Refreshed by the host on every change. */
  readonly labels: readonly string[];
  /** Citation keys parsed from .bib files attached to the project. */
  readonly citations: readonly string[];
}

const COMMAND_PATTERN = /\\[a-zA-Z@]*$/;
const REF_PATTERN = /\\(?:ref|eqref|pageref|autoref)\{([a-zA-Z0-9:_-]*)$/;
const CITE_PATTERN = /\\(?:cite|citep|citet)\{([a-zA-Z0-9:_-]*(?:,\s*[a-zA-Z0-9:_-]*)*)$/;
const SNIPPET_PATTERN = /(?:^|[\s{([])([a-zA-Z*]+)$/;

function templateToSnippet(template: string): string {
  // Commands DB uses `#1`, `#2` style placeholders; convert to CM6's
  // `#{1}`, `#{2}` syntax which snippet() understands.
  return template.replace(/#(\d+)/g, '#{$1}');
}

function commandCompletions(): readonly Completion[] {
  return latexCommands.map((cmd): Completion => ({
    label: cmd.name,
    type: cmd.template !== undefined ? 'function' : 'keyword',
    ...(cmd.template !== undefined ? { apply: snippet(templateToSnippet(cmd.template)) } : {}),
    ...(cmd.category !== undefined ? { detail: cmd.category } : {}),
    ...(cmd.description !== undefined ? { info: cmd.description } : {}),
  }));
}

function snippetCompletions(): readonly Completion[] {
  return latexSnippets.map((s): Completion => ({
    label: s.trigger,
    type: 'snippet',
    detail: 'snippet',
    info: s.description,
    apply: snippet(s.body),
  }));
}

function buildLabelCompletions(labels: readonly string[]): readonly Completion[] {
  return labels.map((label) => ({ label, type: 'variable', detail: 'label' }));
}

function buildCiteCompletions(keys: readonly string[]): readonly Completion[] {
  return keys.map((key) => ({ label: key, type: 'variable', detail: 'citation' }));
}

export function createLatexAutocomplete(sources: AutocompleteSources): Extension {
  const commandList = commandCompletions();
  const snippetList = snippetCompletions();

  const completionSource = (context: CompletionContext): CompletionResult | null => {
    const refMatch = context.matchBefore(REF_PATTERN);
    if (refMatch !== null && refMatch.text !== '') {
      const startOffset = refMatch.text.lastIndexOf('{') + 1;
      return {
        from: refMatch.from + startOffset,
        options: [...buildLabelCompletions(sources.labels)],
        validFor: /^[a-zA-Z0-9:_-]*$/,
      };
    }

    const citeMatch = context.matchBefore(CITE_PATTERN);
    if (citeMatch !== null && citeMatch.text !== '') {
      const lastComma = citeMatch.text.lastIndexOf(',');
      const lastBrace = citeMatch.text.lastIndexOf('{');
      const startOffset = Math.max(lastComma, lastBrace) + 1;
      const fromAbs = citeMatch.from + startOffset;
      return {
        from: fromAbs,
        options: [...buildCiteCompletions(sources.citations)],
        validFor: /^[a-zA-Z0-9:_-]*$/,
      };
    }

    const cmdMatch = context.matchBefore(COMMAND_PATTERN);
    if (cmdMatch !== null && cmdMatch.text !== '') {
      return {
        from: cmdMatch.from,
        options: [...commandList],
        validFor: /^\\[a-zA-Z@]*$/,
      };
    }

    const snipMatch = context.matchBefore(SNIPPET_PATTERN);
    if (snipMatch !== null && snipMatch.text !== '') {
      const wordStart = snipMatch.from + snipMatch.text.search(/[a-zA-Z*]+$/);
      return {
        from: wordStart,
        options: [...snippetList],
        validFor: /^[a-zA-Z*]*$/,
      };
    }

    return null;
  };

  return autocompletion({
    override: [completionSource],
    closeOnBlur: true,
    activateOnTyping: true,
  });
}

const LABEL_REGEX = /\\label\{([^}]+)\}/g;

export function extractLabels(text: string): string[] {
  const labels: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = LABEL_REGEX.exec(text)) !== null) {
    if (match[1] !== undefined) labels.push(match[1]);
  }
  return labels;
}
