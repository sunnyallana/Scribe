import type { AIFeature } from '@scribe/shared';

import type { AIMessage } from './types.js';

const LATEX_SYSTEM = String.raw`You are a LaTeX writing assistant inside a collaborative editor.
Reply with LaTeX-ready text only — no markdown, no fenced code blocks, no
preamble. Preserve original commands and environments unless changing them
is the explicit point of the request. Math goes in $...$ or \[...\].`;

interface BuildPromptInput {
  readonly feature: AIFeature;
  readonly selection: string;
  readonly options: Readonly<Record<string, string>>;
  readonly history?: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
}

function basePrompt(systemAddendum: string, userBody: string): readonly AIMessage[] {
  return [
    { role: 'system', content: `${LATEX_SYSTEM}\n\n${systemAddendum}` },
    { role: 'user', content: userBody },
  ];
}

function quoted(text: string): string {
  return text.trim().length === 0 ? '(empty selection)' : text;
}

export function buildPrompt({ feature, selection, options, history }: BuildPromptInput): readonly AIMessage[] {
  switch (feature) {
    case 'improve-writing':
      return basePrompt(
        'Rewrite the user-supplied passage to be clearer, more concise, and academically appropriate. Keep all LaTeX markup intact. Do not add new sections or change citations.',
        `Improve:\n\n${quoted(selection)}`,
      );

    case 'fix-error': {
      const errorMessage = options.errorMessage ?? '';
      return basePrompt(
        'You are given a LaTeX snippet and an error message from the compiler. Output a corrected snippet only. Do not explain.',
        `Compiler error: ${errorMessage}\n\nSnippet:\n${quoted(selection)}`,
      );
    }

    case 'expand-section':
      return basePrompt(
        'Expand the passage with one or two additional paragraphs of supporting detail in the same register. Reuse existing terminology.',
        `Expand:\n\n${quoted(selection)}`,
      );

    case 'summarize':
      return basePrompt(
        'Produce a one-paragraph summary of the passage suitable for the abstract section of an academic paper.',
        `Summarize:\n\n${quoted(selection)}`,
      );

    case 'translate': {
      const target = options.targetLanguage ?? 'English';
      return basePrompt(
        `Translate the passage to ${target}. Preserve all LaTeX commands and structure.`,
        `Translate:\n\n${quoted(selection)}`,
      );
    }

    case 'generate-equation': {
      const description = options.description ?? selection;
      return basePrompt(
        'Output a single LaTeX equation (wrapped in \\[ ... \\]) that matches the description. No prose.',
        `Description: ${description}`,
      );
    }

    case 'explain-command': {
      const command = options.command ?? selection.trim();
      return basePrompt(
        'Output two short paragraphs: what the LaTeX command does, and a minimal usage example. Use LaTeX where helpful.',
        `Command: ${command}`,
      );
    }

    case 'complete-sentence':
      return basePrompt(
        'Continue the user-supplied text by completing the current sentence and one follow-up. Match tone and style. No extra commentary.',
        `Continue:\n\n${quoted(selection)}`,
      );

    case 'caption':
      return basePrompt(
        'Produce a single-line LaTeX caption (no \\caption{} wrapper) describing the figure or table content the user is preparing.',
        `Context:\n\n${quoted(selection)}`,
      );

    case 'grammar':
      return basePrompt(
        'Fix grammar, spelling, and punctuation in the passage. Output the corrected text only.',
        `Correct:\n\n${quoted(selection)}`,
      );

    case 'bib-suggest':
      return basePrompt(
        'Suggest 1–3 BibTeX entries that would be appropriate citations for the passage. Output valid BibTeX only — no commentary.',
        `Passage:\n\n${quoted(selection)}`,
      );

    case 'chat': {
      const userMessage = options.message ?? selection;
      const turns: AIMessage[] = [{ role: 'system', content: LATEX_SYSTEM }];
      for (const h of history ?? []) {
        turns.push({ role: h.role, content: h.content });
      }
      turns.push({ role: 'user', content: userMessage });
      return turns;
    }
  }
}
