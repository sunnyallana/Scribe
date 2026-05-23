import { Button } from '@scribe/ui';
import { LogOut, Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useNavigate } from 'react-router-dom';

import { useAuthStore } from '../stores/auth';

import { ProjectNavSlot } from './ProjectNavSlot';

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
    // h-screen + overflow-hidden on the shell so the page never produces
    // a window-level scrollbar. Pages that legitimately scroll (Dashboard,
    // Settings) do it inside `<main>` via overflow-auto below.
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="flex h-11 items-center gap-3 px-4">
          <Link
            to="/dashboard"
            className="flex shrink-0 items-baseline gap-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
          >
            <span className="font-serif text-[17px] italic leading-none tracking-tight">
              {t('appName')}
            </span>
          </Link>
          <ProjectNavSlot />
          <div className="flex shrink-0 items-center gap-1">
            <span className="hidden text-xs text-muted-foreground sm:inline">{displayName}</span>
            <Button variant="ghost" size="icon" asChild aria-label={t('settings.title')} className="h-7 w-7">
              <Link to="/settings">
                <SettingsIcon className="h-3.5 w-3.5" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                void handleSignOut();
              }}
              aria-label={t('auth.signOut')}
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
