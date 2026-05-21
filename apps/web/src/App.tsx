import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  useTheme,
} from '@scribe/ui';
import { Contrast, Monitor, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Theme } from '@scribe/ui';
import type { LucideIcon } from 'lucide-react';

interface ThemeOption {
  readonly id: Theme;
  readonly icon: LucideIcon;
  readonly labelKey: string;
}

const themeOptions: readonly ThemeOption[] = [
  { id: 'light', icon: Sun, labelKey: 'theme.light' },
  { id: 'dark', icon: Moon, labelKey: 'theme.dark' },
  { id: 'high-contrast', icon: Contrast, labelKey: 'theme.highContrast' },
  { id: 'system', icon: Monitor, labelKey: 'theme.system' },
];

export function App() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>{t('appName')}</CardTitle>
          <CardDescription>{t('appTagline')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="rounded-md border border-dashed border-muted-foreground/30 p-3 text-sm text-muted-foreground">
            {t('phase0Banner')}
          </p>
          <section aria-label={t('theme.label')}>
            <h2 className="mb-2 text-sm font-medium">{t('theme.label')}</h2>
            <div className="flex flex-wrap gap-2">
              {themeOptions.map(({ id, icon: Icon, labelKey }) => (
                <Button
                  key={id}
                  variant={theme === id ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    setTheme(id);
                  }}
                  aria-pressed={theme === id}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {t(labelKey)}
                </Button>
              ))}
            </div>
          </section>
        </CardContent>
      </Card>
    </main>
  );
}
