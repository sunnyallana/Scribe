-- Idempotent bucket creation. Run safely on every migration apply.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('project-files', 'project-files', false, 52428800, null),
  ('compile-artifacts', 'compile-artifacts', false, 104857600,
   array['application/pdf', 'text/plain', 'application/octet-stream']),
  ('version-snapshots', 'version-snapshots', false, 104857600, null),
  ('template-thumbnails', 'template-thumbnails', true, 5242880,
   array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
