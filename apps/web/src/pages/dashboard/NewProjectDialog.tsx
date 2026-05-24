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
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import {
  TemplateGallery,
  type TemplateSelection,
} from '../../components/TemplateGallery/TemplateGallery';
import { api, type ApiError } from '../../lib/api';

interface NewProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function NewProjectDialog({ open, onOpenChange }: NewProjectDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // The selected template — either one of the six built-ins (single
  // enum value) or a community template (full file list). The form's
  // `template` field always carries a valid built-in enum so the
  // create-project API call stays well-typed; for community
  // selections we send `blank` then seed files after creation.
  const [selection, setSelection] = useState<TemplateSelection>({ kind: 'builtin', id: 'blank' });

  const form = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectInputSchema),
    defaultValues: { name: '', description: '', template: 'blank', compiler: 'tectonic' },
  });

  const mutation = useMutation<Project, ApiError, CreateProjectInput>({
    mutationFn: async (input) => {
      // Community templates: create the project as `blank`, then seed
      // each file via api.files.create. This avoids any server-side
      // changes — the existing template loader stays untouched and
      // community content lives entirely on the client.
      if (selection.kind === 'community') {
        const created = await api.projects.create({ ...input, template: 'blank' });
        // Best-effort file seeding. If one file fails (e.g. duplicate
        // path), we keep going so the user still gets a usable project.
        for (const f of selection.template.files) {
          try {
            await api.files.create(created.id, f.path, f.content);
          } catch (err) {
             
            console.warn('community template seed failed for', f.path, err);
          }
        }
        // Update mainFile to match the template's preferred entry
        // point if it isn't already main.tex (the server defaults).
        if (selection.template.mainFile !== 'main.tex') {
          try {
            await api.projects.update(created.id, { mainFile: selection.template.mainFile });
          } catch { /* leave the default — user can change in settings */ }
        }
        return created;
      }
      return api.projects.create(input);
    },
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      onOpenChange(false);
      form.reset();
      setSelection({ kind: 'builtin', id: 'blank' });
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
                <TemplateGallery
                  selected={selection}
                  onSelect={(next) => {
                    setSelection(next);
                    // Keep the form's template field bound to a valid
                    // built-in enum value — the server expects one of
                    // the six. Community selections route through the
                    // `blank` + seed-files path in the mutation.
                    field.onChange(next.kind === 'builtin' ? next.id : 'blank');
                  }}
                />
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
