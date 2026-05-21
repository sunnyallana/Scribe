import { Button, Input, Label } from '@scribe/ui';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { supabase } from '../../lib/supabase';
import { useAuthStore } from '../../stores/auth';

export function ProfileSettingsTab() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const [displayName, setDisplayName] = useState<string>('');
  const [avatarUrl, setAvatarUrl] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);

  useEffect(() => {
    if (user === null) return;
    const meta = user.user_metadata;
    setDisplayName(typeof meta.display_name === 'string' ? meta.display_name : '');
    setAvatarUrl(typeof meta.avatar_url === 'string' ? meta.avatar_url : '');
  }, [user]);

  async function save() {
    if (user === null) return;
    setSaving(true);
    try {
      const { error: authError } = await supabase.auth.updateUser({
        data: { display_name: displayName, avatar_url: avatarUrl },
      });
      if (authError !== null) throw authError;
      const { error: profileError } = await supabase
        .from('users')
        .update({ display_name: displayName, avatar_url: avatarUrl })
        .eq('id', user.id);
      if (profileError !== null) throw profileError;
      toast.success(t('settings.profile.saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="profile-email">{t('settings.profile.email')}</Label>
        <Input id="profile-email" value={user?.email ?? ''} disabled readOnly />
        <p className="text-xs text-muted-foreground">{t('settings.profile.emailHint')}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="profile-name">{t('settings.profile.displayName')}</Label>
        <Input
          id="profile-name"
          value={displayName}
          onChange={(e) => { setDisplayName(e.target.value); }}
          placeholder={t('settings.profile.displayNamePlaceholder')}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="profile-avatar">{t('settings.profile.avatarUrl')}</Label>
        <Input
          id="profile-avatar"
          type="url"
          value={avatarUrl}
          onChange={(e) => { setAvatarUrl(e.target.value); }}
          placeholder="https://…"
        />
      </div>
      <Button type="submit" disabled={saving} className="gap-1.5">
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
        {t('common.save')}
      </Button>
    </form>
  );
}
