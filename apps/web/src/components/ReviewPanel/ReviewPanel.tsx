import { type Comment, type ProjectFile, type ProjectId, type ProjectMember } from '@scribe/shared';
import { Avatar, AvatarFallback, Button, Skeleton } from '@scribe/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, MessageSquarePlus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api, type ApiError } from '../../lib/api';

import { MentionTextarea } from './MentionTextarea';
import { parseBody } from './mentions';

interface ReviewPanelProps {
  readonly projectId: ProjectId;
  readonly selectedFile: ProjectFile | null;
  readonly currentLine?: number;
  readonly onJumpTo: (filePath: string, line: number) => void;
  readonly onClose: () => void;
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

export function ReviewPanel({
  projectId,
  selectedFile,
  currentLine,
  onJumpTo,
  onClose,
}: ReviewPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);

  const commentsQuery = useQuery<Comment[], ApiError>({
    queryKey: ['comments', projectId],
    queryFn: () => api.comments.list(projectId),
  });

  const membersQuery = useQuery<readonly ProjectMember[], ApiError>({
    queryKey: ['members', projectId],
    queryFn: () => api.members.list(projectId),
  });
  const members = membersQuery.data ?? [];

  const createMutation = useMutation<Comment, ApiError, { body: string; parentId?: string }>({
    mutationFn: ({ body, parentId }) =>
      api.comments.create(projectId, {
        body,
        ...(parentId !== undefined ? { parentId: parentId as never } : {}),
        ...(selectedFile !== null ? { fileId: selectedFile.id } : {}),
        ...(currentLine !== undefined && parentId === undefined ? { anchorLine: currentLine } : {}),
      }),
    onSuccess: async () => {
      setDraft('');
      setReplyTo(null);
      await queryClient.invalidateQueries({ queryKey: ['comments', projectId] });
    },
    onError: (err) => {
      toast.error(err.body.message);
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
                onJumpTo={onJumpTo}
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
              />
              {thread.replies.length > 0 ? (
                <div className="mt-2 ml-3 border-l pl-3 space-y-2">
                  {thread.replies.map((reply) => (
                    <CommentCard
                      key={reply.id}
                      comment={reply}
                      isRoot={false}
                      onJumpTo={onJumpTo}
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
            <MentionTextarea
              rows={3}
              placeholder={
                selectedFile !== null
                  ? t('review.newCommentOnLine', {
                      file: selectedFile.path,
                      line: currentLine ?? 1,
                    })
                  : t('review.newCommentGeneric')
              }
              value={draft}
              onChange={setDraft}
              members={members}
              disabled={createMutation.isPending}
            />
            <Button
              size="sm"
              className="mt-2 gap-1.5"
              onClick={() => {
                if (draft.trim().length === 0) return;
                createMutation.mutate({ body: draft });
              }}
              disabled={createMutation.isPending || draft.trim().length === 0}
            >
              {createMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : (
                <MessageSquarePlus className="h-3 w-3" aria-hidden="true" />
              )}
              {t('review.addComment')}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

interface CommentCardProps {
  readonly comment: Comment;
  readonly isRoot: boolean;
  readonly onJumpTo?: (filePath: string, line: number) => void;
  readonly onReply?: () => void;
  readonly onResolve: () => void;
  readonly onDelete: () => void;
}

function CommentCard({ comment, isRoot, onJumpTo, onReply, onResolve, onDelete }: CommentCardProps) {
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
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{new Date(comment.createdAt).toLocaleString()}</span>
          {isRoot && comment.anchorLine !== null && onJumpTo !== undefined && comment.fileId !== null ? (
            <button
              type="button"
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              onClick={() => {
                onJumpTo('', comment.anchorLine ?? 1);
              }}
            >
              {t('review.jumpToLine', { line: comment.anchorLine })}
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
