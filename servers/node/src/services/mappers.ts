import {
  type Comment,
  type CommentId,
  type CompileJob,
  type CompileJobId,
  type CompileLogEntryDTO,
  compileLogEntrySchema,
  type FileId,
  type MemberId,
  type Project,
  type ProjectFile,
  type ProjectId,
  type ProjectMember,
  type TableRow,
  type UserId,
} from '@scribe/shared';

export function rowToProject(row: TableRow<'projects'>): Project {
  return {
    id: row.id as ProjectId,
    name: row.name,
    description: row.description,
    ownerId: row.owner_id as UserId,
    template: row.template,
    compiler: row.compiler,
    mainFile: row.main_file,
    isPublic: row.is_public,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToFile(row: TableRow<'project_files'>): ProjectFile {
  return {
    id: row.id as FileId,
    projectId: row.project_id as ProjectId,
    path: row.path,
    type: row.type,
    sizeBytes: row.size_bytes,
    createdBy: row.created_by === null ? null : (row.created_by as UserId),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface MemberRowWithUser {
  readonly id: string;
  readonly project_id: string;
  readonly user_id: string | null;
  readonly invited_email: string | null;
  readonly role: 'owner' | 'editor' | 'commenter' | 'viewer';
  readonly invited_at: string;
  readonly invite_expires_at: string;
  readonly invite_accepted_at: string | null;
  readonly user?: {
    readonly email: string | null;
    readonly display_name: string | null;
    readonly avatar_url: string | null;
  } | null;
}

export function rowToMember(row: MemberRowWithUser): ProjectMember {
  return {
    id: row.id as MemberId,
    projectId: row.project_id as ProjectId,
    userId: row.user_id === null ? null : (row.user_id as UserId),
    email: row.user?.email ?? row.invited_email,
    displayName: row.user?.display_name ?? null,
    avatarUrl: row.user?.avatar_url ?? null,
    role: row.role,
    invitedAt: row.invited_at,
    acceptedAt: row.invite_accepted_at,
    expiresAt: row.invite_expires_at,
    pending: row.invite_accepted_at === null,
  };
}

function parseEntries(value: unknown): CompileLogEntryDTO[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: CompileLogEntryDTO[] = [];
  for (const item of value) {
    const result = compileLogEntrySchema.safeParse(item);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}

export function rowToCompileJob(row: TableRow<'compile_jobs'>): CompileJob {
  const entries = parseEntries(row.entries);
  return {
    id: row.id as CompileJobId,
    projectId: row.project_id as ProjectId,
    triggeredBy: row.triggered_by === null ? null : (row.triggered_by as UserId),
    status: row.status,
    engine: row.engine,
    mainFile: row.main_file,
    exitCode: row.exit_code,
    pdfKey: row.pdf_key,
    logKey: row.log_key,
    synctexKey: row.synctex_key,
    errorMessage: row.error_message,
    ...(entries !== undefined ? { entries } : {}),
    durationMs: row.duration_ms,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export interface CommentRowWithAuthor extends TableRow<'comments'> {
  readonly author?: { readonly display_name: string | null; readonly email: string | null } | null;
}

export function rowToComment(row: CommentRowWithAuthor): Comment {
  return {
    id: row.id as CommentId,
    projectId: row.project_id as ProjectId,
    fileId: row.file_id === null ? null : (row.file_id as FileId),
    parentId: row.parent_id === null ? null : (row.parent_id as CommentId),
    authorId: row.author_id as UserId,
    authorDisplayName: row.author?.display_name ?? row.author?.email ?? null,
    anchorLine: row.anchor_line,
    anchorColumn: row.anchor_column,
    body: row.body,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by === null ? null : (row.resolved_by as UserId),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
