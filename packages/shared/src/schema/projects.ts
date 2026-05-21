import { z } from 'zod';

import { projectIdSchema, userIdSchema } from './ids.js';

export const compilerEngineSchema = z.enum(['tectonic', 'pdflatex', 'xelatex', 'lualatex']);
export type CompilerEngine = z.infer<typeof compilerEngineSchema>;

export const projectTemplateSchema = z.enum([
  'blank',
  'article',
  'report',
  'beamer',
  'cv',
  'letter',
]);
export type ProjectTemplate = z.infer<typeof projectTemplateSchema>;

export const projectSchema = z.object({
  id: projectIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  ownerId: userIdSchema,
  template: z.string(),
  compiler: compilerEngineSchema,
  mainFile: z.string(),
  isPublic: z.boolean(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  description: z.string().max(2000).optional(),
  template: projectTemplateSchema.default('blank'),
  compiler: compilerEngineSchema.default('tectonic'),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const updateProjectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable(),
    compiler: compilerEngineSchema,
    mainFile: z.string().min(1).max(500),
    isPublic: z.boolean(),
  })
  .partial();
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;

export const projectListResponseSchema = z.object({
  items: z.array(projectSchema),
});
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
