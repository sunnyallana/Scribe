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

export type ProjectTemplateCategory = 'general' | 'academic' | 'presentation' | 'personal';

export interface TemplateMetadata {
  readonly id: ProjectTemplate;
  readonly labelKey: string;
  readonly descriptionKey: string;
  readonly category: ProjectTemplateCategory;
  /** Two-letter monogram, used as a placeholder thumbnail. */
  readonly monogram: string;
  /** CSS color for the thumbnail background. */
  readonly accent: string;
}

export const TEMPLATE_METADATA: Readonly<Record<ProjectTemplate, TemplateMetadata>> = {
  blank: {
    id: 'blank',
    labelKey: 'project.templates.blank',
    descriptionKey: 'project.templateDescriptions.blank',
    category: 'general',
    monogram: 'Ø',
    accent: 'hsl(220 9% 60%)',
  },
  article: {
    id: 'article',
    labelKey: 'project.templates.article',
    descriptionKey: 'project.templateDescriptions.article',
    category: 'academic',
    monogram: 'Aa',
    accent: 'hsl(217 91% 60%)',
  },
  report: {
    id: 'report',
    labelKey: 'project.templates.report',
    descriptionKey: 'project.templateDescriptions.report',
    category: 'academic',
    monogram: 'Rp',
    accent: 'hsl(38 92% 50%)',
  },
  beamer: {
    id: 'beamer',
    labelKey: 'project.templates.beamer',
    descriptionKey: 'project.templateDescriptions.beamer',
    category: 'presentation',
    monogram: 'Bm',
    accent: 'hsl(266 73% 58%)',
  },
  cv: {
    id: 'cv',
    labelKey: 'project.templates.cv',
    descriptionKey: 'project.templateDescriptions.cv',
    category: 'personal',
    monogram: 'CV',
    accent: 'hsl(160 84% 39%)',
  },
  letter: {
    id: 'letter',
    labelKey: 'project.templates.letter',
    descriptionKey: 'project.templateDescriptions.letter',
    category: 'personal',
    monogram: 'Lr',
    accent: 'hsl(0 84% 60%)',
  },
};

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
