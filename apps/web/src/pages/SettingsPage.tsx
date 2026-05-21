import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@scribe/ui';
import { useTranslation } from 'react-i18next';

import { AISettingsTab } from './settings/AISettingsTab';

export function SettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="container max-w-2xl py-8">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.ai.title')}</CardTitle>
          <CardDescription>{t('settings.ai.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <AISettingsTab />
        </CardContent>
      </Card>
    </div>
  );
}
