import { Button } from '@scribe/ui';
import { Loader2, Send, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAIStream } from '../../hooks/useAIStream';

interface ChatTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

interface AIChatProps {
  readonly onInsert: (text: string) => void;
  readonly onClose: () => void;
}

export function AIChat({ onInsert, onClose }: AIChatProps) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<readonly ChatTurn[]>([]);
  const [draft, setDraft] = useState<string>('');
  const stream = useAIStream();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep scroll glued to the bottom while text streams in.
  useEffect(() => {
    if (scrollRef.current === null) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [stream.text, history]);

  // When a stream completes, append the assistant turn to history.
  useEffect(() => {
    if (!stream.streaming && stream.text.length > 0) {
      // Promote streaming text into a permanent assistant turn (once).
      const last = history[history.length - 1];
      if (last?.role !== 'assistant' || last.content !== stream.text) {
        setHistory((h) => [...h, { role: 'assistant', content: stream.text }]);
        stream.reset();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.streaming]);

  function send() {
    const message = draft.trim();
    if (message.length === 0) return;
    const next: ChatTurn[] = [...history, { role: 'user', content: message }];
    setHistory(next);
    setDraft('');
    void stream.run({
      feature: 'chat',
      selection: '',
      options: { message },
      history: next.slice(0, -1).map((turn) => ({ role: turn.role, content: turn.content })),
    });
  }

  return (
    <div className="flex h-full w-96 flex-col border-l bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          {t('ai.chat.title')}
        </h3>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common.close')}
          className="h-6 w-6"
          onClick={onClose}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto p-3 space-y-3">
        {history.length === 0 && stream.text === '' ? (
          <p className="text-xs text-muted-foreground">{t('ai.chat.empty')}</p>
        ) : null}
        {history.map((turn, idx) => (
          <Turn
            key={`${turn.role}-${idx.toString()}`}
            turnRole={turn.role}
            content={turn.content}
            onInsert={onInsert}
          />
        ))}
        {stream.streaming ? (
          <Turn turnRole="assistant" content={stream.text} onInsert={onInsert} streaming />
        ) : null}
        {stream.error !== null ? (
          <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {stream.error}
          </p>
        ) : null}
      </div>

      <div className="border-t p-3 space-y-2">
        <textarea
          className="w-full rounded-md border bg-background p-2 text-xs"
          rows={3}
          placeholder={t('ai.chat.placeholder')}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
          disabled={stream.streaming}
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">{t('ai.chat.hint')}</span>
          <Button size="sm" onClick={send} disabled={stream.streaming || draft.trim().length === 0} className="gap-1.5">
            {stream.streaming ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-3 w-3" aria-hidden="true" />
            )}
            {t('ai.chat.send')}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface TurnProps {
  readonly turnRole: 'user' | 'assistant';
  readonly content: string;
  readonly streaming?: boolean;
  readonly onInsert: (text: string) => void;
}

function Turn({ turnRole, content, streaming, onInsert }: TurnProps) {
  const { t } = useTranslation();
  const isUser = turnRole === 'user';
  return (
    <div className={`rounded-md px-3 py-2 text-xs ${isUser ? 'bg-primary/10' : 'bg-muted/40'}`}>
      <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
        {isUser ? t('ai.chat.you') : t('ai.chat.assistant')}
      </div>
      <div className="whitespace-pre-wrap font-mono">
        {content}
        {streaming === true ? (
          <span className="ml-1 inline-block h-3 w-2 animate-pulse bg-foreground/40" aria-hidden="true" />
        ) : null}
      </div>
      {!isUser && content.length > 0 ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-6 px-2 text-[10px]"
          onClick={() => { onInsert(content); }}
        >
          {t('ai.chat.insert')}
        </Button>
      ) : null}
    </div>
  );
}
