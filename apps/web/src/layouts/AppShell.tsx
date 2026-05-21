import { Button } from '@scribe/ui';
import { LogOut, Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useNavigate } from 'react-router-dom';

import { useAuthStore } from '../stores/auth';

export function AppShell() {
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const signOut = useAuthStore((state) => state.signOut);
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    void navigate('/login', { replace: true });
  };

  const metaName: unknown = user?.user_metadata.display_name;
  const displayName: string =
    typeof metaName === 'string' && metaName !== '' ? metaName : (user?.email ?? '');

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="container flex h-14 items-center justify-between">
          <Link to="/dashboard" className="flex items-center gap-2 font-semibold">
            <span className="text-lg tracking-tight">{t('appName')}</span>
          </Link>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {displayName}
            </span>
            <Button variant="ghost" size="icon" asChild aria-label={t('settings.title')}>
              <Link to="/settings">
                <SettingsIcon className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                void handleSignOut();
              }}
              aria-label={t('auth.signOut')}
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
