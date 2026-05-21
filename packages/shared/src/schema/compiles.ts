import { z } from 'zod';

import { compilerEngineSchema } from './projects.js';
import { projectIdSchema, userIdSchema } from './ids.js';

export const compileJobIdSchema = z.string().uuid().brand<'CompileJobId'>();
export type CompileJobId = z.infer<typeof compileJobIdSchema>;

export const compileJobStatusSchema = z.enum([
  'queued',
  'running',
  'success',
  'error',
  'cancelled',
]);
export type CompileJobStatus = z.infer<typeof compileJobStatusSchema>;

export const compileLogLevelSchema = z.enum(['error', 'warning', 'info', 'debug']);
export type CompileLogLevel = z.infer<typeof compileLogLevelSchema>;

export const compileLogEntrySchema = z.object({
  level: compileLogLevelSchema,
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  raw: z.string().optional(),
});
export type CompileLogEntryDTO = z.infer<typeof compileLogEntrySchema>;

export const compileJobSchema = z.object({
  id: compileJobIdSchema,
  projectId: projectIdSchema,
  triggeredBy: userIdSchema.nullable(),
  status: compileJobStatusSchema,
  engine: compilerEngineSchema,
  mainFile: z.string(),
  exitCode: z.number().int().nullable(),
  pdfKey: z.string().nullable(),
  logKey: z.string().nullable(),
  synctexKey: z.string().nullable(),
  errorMessage: z.string().nullable(),
  entries: z.array(compileLogEntrySchema).optional(),
  durationMs: z.number().int().nonnegative().nullable(),
  enqueuedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type CompileJob = z.infer<typeof compileJobSchema>;

export const createCompileJobInputSchema = z.object({
  mainFile: z.string().min(1).max(500).optional(),
});
export type CreateCompileJobInput = z.infer<typeof createCompileJobInputSchema>;

export const compileLogStreamMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('log'), entry: compileLogEntrySchema }),
  z.object({
    type: z.literal('status'),
    status: compileJobStatusSchema,
  }),
  z.object({
    type: z.literal('completed'),
    status: compileJobStatusSchema,
    pdfKey: z.string().nullable(),
    logKey: z.string().nullable(),
    synctexKey: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    errorMessage: z.string().nullable(),
  }),
]);
export type CompileLogStreamMessage = z.infer<typeof compileLogStreamMessageSchema>;
