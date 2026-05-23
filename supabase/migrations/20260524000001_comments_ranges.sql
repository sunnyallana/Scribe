-- Extend `comments` with a range + snippet so "select-then-comment"
-- has somewhere to live. The existing `anchor_line` / `anchor_column`
-- become the START of the selection; the new columns track the END
-- and a copy of the selected text.
--
-- `anchor_snippet` is the resilient anchor: when the file drifts due
-- to later edits, the SPA can still locate the original block by
-- searching for the snippet text rather than trusting the stale
-- line numbers. Capped at 1 KB to bound DB row size.

alter table public.comments
  add column if not exists anchor_end_line   integer,
  add column if not exists anchor_end_column integer,
  add column if not exists anchor_snippet    text;

alter table public.comments
  add constraint comments_anchor_snippet_len
  check (anchor_snippet is null or length(anchor_snippet) <= 1024);
