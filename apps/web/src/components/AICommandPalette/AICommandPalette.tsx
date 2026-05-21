import { type AIFeature } from '@scribe/shared';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@scribe/ui';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAIStream } from '../../hooks/useAIStream';

interface AICommand {
  readonly feature: AIFeature;
  readonly labelKey: string;
  readonly descKey: string;
  /** If true, exposes a second text input (e.g. target language). */
  readonly optionKey?: string;
  readonly optionLabelKey?: string;
  readonly optionPlaceholder?: string;
}

const COMMANDS: readonly AICommand[] = [
  { feature: 'improve-writing', labelKey: 'ai.cmd.improve', descKey: 'ai.cmd.improveDesc' },
  { feature: 'grammar', labelKey: 'ai.cmd.grammar', descKey: 'ai.cmd.grammarDesc' },
  { feature: 'summarize', labelKey: 'ai.cmd.summarize', descKey: 'ai.cmd.summarizeDesc' },
  { feature: 'expand-section', labelKey: 'ai.cmd.expand', descKey: 'ai.cmd.expandDesc' },
  { feature: 'complete-sentence', labelKey: 'ai.cmd.complete', descKey: 'ai.cmd.completeDesc' },
  {
    feature: 'translate',
    labelKey: 'ai.cmd.translate',
    descKey: 'ai.cmd.translateDesc',
    optionKey: 'targetLanguage',
    optionLabelKey: 'ai.cmd.translateTarget',
    optionPlaceholder: 'English',
  },
  {
    feature: 'generate-equation',
    labelKey: 'ai.cmd.equation',
    descKey: 'ai.cmd.equationDesc',
    optionKey: 'description',
    optionLabelKey: 'ai.cmd.equationDescLabel',
    optionPlaceholder: 'integral of sin(x) over [0, π]',
  },
  { feature: 'caption', labelKey: 'ai.cmd.caption', descKey: 'ai.cmd.captionDesc' },
  { feature: 'bib-suggest', labelKey: 'ai.cmd.bib', descKey: 'ai.cmd.bibDesc' },
];

interface AICommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly selection: string;
  readonly onInsert: (text: string) => void;
}

export function AICommandPalette({ open, onOpenChange, selection, onInsert }: AICommandPaletteProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState<AICommand | null>(null);
  const [optionValue, setOptionValue] = useState<string>('');
  const stream = useAIStream();

  // Reset state when the palette closes.
  useEffect(() => {
    if (!open) {
      setActive(null);
      setOptionValue('');
      stream.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function startCommand(cmd: AICommand) {
    setActive(cmd);
    setOptionValue('');
    stream.reset();
    if (cmd.optionKey === undefined) {
      void stream.run({ feature: cmd.feature, selection, options: {} });
    }
  }

  function runWithOption() {
    if (active?.optionKey === undefined) return;
    void stream.run({
      feature: active.feature,
      selection,
      options: { [active.optionKey]: optionValue },
    });
  }

  function handleInsert() {
    if (stream.text.length === 0) return;
    onInsert(stream.text);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {t('ai.palette.title')}
          </DialogTitle>
          <DialogDescription>{t('ai.palette.description')}</DialogDescription>
        </DialogHeader>

        {active === null ? (
          <ul className="max-h-80 overflow-auto">
            {COMMANDS.map((cmd) => (
              <li key={cmd.feature}>
                <button
                  type="button"
                  className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-accent"
                  onClick={() => { startCommand(cmd); }}
                >
                  <div className="flex-1">
                    <div className="text-sm font-medium">{t(cmd.labelKey)}</div>
                    <div className="text-xs text-muted-foreground">{t(cmd.descKey)}</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t(active.labelKey)}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => { setActive(null); stream.reset(); }}
                aria-label={t('common.back')}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </Button>
            </div>
            {active.optionKey !== undefined && !stream.streaming && stream.text === '' ? (
              <div className="space-y-2">
                <label className="text-xs font-medium" htmlFor="ai-option">
                  {t(active.optionLabelKey ?? 'ai.palette.optionLabel')}
                </label>
                <input
                  id="ai-option"
                  className="w-full rounded-md border bg-background p-2 text-sm"
                  value={optionValue}
                  onChange={(e) => { setOptionValue(e.target.value); }}
                  placeholder={active.optionPlaceholder}
                  ref={(el) => {
                    if (el !== null) el.focus();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      runWithOption();
                    }
                  }}
                />
                <Button size="sm" onClick={runWithOption} disabled={optionValue.trim().length === 0}>
                  {t('ai.palette.run')}
                </Button>
              </div>
            ) : null}

            <div className="min-h-[120px] max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs">
              {stream.text.length === 0 && !stream.streaming ? (
                <span className="text-muted-foreground">{t('ai.palette.waiting')}</span>
              ) : (
                <>
                  {stream.text}
                  {stream.streaming ? (
                    <span className="ml-1 inline-block h-3 w-2 animate-pulse bg-foreground/40" aria-hidden="true" />
                  ) : null}
                </>
              )}
            </div>
            {stream.error !== null ? (
              <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                {stream.error}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              {stream.streaming ? (
                <Button variant="ghost" size="sm" onClick={stream.cancel} className="gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  {t('ai.palette.cancel')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleInsert}
                  disabled={stream.text.length === 0}
                  className="gap-1.5"
                >
                  <Check className="h-3 w-3" aria-hidden="true" />
                  {t('ai.palette.insert')}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
