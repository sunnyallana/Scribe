import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateProjectInput,
  createProjectInputSchema,
  type Project,
} from '@scribe/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@scribe/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { TemplateGallery } from '../../components/TemplateGallery/TemplateGallery';
import { api, type ApiError } from '../../lib/api';

interface NewProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function NewProjectDialog({ open, onOpenChange }: NewProjectDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const form = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectInputSchema),
    defaultValues: { name: '', description: '', template: 'blank', compiler: 'tectonic' },
  });

  const mutation = useMutation<Project, ApiError, CreateProjectInput>({
    mutationFn: (input) => api.projects.create(input),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      onOpenChange(false);
      form.reset();
      void navigate(`/project/${project.id}`);
    },
    onError: (error) => {
      toast.error(error.body.message);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('project.newTitle')}</DialogTitle>
          <DialogDescription>{t('project.newDescription')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={form.handleSubmit((values) => {
            mutation.mutate(values);
          })}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="name">{t('project.nameLabel')}</Label>
            <Input
              id="name"
              placeholder={t('project.namePlaceholder')}
              {...form.register('name')}
            />
            {form.formState.errors.name !== undefined && (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">{t('project.descriptionLabel')}</Label>
            <Input
              id="description"
              placeholder={t('project.descriptionPlaceholder')}
              {...form.register('description')}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('project.template')}</Label>
            <Controller
              control={form.control}
              name="template"
              render={({ field }) => (
                <TemplateGallery selected={field.value} onSelect={field.onChange} />
              )}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
