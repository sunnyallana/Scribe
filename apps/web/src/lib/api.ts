import {
  type AcceptInviteResponse,
  type AIConfigPublic,
  type AIPingResult,
  type Comment,
  type CommentId,
  type CompileJob,
  type CompileJobId,
  type CreateCommentInput,
  type CreateCompileJobInput,
  type CreateProjectInput,
  type CreateVersionInput,
  type FileId,
  type InviteDetails,
  type InviteMemberInput,
  type InviteToken,
  type MemberId,
  type Project,
  type ProjectFile,
  type ProjectId,
  type ProjectMember,
  type ProjectVersion,
  type RenameFileInput,
  type ServiceError,
  type UpdateAIConfigInput,
  type UpdateCommentInput,
  type UpdateMemberRoleInput,
  type UpdateProjectInput,
  type VersionId,
  type VersionPayload,
} from '@scribe/shared';

import { API_URL, supabase } from './supabase';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ServiceError,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const headers = new Headers(init.headers);
  if (session !== null) {
    headers.set('Authorization', `Bearer ${session.access_token}`);
  }
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!response.ok) {
    let body: ServiceError;
    try {
      body = (await response.json()) as ServiceError;
    } catch {
      body = { code: 'internal', message: response.statusText };
    }
    throw new ApiError(response.status, body);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

export const api = {
  auth: {
    me: (): Promise<UserProfile> => fetchJson('/api/auth/me'),
  },
  projects: {
    list: (): Promise<Project[]> => fetchJson('/api/projects'),
    get: (id: ProjectId): Promise<Project> => fetchJson(`/api/projects/${id}`),
    create: (input: CreateProjectInput): Promise<Project> =>
      fetchJson('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
    update: (id: ProjectId, input: UpdateProjectInput): Promise<Project> =>
      fetchJson(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    remove: (id: ProjectId): Promise<void> =>
      fetchJson(`/api/projects/${id}`, { method: 'DELETE' }),
  },
  files: {
    list: (projectId: ProjectId): Promise<ProjectFile[]> =>
      fetchJson(`/api/projects/${projectId}/files`),
    upload: async (projectId: ProjectId, path: string, file: File): Promise<ProjectFile> => {
      const formData = new FormData();
      formData.append('path', path);
      formData.append('file', file, file.name);
      return fetchJson(`/api/projects/${projectId}/files`, { method: 'POST', body: formData });
    },
    rename: (
      projectId: ProjectId,
      fileId: FileId,
      input: RenameFileInput,
    ): Promise<ProjectFile> =>
      fetchJson(`/api/projects/${projectId}/files/${fileId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    remove: (projectId: ProjectId, fileId: FileId): Promise<void> =>
      fetchJson(`/api/projects/${projectId}/files/${fileId}`, { method: 'DELETE' }),
    downloadUrl: (projectId: ProjectId, fileId: FileId): Promise<{ url: string }> =>
      fetchJson(`/api/projects/${projectId}/files/${fileId}/download-url`),
    readContent: (projectId: ProjectId, fileId: FileId): Promise<{ content: string }> =>
      fetchJson(`/api/projects/${projectId}/files/${fileId}/content`),
    writeContent: (
      projectId: ProjectId,
      fileId: FileId,
      content: string,
    ): Promise<{ path: string; sizeBytes: number; updatedAt: string }> =>
      fetchJson(`/api/projects/${projectId}/files/${fileId}/content`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }),
  },
  compiles: {
    enqueue: (projectId: ProjectId, input: CreateCompileJobInput): Promise<CompileJob> =>
      fetchJson(`/api/projects/${projectId}/compile`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    list: (projectId: ProjectId): Promise<CompileJob[]> =>
      fetchJson(`/api/projects/${projectId}/compiles`),
    get: (jobId: CompileJobId): Promise<CompileJob> =>
      fetchJson(`/api/compiles/${jobId}`),
    artifactUrl: (jobId: CompileJobId, kind: 'pdf' | 'log' | 'synctex'): Promise<{ url: string }> =>
      fetchJson(`/api/compiles/${jobId}/artifact-url?kind=${kind}`),
  },
  comments: {
    list: (projectId: ProjectId): Promise<Comment[]> =>
      fetchJson(`/api/projects/${projectId}/comments`),
    create: (projectId: ProjectId, input: CreateCommentInput): Promise<Comment> =>
      fetchJson(`/api/projects/${projectId}/comments`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (projectId: ProjectId, commentId: CommentId, input: UpdateCommentInput): Promise<Comment> =>
      fetchJson(`/api/projects/${projectId}/comments/${commentId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    remove: (projectId: ProjectId, commentId: CommentId): Promise<void> =>
      fetchJson(`/api/projects/${projectId}/comments/${commentId}`, { method: 'DELETE' }),
  },
  versions: {
    list: (projectId: ProjectId): Promise<ProjectVersion[]> =>
      fetchJson(`/api/projects/${projectId}/versions`),
    snapshot: (projectId: ProjectId, input: CreateVersionInput): Promise<ProjectVersion> =>
      fetchJson(`/api/projects/${projectId}/versions`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    get: (projectId: ProjectId, versionId: VersionId): Promise<VersionPayload> =>
      fetchJson(`/api/projects/${projectId}/versions/${versionId}`),
    restore: (projectId: ProjectId, versionId: VersionId): Promise<void> =>
      fetchJson(`/api/projects/${projectId}/versions/${versionId}/restore`, { method: 'POST' }),
  },
  ai: {
    getConfig: (): Promise<AIConfigPublic | null> => fetchJson('/api/ai/config'),
    updateConfig: (input: UpdateAIConfigInput): Promise<AIConfigPublic> =>
      fetchJson('/api/ai/config', { method: 'PUT', body: JSON.stringify(input) }),
    ping: (): Promise<AIPingResult> => fetchJson('/api/ai/ping', { method: 'POST' }),
  },
  members: {
    list: (projectId: ProjectId): Promise<ProjectMember[]> =>
      fetchJson(`/api/projects/${projectId}/members`),
    invite: (projectId: ProjectId, input: InviteMemberInput): Promise<ProjectMember> =>
      fetchJson(`/api/projects/${projectId}/members`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updateRole: (
      projectId: ProjectId,
      memberId: MemberId,
      input: UpdateMemberRoleInput,
    ): Promise<ProjectMember> =>
      fetchJson(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    remove: (projectId: ProjectId, memberId: MemberId): Promise<void> =>
      fetchJson(`/api/projects/${projectId}/members/${memberId}`, { method: 'DELETE' }),
  },
  invites: {
    details: (token: InviteToken): Promise<InviteDetails> => fetchJson(`/api/invites/${token}`),
    accept: (token: InviteToken): Promise<AcceptInviteResponse> =>
      fetchJson(`/api/invites/${token}/accept`, { method: 'POST' }),
  },
};
