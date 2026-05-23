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

import { log } from './debug';
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
  const method = init.method ?? 'GET';
  const t0 = performance.now();
  log.api(`→ ${method} ${path}`);
  try {
    const response = await fetch(`${API_URL}${path}`, { ...init, headers });
    const ms = Math.round(performance.now() - t0);
    if (!response.ok) {
      let body: ServiceError;
      try {
        body = (await response.json()) as ServiceError;
      } catch {
        body = { code: 'internal', message: response.statusText };
      }
      // 404s are typically "resource doesn't exist (yet)" — a regular
      // control-flow outcome rather than a real failure. The compile
      // synctex artifact race is the canonical example: pdf lands
      // first, the SPA polls for synctex, gets a 404, retries. Don't
      // turn that into a yellow warn on every compile. Other 4xx /
      // 5xx still log at warn so genuine misconfig stays visible.
      if (response.status === 404) {
        log.api(`← ${method} ${path} 404 (${ms}ms)`, body);
      } else {
        log.api.warn(`← ${method} ${path} ${response.status} (${ms}ms)`, body);
      }
      throw new ApiError(response.status, body);
    }
    log.api(`← ${method} ${path} ${response.status} (${ms}ms)`);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const ms = Math.round(performance.now() - t0);
    log.api.error(`✗ ${method} ${path} network error (${ms}ms)`, err);
    // Wrap raw network failures (DNS, CORS, abort, server-down) in an
    // ApiError so every `onError: (err) => err.body.message` site in
    // the SPA keeps working instead of crashing with
    // "Cannot read properties of undefined (reading 'message')".
    // `internal` is the only ServiceErrorCode that fits — there's no
    // dedicated `network` code today and adding one would mean a
    // schema/version bump.
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError(0, { code: 'internal', message: `Network error: ${message}` });
  }
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
    duplicate: (id: ProjectId, name?: string): Promise<Project> =>
      fetchJson(`/api/projects/${id}/duplicate`, {
        method: 'POST',
        body: JSON.stringify(name !== undefined ? { name } : {}),
      }),
    remove: (id: ProjectId): Promise<void> =>
      fetchJson(`/api/projects/${id}`, { method: 'DELETE' }),
  },
  files: {
    list: (projectId: ProjectId): Promise<ProjectFile[]> =>
      fetchJson(`/api/projects/${projectId}/files`),
    create: (projectId: ProjectId, path: string, content?: string): Promise<ProjectFile> =>
      fetchJson(`/api/projects/${projectId}/files`, {
        method: 'POST',
        body: JSON.stringify({ path, ...(content !== undefined ? { content } : {}) }),
      }),
    upload: async (projectId: ProjectId, path: string, file: File): Promise<ProjectFile> => {
      const formData = new FormData();
      formData.append('path', path);
      formData.append('file', file, file.name);
      return fetchJson(`/api/projects/${projectId}/files`, { method: 'POST', body: formData });
    },
    zipUrl: (projectId: ProjectId): string => `${API_URL}/api/projects/${projectId}/download`,
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
    artifactUrl: (jobId: CompileJobId, kind: 'pdf' | 'log' | 'synctex' | 'bbl'): Promise<{ url: string }> =>
      fetchJson(`/api/compiles/${jobId}/artifact-url?kind=${kind}`),
  },
  voice: {
    /** Read-only snapshot of who's currently in the project's
     *  voice room. Used by clients that aren't on the call to
     *  show a "N on call" badge. */
    peers: (projectId: ProjectId): Promise<{ peers: Array<{ connId: string; userId: string }> }> =>
      fetchJson(`/api/projects/${projectId}/voice/peers`),
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
  exports: {
    /** Server-side pandoc export. Returns the raw bytes + the
     *  download filename the server suggested via Content-Disposition.
     *  Throws an ApiError with the server's error message on failure
     *  (most commonly: pandoc not installed → 503). */
    run: async (
      projectId: ProjectId,
      format: 'md' | 'docx',
    ): Promise<{ blob: Blob; filename: string | null }> => {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = new Headers();
      if (session !== null) {
        headers.set('Authorization', `Bearer ${session.access_token}`);
      }
      const path = `/api/projects/${projectId}/export?format=${format}`;
      const t0 = performance.now();
      log.api(`→ POST ${path}`);
      const response = await fetch(`${API_URL}${path}`, { method: 'POST', headers });
      const ms = Math.round(performance.now() - t0);
      if (!response.ok) {
        let body: ServiceError;
        try {
          body = (await response.json()) as ServiceError;
        } catch {
          body = { code: 'internal', message: response.statusText };
        }
        log.api.warn(`← POST ${path} ${response.status} (${ms}ms)`, body);
        throw new ApiError(response.status, body);
      }
      log.api(`← POST ${path} ${response.status} (${ms}ms)`);
      // Parse RFC-5987 `filename*=UTF-8''<encoded>` first, then the
      // simpler `filename="..."`. The server emits both; either is fine.
      const disposition = response.headers.get('content-disposition') ?? '';
      let filename: string | null = null;
      const rfc5987 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      if (rfc5987?.[1] !== undefined) {
        try {
          filename = decodeURIComponent(rfc5987[1]);
        } catch {
          filename = rfc5987[1];
        }
      } else {
        const simple = /filename="([^"]+)"/i.exec(disposition);
        filename = simple?.[1] ?? null;
      }
      const blob = await response.blob();
      return { blob, filename };
    },
  },
};
