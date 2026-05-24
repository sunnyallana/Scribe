-- Suggestion comments. A regular comment has `body` only; a suggestion
-- additionally carries a `replacement_text` field — the proposed new
-- content for the anchored range. Reviewers can Apply the suggestion
-- (which writes the replacement into the file and deletes the
-- comment) or Dismiss (which removes the comment without applying).
--
-- Existing comments are unchanged; the new column is nullable so
-- migrating is forward-compatible.

alter table public.comments
  add column if not exists replacement_text text;
