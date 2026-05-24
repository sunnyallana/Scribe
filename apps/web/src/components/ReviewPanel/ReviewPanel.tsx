import { type Comment, type ProjectFile, type ProjectId, type ProjectMember } from '@scribe/shared';
import { Avatar, AvatarFallback, Button, Skeleton } from '@scribe/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Edit3,
  Loader2,
  MessageSquarePlus,
  Replace as ReplaceIcon,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api, type ApiError } from '../../lib/api';

import { MentionTextarea } from './MentionTextarea';
import { parseBody } from './mentions';

interface EditorSelection {
  readonly from: { readonly line: number; readonly column: number };
  readonly to: { readonly line: number; readonly column: number };
  readonly text: string;
}

interface ReviewPanelProps {
  readonly projectId: ProjectId;
  /** Full project file list — we need it to look up the path for a
   *  comment's `fileId` so the jump button can navigate cross-file.
   *  The earlier impl only carried `selectedFile`, which meant
   *  jumping to a comment in *any other* file silently no-op'd. */
  readonly files: readonly ProjectFile[];
  readonly selectedFile: ProjectFile | null;
  readonly currentLine?: number;
  /** Pull the editor's current selection range when the user clicks
   *  "Add comment". Returning null = the editor isn't mounted (e.g.
   *  the active file is non-textual). */
  readonly getEditorSelection?: () => EditorSelection | null;
  /** Jump to a (file, range, snippet) tuple — opens the file and
   *  re-highlights the original block. */
  readonly onJumpToRange: (
    filePath: string,
    from: { line: number; column: number },
    to: { line: number; column: number },
    snippet: string | null,
  ) => void;
  readonly onClose: () => void;
  /** Used to gate the resolve / delete buttons — only the author of
   *  a comment OR the project owner sees them. Mirrors the server's
   *  `assert_author_or_owner` policy so we never render an icon the
   *  user can't actually use. */
  readonly currentUserId?: string | null;
  readonly isProjectOwner?: boolean;
  /** Apply a suggestion by overwriting the currently selected range
   *  in the editor with `replacement`. Called *after* the panel has
   *  already issued onJumpToRange to position the selection at the
   *  suggestion's anchor, so the host just needs to perform the
   *  imperative insert against the editor. */
  readonly onApplySuggestion?: (args: {
    readonly fileId: string;
    readonly replacement: string;
  }) => Promise<void> | void;
}

interface CommentThread {
  readonly root: Comment;
  readonly replies: Comment[];
}

function groupIntoThreads(comments: readonly Comment[]): CommentThread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const threads = new Map<string, CommentThread>();
  for (const c of comments) {
    if (c.parentId === null) {
      threads.set(c.id, { root: c, replies: [] });
    }
  }
  for (const c of comments) {
    if (c.parentId === null) continue;
    let cursor: Comment | undefined = c;
    while (cursor !== undefined && cursor.parentId !== null) {
      cursor = byId.get(cursor.parentId);
    }
    if (cursor !== undefined) {
      const thread = threads.get(cursor.id);
      if (thread !== undefined) thread.replies.push(c);
    }
  }
  return Array.from(threads.values()).sort(
    (a, b) => Date.parse(a.root.createdAt) - Date.parse(b.root.createdAt),
  );
}

function initialsFor(name: string | null): string {
  if (name === null || name.trim() === '') return '??';
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** Same policy the server enforces in `assert_author_or_owner`:
 *  resolve / delete are author-or-owner-only. We mirror it on the
 *  client to suppress icons that would otherwise 403 on click. */
function canModerate(
  comment: Comment,
  currentUserId: string | null | undefined,
  isOwner: boolean,
): boolean {
  if (isOwner) return true;
  if (currentUserId === null || currentUserId === undefined) return false;
  return comment.authorId === currentUserId;
}

export function ReviewPanel({
  projectId,
  files,
  selectedFile,
  currentLine,
  getEditorSelection,
  onJumpToRange,
  onClose,
  currentUserId,
  isProjectOwner = false,
  onApplySuggestion,
}: ReviewPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  // Suggestion-mode state — when ON, the composer captures an
  // additional "replacement text" field and the resulting comment
  // is stored as a suggestion (with `replacementText` populated).
  const [suggestMode, setSuggestMode] = useState(false);
  const [replacement, setReplacement] = useState('');

  // Helper used by the "jump to comment" button on each card. Resolves
  // the comment's `fileId` against the project's file list (the old
  // impl passed an empty path, which is the root-cause of the
  // can't-go-to-line bug) and forwards to the workspace's range
  // navigator with the comment's anchor + snippet.
  const fileById = useMemo(() => {
    const map = new Map<string, ProjectFile>();
    for (const f of files) map.set(f.id, f);
    return map;
  }, [files]);
  const jumpToComment = useCallback(
    (c: Comment) => {
      if (c.fileId === null) return;
      const target = fileById.get(c.fileId);
      if (target === undefined) return;
      const startLine = c.anchorLine ?? 1;
      const startCol = c.anchorColumn ?? 0;
      const endLine = c.anchorEndLine ?? startLine;
      const endCol = c.anchorEndColumn ?? startCol;
      onJumpToRange(
        target.path,
        { line: startLine, column: startCol },
        { line: endLine, column: endCol },
        c.anchorSnippet,
      );
    },
    [fileById, onJumpToRange],
  );

  const commentsQuery = useQuery<Comment[], ApiError>({
    queryKey: ['comments', projectId],
    queryFn: () => api.comments.list(projectId),
  });

  const membersQuery = useQuery<readonly ProjectMember[], ApiError>({
    queryKey: ['members', projectId],
    queryFn: () => api.members.list(projectId),
  });
  const members = membersQuery.data ?? [];

  // Snippets are capped at the DB constraint (1024 chars). Long
  // selections still capture the first 1024 — enough to uniquely
  // identify the block within almost any source file. Newlines
  // are preserved so the snippet survives the indexOf() lookup
  // back in the editor.
  const SNIPPET_MAX = 1024;
  const createMutation = useMutation<
    Comment,
    ApiError,
    { body: string; parentId?: string; replacementText?: string }
  >({
    mutationFn: ({ body, parentId, replacementText }) => {
      const sel = parentId === undefined ? getEditorSelection?.() ?? null : null;
      // Treat a non-empty highlighted selection as a true range.
      // No-selection (cursor only) degenerates to a point anchor at
      // the current cursor line/column.
      const hasRange = sel !== null && sel.text.length > 0;
      const anchorLine = sel !== null ? sel.from.line : currentLine;
      const anchorColumn = sel !== null ? sel.from.column : 0;
      const anchorEndLine = hasRange ? sel.to.line : anchorLine;
      const anchorEndColumn = hasRange ? sel.to.column : anchorColumn;
      const snippet = hasRange ? sel.text.slice(0, SNIPPET_MAX) : undefined;
      return api.comments.create(projectId, {
        body,
        ...(parentId !== undefined ? { parentId: parentId as never } : {}),
        ...(selectedFile !== null ? { fileId: selectedFile.id } : {}),
        ...(anchorLine !== undefined && parentId === undefined
          ? { anchorLine }
          : {}),
        ...(anchorColumn !== undefined && parentId === undefined
          ? { anchorColumn }
          : {}),
        ...(anchorEndLine !== undefined && parentId === undefined
          ? { anchorEndLine }
          : {}),
        ...(anchorEndColumn !== undefined && parentId === undefined
          ? { anchorEndColumn }
          : {}),
        ...(snippet !== undefined ? { anchorSnippet: snippet } : {}),
        ...(replacementText !== undefined ? { replacementText } : {}),
      });
    },
    onSuccess: async () => {
      setDraft('');
      setReplyTo(null);
      setSuggestMode(false);
      setReplacement('');
      await queryClient.invalidateQueries({ queryKey: ['comments', projectId] });
    },
    onError: (err) => {
      toast.error(err.body.message);
    },
  });

  // Apply a suggestion: replace the anchored range in the active
  // file with the comment's replacementText, then delete the
  // comment. v1 only supports applying to the active file (using
  // the editor's selectRange + insertAtCursor) because writing to
  // a different file via writeContent would race with that file's
  // Yjs doc if it's also open in another tab.
  const applyMutation = useMutation<unknown, ApiError | Error, Comment>({
    mutationFn: async (comment) => {
      if (comment.replacementText === null) throw new Error('not a suggestion');
      if (comment.fileId === null) throw new Error('no file');
      if (selectedFile === null || selectedFile.id !== comment.fileId) {
        throw new Error(t('suggestion.openFileFirst'));
      }
      const startLine = comment.anchorLine ?? 1;
      const startCol = comment.anchorColumn ?? 0;
      const endLine = comment.anchorEndLine ?? startLine;
      const endCol = comment.anchorEndColumn ?? startCol;
      // Delegate the selection+insert to the editor via the same
      // jump callback the Reviews panel already uses for navigation.
      onJumpToRange(
        selectedFile.path,
        { line: startLine, column: startCol },
        { line: endLine, column: endCol },
        comment.anchorSnippet,
      );
      // Give the editor a tick to apply the selection, then ask
      // the host to overwrite it via the imperative insert path.
      await onApplySuggestion?.({
        fileId: comment.fileId,
        replacement: comment.replacementText,
      });
      await api.comments.remove(projectId, comment.id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['comments', projectId] });
      toast.success(t('suggestion.applied'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('suggestion.applyFailed'));
    },
  });

  const resolveMutation = useMutation<unknown, ApiError, { id: Comment['id']; resolved: boolean }>({
    mutationFn: ({ id, resolved }) =>
      api.comments.update(projectId, id, { resolved }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['comments', projectId] });
    },
  });

  const deleteMutation = useMutation<unknown, ApiError, Comment['id']>({
    mutationFn: (id) => api.comments.remove(projectId, id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['comments', projectId] });
    },
  });

  const threads = groupIntoThreads(commentsQuery.data ?? []);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('review.title')}
        </h3>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common.close')}
          className="h-6 w-6"
          onClick={onClose}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {commentsQuery.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : threads.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('review.empty')}</p>
        ) : (
          threads.map((thread) => (
            <div
              key={thread.root.id}
              className={`rounded-md border p-2 ${
                thread.root.resolvedAt !== null ? 'opacity-60' : ''
              }`}
            >
              <CommentCard
                comment={thread.root}
                isRoot
                canModerate={canModerate(thread.root, currentUserId, isProjectOwner)}
                onJump={jumpToComment}
                onReply={() => { setReplyTo(thread.root.id); }}
                onResolve={() => {
                  resolveMutation.mutate({
                    id: thread.root.id,
                    resolved: thread.root.resolvedAt === null,
                  });
                }}
                onDelete={() => {
                  if (window.confirm(t('review.deleteConfirm'))) {
                    deleteMutation.mutate(thread.root.id);
                  }
                }}
                {...(thread.root.replacementText !== null
                  ? { onApply: () => { applyMutation.mutate(thread.root); } }
                  : {})}
                applying={applyMutation.isPending && applyMutation.variables?.id === thread.root.id}
              />
              {thread.replies.length > 0 ? (
                <div className="mt-2 ml-3 border-l pl-3 space-y-2">
                  {thread.replies.map((reply) => (
                    <CommentCard
                      key={reply.id}
                      comment={reply}
                      isRoot={false}
                      canModerate={canModerate(reply, currentUserId, isProjectOwner)}
                      onJump={jumpToComment}
                      onResolve={() => {
                        resolveMutation.mutate({
                          id: reply.id,
                          resolved: reply.resolvedAt === null,
                        });
                      }}
                      onDelete={() => {
                        if (window.confirm(t('review.deleteConfirm'))) {
                          deleteMutation.mutate(reply.id);
                        }
                      }}
                    />
                  ))}
                </div>
              ) : null}
              {replyTo === thread.root.id ? (
                <div className="mt-2 ml-3 border-l pl-3">
                  <MentionTextarea
                    rows={2}
                    placeholder={t('review.replyPlaceholder')}
                    value={draft}
                    onChange={setDraft}
                    members={members}
                  />
                  <div className="mt-1 flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        if (draft.trim().length === 0) return;
                        createMutation.mutate({ body: draft, parentId: thread.root.id });
                      }}
                      disabled={createMutation.isPending || draft.trim().length === 0}
                    >
                      {t('review.reply')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setReplyTo(null);
                        setDraft('');
                      }}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
      <div className="border-t p-3">
        {replyTo === null ? (
          <>
            {/* Live-preview of what'll be anchored. Reading the
                selection inside render is a cheap call into the
                view — no setState in render, just a synchronous
                ref read each time we re-render. */}
            <CommentDraftHint
              selectedFile={selectedFile}
              {...(currentLine !== undefined ? { currentLine } : {})}
              {...(getEditorSelection !== undefined ? { getEditorSelection } : {})}
            />
            <MentionTextarea
              rows={3}
              placeholder={
                suggestMode
                  ? t('suggestion.bodyPlaceholder')
                  : (selectedFile !== null
                      ? t('review.newCommentOnLine', {
                          file: selectedFile.path,
                          line: currentLine ?? 1,
                        })
                      : t('review.newCommentGeneric'))
              }
              value={draft}
              onChange={setDraft}
              members={members}
              disabled={createMutation.isPending}
            />
            {suggestMode ? (
              <textarea
                rows={3}
                placeholder={t('suggestion.replacementPlaceholder')}
                value={replacement}
                onChange={(e) => { setReplacement(e.target.value); }}
                disabled={createMutation.isPending}
                className="mt-2 w-full resize-y rounded-md border bg-background px-2 py-1.5 font-mono text-[11px]"
              />
            ) : null}
            <div className="mt-2 flex items-center gap-1.5">
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  if (draft.trim().length === 0) return;
                  if (suggestMode) {
                    createMutation.mutate({ body: draft, replacementText: replacement });
                  } else {
                    createMutation.mutate({ body: draft });
                  }
                }}
                disabled={
                  createMutation.isPending ||
                  draft.trim().length === 0 ||
                  (suggestMode && replacement === '')
                }
              >
                {createMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : suggestMode ? (
                  <Edit3 className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <MessageSquarePlus className="h-3 w-3" aria-hidden="true" />
                )}
                {suggestMode ? t('suggestion.addSuggestion') : t('review.addComment')}
              </Button>
              <button
                type="button"
                onClick={() => { setSuggestMode((v) => !v); setReplacement(''); }}
                className={`flex h-7 items-center gap-1 rounded-md px-2 text-[10px] transition-colors ${
                  suggestMode
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
                title={t('suggestion.toggleHint')}
                aria-pressed={suggestMode}
              >
                <ReplaceIcon className="h-3 w-3" aria-hidden="true" />
                {t('suggestion.toggle')}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

interface CommentDraftHintProps {
  readonly selectedFile: ProjectFile | null;
  readonly currentLine?: number;
  readonly getEditorSelection?: () => EditorSelection | null;
}

/**
 * Tiny banner above the "new comment" textarea showing what'll be
 * anchored when the user clicks Add. Reads the editor selection
 * synchronously each render — cheap, no re-render plumbing
 * required.
 */
function CommentDraftHint({
  selectedFile,
  currentLine,
  getEditorSelection,
}: CommentDraftHintProps) {
  const { t } = useTranslation();
  if (selectedFile === null) return null;
  const sel = getEditorSelection?.() ?? null;
  const hasRange = sel !== null && sel.text.length > 0;
  if (hasRange) {
    // Truncate the preview so a paragraph-long selection doesn't
    // dominate the panel.
    const preview = sel.text.length > 80 ? `${sel.text.slice(0, 80)}…` : sel.text;
    return (
      <p
        className="mb-2 truncate rounded-sm bg-primary/10 px-2 py-1 text-[10px] text-primary"
        title={sel.text}
      >
        {t('review.anchorPreviewBlock', {
          fromLine: sel.from.line,
          toLine: sel.to.line,
          preview,
        })}
      </p>
    );
  }
  return (
    <p className="mb-2 text-[10px] text-muted-foreground">
      {t('review.anchorPreviewLine', {
        file: selectedFile.path,
        line: currentLine ?? 1,
      })}
    </p>
  );
}

interface CommentCardProps {
  readonly comment: Comment;
  readonly isRoot: boolean;
  /** Range-aware jump callback. Receives the comment itself so the
   *  workspace can resolve file path, range, and snippet from it. */
  readonly onJump?: (c: Comment) => void;
  readonly onReply?: () => void;
  readonly onResolve: () => void;
  readonly onDelete: () => void;
  /** When false, the resolve + delete icons are hidden. The
   *  back-end enforces the same policy via `assert_author_or_owner`
   *  — this is just to avoid showing buttons that would 403. */
  readonly canModerate: boolean;
  /** Wired for SUGGESTION comments only. Calling it applies the
   *  proposed replacement to the editor and deletes the comment. */
  readonly onApply?: () => void;
  /** True when an apply mutation is in flight, so the buttons
   *  disable to avoid double-clicks. */
  readonly applying?: boolean;
}

function CommentCard({
  comment,
  isRoot,
  onJump,
  onReply,
  onResolve,
  onDelete,
  canModerate,
  onApply,
  applying = false,
}: CommentCardProps) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-2">
      <Avatar className="h-6 w-6 flex-shrink-0">
        <AvatarFallback className="text-[10px]">
          {initialsFor(comment.authorDisplayName)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium">
            {comment.authorDisplayName ?? t('review.unknownAuthor')}
          </span>
          {canModerate ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={comment.resolvedAt === null ? t('review.resolve') : t('review.reopen')}
                onClick={onResolve}
              >
                <Check className="h-3 w-3" />
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                aria-label={t('common.delete')}
                onClick={onDelete}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ) : null}
        </div>
        <p className="whitespace-pre-wrap text-xs">
          {parseBody(comment.body).map((tok, idx) =>
            tok.kind === 'mention' ? (
              <span
                key={`m-${idx.toString()}`}
                className="rounded bg-primary/15 px-1 font-medium text-primary"
                title={tok.userId}
              >
                @{tok.displayName}
              </span>
            ) : (
              <span key={`t-${idx.toString()}`}>{tok.value}</span>
            ),
          )}
        </p>
        {comment.replacementText !== null ? (
          <div className="mt-1.5 space-y-1 rounded border border-emerald-500/30 bg-emerald-500/5 p-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
              {t('suggestion.proposed')}
            </div>
            {comment.anchorSnippet !== null && comment.anchorSnippet !== '' ? (
              <div className="space-y-0.5 text-[10px]">
                <div className="text-muted-foreground">{t('suggestion.replacingLabel')}</div>
                <pre className="overflow-x-auto rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
                  {comment.anchorSnippet.length > 240
                    ? `${comment.anchorSnippet.slice(0, 240)}…`
                    : comment.anchorSnippet}
                </pre>
              </div>
            ) : null}
            <div className="space-y-0.5 text-[10px]">
              <div className="text-muted-foreground">{t('suggestion.withLabel')}</div>
              <pre className="overflow-x-auto rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-800 dark:text-emerald-300">
                {comment.replacementText.length > 240
                  ? `${comment.replacementText.slice(0, 240)}…`
                  : comment.replacementText}
              </pre>
            </div>
            {onApply !== undefined ? (
              <div className="flex items-center gap-1 pt-0.5">
                <button
                  type="button"
                  onClick={onApply}
                  disabled={applying}
                  className="flex h-6 items-center gap-1 rounded bg-emerald-600 px-2 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  {t('suggestion.apply')}
                </button>
                {canModerate ? (
                  <button
                    type="button"
                    onClick={onDelete}
                    className="flex h-6 items-center gap-1 rounded px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {t('suggestion.dismiss')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{new Date(comment.createdAt).toLocaleString()}</span>
          {isRoot && comment.anchorLine !== null && onJump !== undefined && comment.fileId !== null ? (
            <button
              type="button"
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              onClick={() => { onJump(comment); }}
              // Show the snippet text on hover when it exists — it
              // disambiguates which block this comment is on, useful
              // when several comments share a line range.
              title={comment.anchorSnippet ?? undefined}
            >
              {comment.anchorSnippet !== null && comment.anchorSnippet.length > 0
                ? t('review.jumpToBlock')
                : t('review.jumpToLine', { line: comment.anchorLine })}
            </button>
          ) : null}
          {isRoot && onReply !== undefined ? (
            <button
              type="button"
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              onClick={onReply}
            >
              {t('review.reply')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
