import { buildPrompt, createAIAdapter } from '@scribe/ai';
import {
  type AICompleteInput,
  type AIConfigPublic,
  type AIPingResult,
  type AIProvider,
  AI_DEFAULT_MODELS,
  err,
  ok,
  type Result,
  serviceError,
  type ServiceError,
  type UpdateAIConfigInput,
  type UserId,
} from '@scribe/shared';

import { type CryptoBox, maskApiKey } from './encryption.js';

import type { Database, Json } from '@scribe/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

interface StoredAIConfig {
  readonly provider?: AIProvider;
  readonly model?: string;
  readonly baseUrl?: string | null;
  readonly apiKeyEncrypted?: string;
  readonly apiKeyMasked?: string;
  readonly updatedAt?: string;
}

function parseStored(raw: Json | null): StoredAIConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  // PostgREST returns Json; we trust our own writes match StoredAIConfig.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return raw as StoredAIConfig;
}

export interface AIServiceDeps {
  /** Service-role client — users.ai_config is updated server-side only. */
  supabase: SupabaseClient<Database>;
  crypto: CryptoBox;
  userId: UserId;
}

export function createAIService({ supabase, crypto, userId }: AIServiceDeps) {
  async function loadStored(): Promise<StoredAIConfig> {
    const { data, error } = await supabase
      .from('users')
      .select('ai_config')
      .eq('id', userId)
      .single();
    if (error !== null || data === null) return {};
    return parseStored(data.ai_config);
  }

  return {
    async getConfig(): Promise<Result<AIConfigPublic | null, ServiceError>> {
      const stored = await loadStored();
      if (stored.provider === undefined) return ok(null);
      return ok({
        provider: stored.provider,
        model: stored.model ?? AI_DEFAULT_MODELS[stored.provider],
        baseUrl: stored.baseUrl ?? null,
        apiKeyPreview: stored.apiKeyMasked ?? null,
        updatedAt: stored.updatedAt ?? null,
      });
    },

    async updateConfig(input: UpdateAIConfigInput): Promise<Result<AIConfigPublic, ServiceError>> {
      const existing = await loadStored();
      let apiKeyEncrypted = existing.apiKeyEncrypted;
      let apiKeyMasked = existing.apiKeyMasked;
      if (input.apiKey !== undefined) {
        apiKeyEncrypted = crypto.encrypt(input.apiKey);
        apiKeyMasked = maskApiKey(input.apiKey);
      }
      const updatedAt = new Date().toISOString();
      const stored: StoredAIConfig = {
        provider: input.provider,
        model: input.model,
        baseUrl: input.baseUrl ?? null,
        ...(apiKeyEncrypted !== undefined ? { apiKeyEncrypted } : {}),
        ...(apiKeyMasked !== undefined ? { apiKeyMasked } : {}),
        updatedAt,
      };
      const { error } = await supabase
        .from('users')
        .update({ ai_config: stored as unknown as Json })
        .eq('id', userId);
      if (error !== null) {
        return err(serviceError('internal', error.message));
      }
      return ok({
        provider: input.provider,
        model: input.model,
        baseUrl: input.baseUrl ?? null,
        apiKeyPreview: apiKeyMasked ?? null,
        updatedAt,
      });
    },

    async ping(): Promise<Result<AIPingResult, ServiceError>> {
      const stored = await loadStored();
      if (stored.provider === undefined) {
        return err(serviceError('validation_failed', 'No AI provider configured'));
      }
      const apiKey =
        stored.apiKeyEncrypted !== undefined ? crypto.decrypt(stored.apiKeyEncrypted) : '';
      const adapter = createAIAdapter({
        provider: stored.provider,
        apiKey,
        ...(stored.baseUrl !== null && stored.baseUrl !== undefined
          ? { baseUrl: stored.baseUrl }
          : {}),
      });
      const model = stored.model ?? AI_DEFAULT_MODELS[stored.provider];
      const start = Date.now();
      const result = await adapter.ping(model);
      return ok({
        ok: result.ok,
        model,
        latencyMs: Date.now() - start,
        error: result.error ?? null,
      });
    },

    /**
     * Returns a stream of text deltas built from the user's configured
     * adapter. Caller (route) is responsible for shipping the chunks over SSE.
     */
    async stream(input: AICompleteInput, abort?: AbortSignal): Promise<Result<AsyncIterable<string>, ServiceError>> {
      const stored = await loadStored();
      if (stored.provider === undefined || stored.apiKeyEncrypted === undefined) {
        return err(serviceError('validation_failed', 'AI provider not configured'));
      }
      const apiKey = crypto.decrypt(stored.apiKeyEncrypted);
      const adapter = createAIAdapter({
        provider: stored.provider,
        apiKey,
        ...(stored.baseUrl !== null && stored.baseUrl !== undefined
          ? { baseUrl: stored.baseUrl }
          : {}),
      });
      const model = stored.model ?? AI_DEFAULT_MODELS[stored.provider];
      const messages = buildPrompt({
        feature: input.feature,
        selection: input.selection,
        options: input.options ?? {},
        ...(input.history !== undefined ? { history: input.history } : {}),
      });
      return ok(
        adapter.complete({
          model,
          messages,
          ...(abort !== undefined ? { abortSignal: abort } : {}),
        }),
      );
    },
  };
}

export type AIService = ReturnType<typeof createAIService>;
