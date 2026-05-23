import { type Project } from '@scribe/shared';
import { Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@scribe/ui';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { FilePlus, FileText } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { api, type ApiError } from '../lib/api';

import { NewProjectDialog } from './dashboard/NewProjectDialog';

function useProjects() {
  return useQuery<Project[], ApiError>({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
  });
}

function ProjectCard({ project }: { project: Project }) {
  const { t } = useTranslation();
  return (
    <Link
      to={`/project/${project.id}`}
      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
    >
      <Card className="h-full transition-shadow hover:shadow-md">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="line-clamp-1 text-base">{project.name}</CardTitle>
            <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          {project.description !== null && project.description !== '' && (
            <p className="line-clamp-2">{project.description}</p>
          )}
          <p className="text-xs">
            {t('common.openProject')} ·{' '}
            {formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true })}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-32 w-full" />
      ))}
    </div>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { data: projects, isLoading, error } = useProjects();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-6">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-normal tracking-tight">{t('dashboard.title')}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('dashboard.subtitle')}</p>
        </div>
        <Button
          onClick={() => {
            setDialogOpen(true);
          }}
        >
          <FilePlus className="h-4 w-4" aria-hidden="true" />
          {t('dashboard.newProject')}
        </Button>
      </div>

      {isLoading ? (
        <DashboardSkeleton />
      ) : error !== null ? (
        <p className="text-sm text-destructive">{t('dashboard.loadError')}</p>
      ) : projects === undefined || projects.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <CardHeader>
            <CardTitle>{t('dashboard.emptyTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-6 text-sm text-muted-foreground">
              {t('dashboard.emptyDescription')}
            </p>
            <Button
              onClick={() => {
                setDialogOpen(true);
              }}
            >
              <FilePlus className="h-4 w-4" aria-hidden="true" />
              {t('dashboard.newProject')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}

      <NewProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
