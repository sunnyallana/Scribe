import { type Project } from '@scribe/shared';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from '@scribe/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Copy, Pencil, Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { ExportMenuItems } from '../components/ProjectActions/ExportMenuItems';
import { api, type ApiError } from '../lib/api';
import { useProjectChrome } from '../stores/projectChrome';

/**
 * The center cell of the top navbar. Renders nothing outside a project
 * view; inside one, shows the project name with a click-to-open menu for
 * rename / duplicate / settings.
 */
export function ProjectNavSlot() {
  const { t } = useTranslation();
  const project = useProjectChrome((s) => s.project);
  const openSettings = useProjectChrome((s) => s.openSettings);

  if (project === null) {
    return <div className="flex-1" aria-hidden="true" />;
  }

  return (
    <div className="flex min-w-0 flex-1 justify-center">
      <ProjectMenu project={project} openSettings={openSettings} t={t} />
    </div>
  );
}

interface ProjectMenuProps {
  readonly project: Project;
  readonly openSettings: (() => void) | null;
  readonly t: (key: string) => string;
}

function ProjectMenu({ project, openSettings, t }: ProjectMenuProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [renameOpen, setRenameOpen] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftName(project.name);
  }, [project.id, project.name]);

  const renameMutation = useMutation<unknown, ApiError, string>({
    mutationFn: (name) => api.projects.update(project.id, { name }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
      ]);
      setRenameOpen(false);
      toast.success(t('project.renamed'));
    },
    onError: (err) => { toast.error(err.body.message); },
  });

  const duplicateMutation = useMutation<{ id: string }, ApiError>({
    mutationFn: () => api.projects.duplicate(project.id) as Promise<{ id: string }>,
    onSuccess: async (copied) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(t('project.duplicated'));
      void navigate(`/project/${copied.id}`);
    },
    onError: (err) => { toast.error(err.body.message); },
  });

  function submitRename() {
    const next = draftName.trim();
    if (next === '' || next === project.name) {
      setRenameOpen(false);
      return;
    }
    renameMutation.mutate(next);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="group flex max-w-[40ch] items-center gap-1.5 rounded px-2 py-1 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label={t('project.actions')}
            title={project.name}
          >
            <span className="truncate font-serif italic">{project.name}</span>
            <ChevronDown
              className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
              aria-hidden="true"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="min-w-[14rem]">
          <DropdownMenuItem
            onSelect={() => {
              setRenameOpen(true);
              // Radix returns focus to the trigger when the menu closes;
              // wait one frame so our input wins focus and gets selected.
              setTimeout(() => inputRef.current?.select(), 0);
            }}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            {t('common.rename')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              duplicateMutation.mutate();
            }}
            disabled={duplicateMutation.isPending}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            {duplicateMutation.isPending ? t('project.duplicating') : t('project.duplicate')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <ExportMenuItems />
          {openSettings !== null ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  openSettings();
                }}
              >
                <SettingsIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {t('project.projectSettings')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {renameOpen ? (
        <div
          className="fixed left-1/2 top-12 z-50 -translate-x-1/2 rounded-md border bg-popover p-2 shadow-md"
          role="dialog"
          aria-label={t('project.rename')}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitRename();
            }}
            className="flex items-center gap-2"
          >
            <Input
              ref={inputRef}
              autoFocus
              value={draftName}
              onChange={(e) => { setDraftName(e.target.value); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setRenameOpen(false);
                  setDraftName(project.name);
                }
              }}
              className="h-8 w-72"
            />
            <Button
              type="submit"
              size="sm"
              disabled={renameMutation.isPending || draftName.trim() === ''}
            >
              {renameMutation.isPending ? t('project.saving') : t('common.save')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setRenameOpen(false);
                setDraftName(project.name);
              }}
            >
              {t('common.cancel')}
            </Button>
          </form>
        </div>
      ) : null}
    </>
  );
}
