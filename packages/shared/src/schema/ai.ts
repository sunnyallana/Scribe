import { z } from 'zod';

export const aiProviderSchema = z.enum([
  'openai',
  'anthropic',
  'gemini',
  'ollama',
  'lmstudio',
  'openai-compatible',
]);
export type AIProvider = z.infer<typeof aiProviderSchema>;

export const aiFeatureSchema = z.enum([
  'improve-writing',
  'fix-error',
  'expand-section',
  'summarize',
  'translate',
  'generate-equation',
  'recognize-equation',
  'explain-command',
  'complete-sentence',
  'caption',
  'grammar',
  'bib-suggest',
  'chat',
]);
export type AIFeature = z.infer<typeof aiFeatureSchema>;

/** Persisted public-facing AI configuration (no API key — that's encrypted server-side). */
export const aiConfigPublicSchema = z.object({
  provider: aiProviderSchema,
  model: z.string().min(1).max(100),
  baseUrl: z.string().url().nullable(),
  /** Masked preview like `sk-***1234` when a key is on file. */
  apiKeyPreview: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type AIConfigPublic = z.infer<typeof aiConfigPublicSchema>;

export const updateAIConfigInputSchema = z.object({
  provider: aiProviderSchema,
  model: z.string().trim().min(1).max(100),
  /** Optional plaintext key; if omitted, the existing key is kept as-is. */
  apiKey: z.string().min(1).max(500).optional(),
  /** Required for ollama/lmstudio/openai-compatible. */
  baseUrl: z.string().trim().url().nullable().optional(),
});
export type UpdateAIConfigInput = z.infer<typeof updateAIConfigInputSchema>;

/** A single inline image for vision features (e.g. handwriting OCR).
 *  `data` is base64 of the raw image bytes (no `data:` URL prefix). */
export const aiImageInputSchema = z.object({
  mediaType: z.string().min(1).max(100),
  data: z.string().min(1),
});
export type AIImageInput = z.infer<typeof aiImageInputSchema>;

export const aiCompleteInputSchema = z.object({
  feature: aiFeatureSchema,
  /** The user's selected text (or full doc if nothing selected). */
  selection: z.string().max(50_000).default(''),
  /** Optional additional context: target language, prompt, etc. */
  options: z.record(z.string()).optional(),
  /** For multi-turn chat. Empty for one-shot features. */
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    )
    .max(40)
    .optional(),
  /** Vision features only: a single attached image. */
  image: aiImageInputSchema.optional(),
});
export type AICompleteInput = z.infer<typeof aiCompleteInputSchema>;

export const aiPingResultSchema = z.object({
  ok: z.boolean(),
  model: z.string().nullable(),
  latencyMs: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type AIPingResult = z.infer<typeof aiPingResultSchema>;

export const AI_DEFAULT_MODELS: Readonly<Record<AIProvider, string>> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-1.5-pro',
  ollama: 'llama3',
  lmstudio: 'llama3',
  'openai-compatible': 'gpt-4o',
};

export const AI_PROVIDER_NEEDS_BASE_URL: Readonly<Record<AIProvider, boolean>> = {
  openai: false,
  anthropic: false,
  gemini: false,
  ollama: true,
  lmstudio: true,
  'openai-compatible': true,
};
