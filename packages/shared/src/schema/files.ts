import { z } from 'zod';

import { fileIdSchema, projectIdSchema, userIdSchema } from './ids.js';

export const fileTypeSchema = z.enum(['tex', 'bib', 'image', 'other']);
export type FileType = z.infer<typeof fileTypeSchema>;

const FILE_EXTENSIONS_BY_TYPE: Readonly<Record<FileType, readonly string[]>> = {
  tex: ['tex', 'sty', 'cls', 'tikz', 'latex'],
  bib: ['bib'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'eps'],
  other: [],
};

export function inferFileType(path: string): FileType {
  const lastDot = path.lastIndexOf('.');
  if (lastDot === -1) return 'other';
  const ext = path.slice(lastDot + 1).toLowerCase();
  for (const [type, extensions] of Object.entries(FILE_EXTENSIONS_BY_TYPE)) {
    if (extensions.includes(ext)) return type as FileType;
  }
  return 'other';
}

export const projectFileSchema = z.object({
  id: fileIdSchema,
  projectId: projectIdSchema,
  path: z.string(),
  type: fileTypeSchema,
  sizeBytes: z.number().int().nonnegative(),
  createdBy: userIdSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

const filePathSchema = z
  .string()
  .trim()
  .min(1, 'Path is required')
  .max(500)
  .refine((value) => !value.includes('..'), { message: 'Path may not contain ".."' })
  .refine((value) => !value.startsWith('/'), { message: 'Path must be relative' });

export const createFileInputSchema = z.object({
  path: filePathSchema,
  type: fileTypeSchema.optional(),
});
export type CreateFileInput = z.infer<typeof createFileInputSchema>;

export const renameFileInputSchema = z.object({
  newPath: filePathSchema,
});
export type RenameFileInput = z.infer<typeof renameFileInputSchema>;

export const fileContentInputSchema = z.object({
  content: z.string().max(20 * 1024 * 1024, 'File content too large'),
});
export type FileContentInput = z.infer<typeof fileContentInputSchema>;

export const fileContentResponseSchema = z.object({
  content: z.string(),
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type FileContentResponse = z.infer<typeof fileContentResponseSchema>;

export const fileListResponseSchema = z.object({
  items: z.array(projectFileSchema),
});
export type FileListResponse = z.infer<typeof fileListResponseSchema>;

export { filePathSchema };
