import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@scribe/ui';
import { Sparkles, Type, UserCircle2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useDocumentTitle } from '../hooks/useDocumentTitle';

import { AISettingsTab } from './settings/AISettingsTab';
import { EditorSettingsTab } from './settings/EditorSettingsTab';
import { ProfileSettingsTab } from './settings/ProfileSettingsTab';

import type { LucideIcon } from 'lucide-react';

type TabId = 'profile' | 'editor' | 'ai';

interface TabDef {
  readonly id: TabId;
  readonly icon: LucideIcon;
  readonly labelKey: string;
  readonly descriptionKey: string;
}

const TABS: readonly TabDef[] = [
  {
    id: 'profile',
    icon: UserCircle2,
    labelKey: 'settings.profile.title',
    descriptionKey: 'settings.profile.description',
  },
  {
    id: 'editor',
    icon: Type,
    labelKey: 'settings.editor.title',
    descriptionKey: 'settings.editor.description',
  },
  {
    id: 'ai',
    icon: Sparkles,
    labelKey: 'settings.ai.title',
    descriptionKey: 'settings.ai.description',
  },
];

export function SettingsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('settings.title'));
  const [active, setActive] = useState<TabId>('profile');
  const navigate = useNavigate();
  const close = useCallback(() => {
    // Prefer "back" if the user landed here from another in-app
    // route — feels natural and preserves their scroll position.
    // Fall back to the dashboard for direct-URL entry / when
    // history is empty (length 1 is just the current entry).
    if (window.history.length > 1) {
      void navigate(-1);
    } else {
      void navigate('/dashboard');
    }
  }, [navigate]);

  // Escape key as the keyboard counterpart of the X. Power-user
  // affordance that matches every modal / sheet in the app.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [close]);

  const tab = TABS.find((tt) => tt.id === active) ?? TABS[0];
  if (tab === undefined) return null;

  return (
    <div className="container max-w-3xl py-8">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common.close')}
          title={`${t('common.close')} · Esc`}
          onClick={close}
          className="h-8 w-8"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="grid grid-cols-[180px_1fr] gap-6">
        <nav className="space-y-1">
          {TABS.map((tt) => {
            const Icon = tt.icon;
            const isActive = active === tt.id;
            return (
              <button
                key={tt.id}
                type="button"
                aria-pressed={isActive}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  isActive
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/60'
                }`}
                onClick={() => {
                  setActive(tt.id);
                }}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {t(tt.labelKey)}
              </button>
            );
          })}
        </nav>
        <Card>
          <CardHeader>
            <CardTitle>{t(tab.labelKey)}</CardTitle>
            <CardDescription>{t(tab.descriptionKey)}</CardDescription>
          </CardHeader>
          <CardContent>
            {active === 'profile' ? <ProfileSettingsTab /> : null}
            {active === 'editor' ? <EditorSettingsTab /> : null}
            {active === 'ai' ? <AISettingsTab /> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
