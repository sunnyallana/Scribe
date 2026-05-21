import { Button } from '@scribe/ui';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">404</h1>
      <p className="text-sm text-muted-foreground">{t('errors.generic')}</p>
      <Button asChild>
        <Link to="/dashboard">{t('common.back')}</Link>
      </Button>
    </div>
  );
}
