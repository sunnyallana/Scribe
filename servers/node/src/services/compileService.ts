import {
  type CompileJob,
  type CompileJobId,
  compileJobIdSchema,
  type CompileLogEntryDTO,
  type CompileLogStreamMessage,
  type CompilerEngine,
  type CreateCompileJobInput,
  err,
  ok,
  type ProjectId,
  type Result,
  serviceError,
  type ServiceError,
  type UserId,
} from '@scribe/shared';

import type { CompileQueue } from './compileQueue.js';
import type { Database } from '@scribe/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

import { rowToCompileJob } from './mappers.js';

export interface CompileServiceDeps {
  supabase: SupabaseClient<Database>;
  queue: CompileQueue;
  userId: UserId | null;
}

export function createCompileService({ supabase, queue, userId }: CompileServiceDeps) {
  return {
    async enqueue(
      projectId: ProjectId,
      input: CreateCompileJobInput,
    ): Promise<Result<CompileJob, ServiceError>> {
      const projectResp = await supabase
        .from('projects')
        .select('compiler, main_file')
        .eq('id', projectId)
        .single();
      if (projectResp.error !== null || projectResp.data === null) {
        if (projectResp.error?.code === 'PGRST116') {
          return err(serviceError('not_found', 'Project not found'));
        }
        return err(serviceError('internal', projectResp.error?.message ?? 'unknown error'));
      }

      const engine: CompilerEngine = projectResp.data.compiler;
      const mainFile = input.mainFile ?? projectResp.data.main_file;

      const insertPayload: Database['public']['Tables']['compile_jobs']['Insert'] = {
        project_id: projectId,
        triggered_by: userId,
        engine,
        main_file: mainFile,
        status: 'queued',
      };

      const { data, error } = await supabase
        .from('compile_jobs')
        .insert(insertPayload)
        .select('*')
        .single();
      if (error !== null || data === null) {
        return err(serviceError('internal', error?.message ?? 'failed to insert compile_job'));
      }

      const job = rowToCompileJob(data);

      try {
        await queue.enqueue({
          compileJobId: job.id,
          projectId: job.projectId,
          mainFile: job.mainFile,
          engine: job.engine,
          triggeredBy: job.triggeredBy,
        });
      } catch (e) {
        await supabase
          .from('compile_jobs')
          .update({
            status: 'error',
            error_message: e instanceof Error ? e.message : 'enqueue failed',
            completed_at: new Date().toISOString(),
          })
          .eq('id', job.id);
        return err(serviceError('internal', 'Failed to enqueue compile job'));
      }

      return ok(job);
    },

    async get(jobId: CompileJobId): Promise<Result<CompileJob, ServiceError>> {
      const { data, error } = await supabase
        .from('compile_jobs')
        .select('*')
        .eq('id', jobId)
        .single();
      if (error !== null || data === null) {
        if (error?.code === 'PGRST116') {
          return err(serviceError('not_found', 'Compile job not found'));
        }
        return err(serviceError('internal', error?.message ?? 'unknown error'));
      }
      return ok(rowToCompileJob(data));
    },

    async list(projectId: ProjectId, limit = 10): Promise<Result<CompileJob[], ServiceError>> {
      const { data, error } = await supabase
        .from('compile_jobs')
        .select('*')
        .eq('project_id', projectId)
        .order('enqueued_at', { ascending: false })
        .limit(limit);
      if (error !== null) {
        return err(serviceError('internal', error.message));
      }
      return ok(data.map(rowToCompileJob));
    },

    /**
     * Stream historical log entries for a finished job from the persisted
     * column, as a list of CompileLogStreamMessage values (status + log + completed).
     */
    async replayMessages(
      jobId: CompileJobId,
    ): Promise<Result<CompileLogStreamMessage[], ServiceError>> {
      const result = await this.get(jobId);
      if (!result.ok) return result;
      const job = result.value;
      const messages: CompileLogStreamMessage[] = [];
      messages.push({ type: 'status', status: job.status });
      for (const entry of job.entries ?? []) {
        messages.push({ type: 'log', entry });
      }
      if (job.status === 'success' || job.status === 'error' || job.status === 'cancelled') {
        messages.push({
          type: 'completed',
          status: job.status,
          pdfKey: job.pdfKey,
          logKey: job.logKey,
          synctexKey: job.synctexKey,
          durationMs: job.durationMs,
          errorMessage: job.errorMessage,
        });
      }
      return ok(messages);
    },
  };
}

export type CompileService = ReturnType<typeof createCompileService>;

export function parseCompileJobId(value: string): Result<CompileJobId, ServiceError> {
  const parsed = compileJobIdSchema.safeParse(value);
  if (!parsed.success) {
    return err(serviceError('validation_failed', 'Invalid compile job id'));
  }
  return ok(parsed.data);
}

export function isLogEntryArray(value: unknown): value is CompileLogEntryDTO[] {
  return Array.isArray(value);
}
