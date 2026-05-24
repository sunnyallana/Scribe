import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input, Label } from '@scribe/ui';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';

import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { supabase } from '../../lib/supabase';

import { AuthCardLayout } from './AuthCardLayout';
import { OAuthButtons } from './OAuthButtons';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8, { message: 'At least 8 characters' }),
  displayName: z.string().trim().min(1).max(80).optional(),
});
type Values = z.infer<typeof schema>;

export function SignupPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('auth.signUp'));
  const [sent, setSent] = useState(false);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '', displayName: '' },
  });

  const onSubmit = async (values: Values) => {
    const options: { emailRedirectTo: string; data?: { display_name: string } } = {
      emailRedirectTo: `${window.location.origin}/auth/callback`,
    };
    if (values.displayName !== undefined && values.displayName !== '') {
      options.data = { display_name: values.displayName };
    }
    const { error } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      options,
    });
    if (error !== null) {
      toast.error(error.message);
      return;
    }
    setSent(true);
  };

  return (
    <AuthCardLayout
      title={t('auth.signUp')}
      description={t('appTagline')}
      footer={
        <>
          {t('auth.alreadyHaveAccount')}{' '}
          <Link to="/login" className="font-medium text-primary hover:underline">
            {t('auth.signIn')}
          </Link>
        </>
      }
    >
      {sent ? (
        <p className="text-center text-sm text-muted-foreground">{t('auth.signupCheckEmail')}</p>
      ) : (
        <>
          <form
            onSubmit={form.handleSubmit((values) => {
              void onSubmit(values);
            })}
            className="space-y-4"
            noValidate
          >
            <div className="space-y-2">
              <Label htmlFor="displayName">{t('auth.displayName')}</Label>
              <Input
                id="displayName"
                type="text"
                autoComplete="name"
                placeholder=""
                {...form.register('displayName')}
              />
              <p className="text-xs text-muted-foreground">{t('auth.displayNameHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">{t('auth.email')}</Label>
              <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
              {form.formState.errors.email !== undefined && (
                <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                {...form.register('password')}
              />
              {form.formState.errors.password !== undefined && (
                <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {t('auth.signUp')}
            </Button>
          </form>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">{t('auth.orContinueWith')}</span>
            </div>
          </div>

          <OAuthButtons />
        </>
      )}
    </AuthCardLayout>
  );
}
