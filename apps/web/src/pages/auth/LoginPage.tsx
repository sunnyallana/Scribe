import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input, Label } from '@scribe/ui';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';

import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { supabase } from '../../lib/supabase';
import { useAuthStore } from '../../stores/auth';

import { AuthCardLayout } from './AuthCardLayout';
import { OAuthButtons } from './OAuthButtons';

const passwordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, { message: 'At least 8 characters' }),
});
type PasswordValues = z.infer<typeof passwordSchema>;

const magicLinkSchema = z.object({ email: z.string().email() });
type MagicLinkValues = z.infer<typeof magicLinkSchema>;

export function LoginPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('auth.signIn'));
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const from = params.get('from') ?? '/dashboard';
  const status = useAuthStore((state) => state.status);
  const [mode, setMode] = useState<'password' | 'magic'>('password');
  const [magicSent, setMagicSent] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') {
      void navigate(from, { replace: true });
    }
  }, [status, navigate, from]);

  const passwordForm = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { email: '', password: '' },
  });

  const magicForm = useForm<MagicLinkValues>({
    resolver: zodResolver(magicLinkSchema),
    defaultValues: { email: '' },
  });

  const onPasswordSubmit = async (values: PasswordValues) => {
    const { error } = await supabase.auth.signInWithPassword(values);
    if (error !== null) {
      toast.error(error.message);
      return;
    }
    void navigate(from, { replace: true });
  };

  const onMagicSubmit = async (values: MagicLinkValues) => {
    const { error } = await supabase.auth.signInWithOtp({
      email: values.email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error !== null) {
      toast.error(error.message);
      return;
    }
    setMagicSent(true);
  };

  return (
    <AuthCardLayout
      title={t('auth.signIn')}
      description={t('appTagline')}
      footer={
        <>
          {t('auth.newToScribe')}{' '}
          <Link to="/signup" className="font-medium text-primary hover:underline">
            {t('auth.signUp')}
          </Link>
        </>
      }
    >
      {mode === 'password' ? (
        <form
          onSubmit={passwordForm.handleSubmit((values) => {
            void onPasswordSubmit(values);
          })}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="email">{t('auth.email')}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              {...passwordForm.register('email')}
              aria-invalid={passwordForm.formState.errors.email !== undefined}
            />
            {passwordForm.formState.errors.email !== undefined && (
              <p className="text-xs text-destructive">
                {passwordForm.formState.errors.email.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Link to="/forgot" className="text-xs text-muted-foreground hover:underline">
                {t('auth.forgotPassword')}
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              {...passwordForm.register('password')}
              aria-invalid={passwordForm.formState.errors.password !== undefined}
            />
            {passwordForm.formState.errors.password !== undefined && (
              <p className="text-xs text-destructive">
                {passwordForm.formState.errors.password.message}
              </p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={passwordForm.formState.isSubmitting}>
            {passwordForm.formState.isSubmitting && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {t('auth.signIn')}
          </Button>
        </form>
      ) : magicSent ? (
        <p className="text-center text-sm text-muted-foreground">{t('auth.magicLinkSent')}</p>
      ) : (
        <form
          onSubmit={magicForm.handleSubmit((values) => {
            void onMagicSubmit(values);
          })}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="magic-email">{t('auth.email')}</Label>
            <Input
              id="magic-email"
              type="email"
              autoComplete="email"
              {...magicForm.register('email')}
            />
            {magicForm.formState.errors.email !== undefined && (
              <p className="text-xs text-destructive">
                {magicForm.formState.errors.email.message}
              </p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={magicForm.formState.isSubmitting}>
            {magicForm.formState.isSubmitting && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {t('auth.signIn')}
          </Button>
        </form>
      )}

      <button
        type="button"
        onClick={() => {
          setMode((m) => (m === 'password' ? 'magic' : 'password'));
          setMagicSent(false);
        }}
        className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:underline"
      >
        {mode === 'password' ? t('auth.useMagicLink') : t('auth.useEmailPassword')}
      </button>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-2 text-muted-foreground">{t('auth.orContinueWith')}</span>
        </div>
      </div>

      <OAuthButtons />
    </AuthCardLayout>
  );
}
