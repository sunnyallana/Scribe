/**
 * Browser-side download helpers + server-export wrappers for the
 * project export menu. The heavy lifting (LaTeX → Markdown / DOCX)
 * runs server-side via pandoc — see
 * `servers/rust/crates/scribe-server/src/services/exports.rs`.
 *
 * Living outside React means the same logic backs both the navbar
 * project menu and the sidebar download button without prop-drilling.
 */

import { api } from './api';

import type { ProjectId } from '@scribe/shared';

/** Trigger a save-as for a Blob in the browser. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Microtask so the browser actually starts the download before we
  // revoke. Otherwise revoke can race with the click in some browsers.
  setTimeout(() => { URL.revokeObjectURL(url); }, 0);
}

/** Slug-ify a project name for use in a filename. Allowed chars only;
 *  anything else collapses to underscores. */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length === 0 ? 'project' : cleaned;
}

/** Fetch the compiled PDF at `url` (a signed Supabase Storage URL) and
 *  trigger a download with a sensible filename. Throws on network
 *  failure; the caller is expected to surface a toast. */
export async function downloadCompiledPdf(url: string, projectName: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Couldn't fetch PDF (HTTP ${response.status.toString()})`);
  }
  const blob = await response.blob();
  triggerDownload(blob, `${safeFilename(projectName)}.pdf`);
}

/** Server-side LaTeX → Markdown export. Pandoc handles structure,
 *  citations, cross-refs, tables, custom commands, etc. — far higher
 *  fidelity than any in-browser regex pipeline could manage. */
export async function exportAsMarkdown(
  projectId: ProjectId,
  projectName: string,
): Promise<void> {
  const { blob, filename } = await api.exports.run(projectId, 'md');
  triggerDownload(blob, filename ?? `${safeFilename(projectName)}.md`);
}

/** Server-side LaTeX → DOCX export. */
export async function exportAsWord(
  projectId: ProjectId,
  projectName: string,
): Promise<void> {
  const { blob, filename } = await api.exports.run(projectId, 'docx');
  triggerDownload(blob, filename ?? `${safeFilename(projectName)}.docx`);
}
