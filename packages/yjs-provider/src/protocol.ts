export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

export interface PresenceUser {
  readonly userId: string;
  readonly displayName: string;
  readonly color: string;
  readonly cursorAnchor?: number;
  readonly cursorHead?: number;
  readonly currentFile?: string;
}

export type PresenceState = Readonly<Record<string, PresenceUser>>;

export interface YjsProviderConfig {
  /** Base WebSocket URL, e.g. ws://localhost:3000/api/yjs */
  readonly url: string;
  /** Doc id; conventionally `<project_id>/<file_id>`. */
  readonly docId: string;
  /** JWT token (Supabase access_token) for auth. */
  readonly token: string;
  /** Optional local user identity used for awareness/presence. */
  readonly user?: PresenceUser;
}
