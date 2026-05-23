import { type Project } from '@scribe/shared';
import { Button, Separator, SheetDescription, SheetHeader, SheetTitle } from '@scribe/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { api, type ApiError } from '../../lib/api';

import { MembersPanel } from './MembersPanel';

interface ProjectSettingsSheetProps {
  readonly project: Project;
  readonly onClosed: () => void;
}

export function ProjectSettingsSheet({ project, onClosed }: ProjectSettingsSheetProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const deleteMutation = useMutation<unknown, ApiError>({
    mutationFn: () => api.projects.remove(project.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      onClosed();
      void navigate('/dashboard', { replace: true });
    },
    onError: (error) => {
      toast.error(error.body.message);
    },
  });

  const handleDelete = () => {
    if (window.confirm(t('project.deleteProjectConfirm'))) {
      deleteMutation.mutate();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="pb-4">
        <SheetTitle>{t('project.projectSettings')}</SheetTitle>
        <SheetDescription>{project.name}</SheetDescription>
      </SheetHeader>

      <Separator />

      {/* `px-1` gives the input's focus ring (`ring-offset-2` + `ring-2`,
          ~4px outside the element) room to render — otherwise the
          scroll container clips it and the input visually hugs the
          left wall of the settings sheet. `-mx-1` cancels the
          padding for the section dividers so they still touch edge
          to edge. */}
      <div className="flex-1 space-y-6 overflow-auto px-1 py-4">
        <section>
          <h3 className="mb-3 text-sm font-semibold">{t('project.members')}</h3>
          <MembersPanel projectId={project.id} />
        </section>

        <Separator />

        <section>
          <h3 className="mb-3 text-sm font-semibold text-destructive">{t('project.danger')}</h3>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            {deleteMutation.isPending
              ? t('project.deleteProjectInProgress')
              : t('project.deleteProject')}
          </Button>
        </section>
      </div>
    </div>
  );
}
