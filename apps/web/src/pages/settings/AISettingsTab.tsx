import {
  type AIConfigPublic,
  type AIPingResult,
  type AIProvider,
  type UpdateAIConfigInput,
  AI_DEFAULT_MODELS,
  AI_PROVIDER_NEEDS_BASE_URL,
  aiProviderSchema,
} from '@scribe/shared';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@scribe/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api, type ApiError } from '../../lib/api';

const PROVIDERS = aiProviderSchema.options;

const PROVIDER_LABEL: Record<AIProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
  ollama: 'Ollama (local)',
  lmstudio: 'LM Studio (local)',
  'openai-compatible': 'OpenAI-compatible',
};

export function AISettingsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const configQuery = useQuery<AIConfigPublic | null, ApiError>({
    queryKey: ['ai-config'],
    queryFn: () => api.ai.getConfig(),
  });

  const [provider, setProvider] = useState<AIProvider>('openai');
  const [model, setModel] = useState<string>('gpt-4o');
  const [baseUrl, setBaseUrl] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [pingResult, setPingResult] = useState<AIPingResult | null>(null);

  useEffect(() => {
    if (configQuery.data === null || configQuery.data === undefined) return;
    setProvider(configQuery.data.provider);
    setModel(configQuery.data.model);
    setBaseUrl(configQuery.data.baseUrl ?? '');
  }, [configQuery.data]);

  // When provider changes, suggest its default model.
  const defaultModelForProvider = useMemo(() => AI_DEFAULT_MODELS[provider], [provider]);
  useEffect(() => {
    setModel((current) => (current === '' || PROVIDERS.includes(current as AIProvider) ? defaultModelForProvider : current));
  }, [defaultModelForProvider]);

  const saveMutation = useMutation<AIConfigPublic, ApiError, UpdateAIConfigInput>({
    mutationFn: (input) => api.ai.updateConfig(input),
    onSuccess: async () => {
      setApiKey('');
      toast.success(t('settings.ai.saved'));
      await queryClient.invalidateQueries({ queryKey: ['ai-config'] });
    },
    onError: (err) => { toast.error(err.body.message); },
  });

  const pingMutation = useMutation<AIPingResult, ApiError>({
    mutationFn: () => api.ai.ping(),
    onSuccess: (r) => {
      setPingResult(r);
      if (r.ok) toast.success(t('settings.ai.pingOk', { latency: r.latencyMs }));
      else toast.error(r.error ?? t('settings.ai.pingFailed'));
    },
    onError: (err) => { toast.error(err.body.message); },
  });

  const needsBaseUrl = AI_PROVIDER_NEEDS_BASE_URL[provider];
  const hasExistingKey = configQuery.data?.apiKeyPreview !== null && configQuery.data?.apiKeyPreview !== undefined;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const input: UpdateAIConfigInput = { provider, model };
    if (apiKey.length > 0) input.apiKey = apiKey;
    if (needsBaseUrl) {
      if (baseUrl.trim() === '') {
        toast.error(t('settings.ai.baseUrlRequired'));
        return;
      }
      input.baseUrl = baseUrl.trim();
    } else if (baseUrl.trim() !== '') {
      input.baseUrl = baseUrl.trim();
    } else {
      input.baseUrl = null;
    }
    saveMutation.mutate(input);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="ai-provider">{t('settings.ai.provider')}</Label>
        <Select value={provider} onValueChange={(v) => { setProvider(v as AIProvider); }}>
          <SelectTrigger id="ai-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p} value={p}>{PROVIDER_LABEL[p]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="ai-model">{t('settings.ai.model')}</Label>
        <Input
          id="ai-model"
          value={model}
          onChange={(e) => { setModel(e.target.value); }}
          placeholder={defaultModelForProvider}
        />
        <p className="text-xs text-muted-foreground">{t('settings.ai.modelHint', { defaultModel: defaultModelForProvider })}</p>
      </div>

      {needsBaseUrl ? (
        <div className="space-y-2">
          <Label htmlFor="ai-baseurl">{t('settings.ai.baseUrl')}</Label>
          <Input
            id="ai-baseurl"
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); }}
            placeholder={provider === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234/v1'}
            type="url"
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="ai-key">{t('settings.ai.apiKey')}</Label>
        <Input
          id="ai-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); }}
          placeholder={hasExistingKey ? `${configQuery.data?.apiKeyPreview ?? ''} (${t('settings.ai.keyOnFile')})` : 'sk-...'}
        />
        <p className="text-xs text-muted-foreground">
          {hasExistingKey
            ? t('settings.ai.apiKeyOnFile')
            : t('settings.ai.apiKeyEmpty')}
        </p>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" disabled={saveMutation.isPending} className="gap-1.5">
          {saveMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : null}
          {t('common.save')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pingMutation.isPending || !hasExistingKey}
          onClick={() => { pingMutation.mutate(); }}
          className="gap-1.5"
        >
          {pingMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : null}
          {t('settings.ai.testConnection')}
        </Button>
        {pingResult !== null ? (
          <span className={`flex items-center gap-1 text-xs ${pingResult.ok ? 'text-emerald-600' : 'text-destructive'}`}>
            {pingResult.ok ? (
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
            ) : (
              <XCircle className="h-3 w-3" aria-hidden="true" />
            )}
            {pingResult.ok
              ? t('settings.ai.pingOk', { latency: pingResult.latencyMs })
              : pingResult.error ?? t('settings.ai.pingFailed')}
          </span>
        ) : null}
      </div>
    </form>
  );
}
