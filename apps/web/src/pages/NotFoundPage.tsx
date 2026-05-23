import { useTranslation } from 'react-i18next';

import { PageError } from '../components/PageError/PageError';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <PageError
      title="404"
      description={t('errors.pageNotFound')}
    />
  );
}
