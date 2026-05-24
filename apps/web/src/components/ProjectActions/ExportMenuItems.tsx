/**
 * Shared menu items for project export/download actions. Rendered by
 * the navbar project-name dropdown and by the sidebar download
 * button — keeping the items in one place means new export formats
 * don't need to be added in two files.
 */

import { DropdownMenuItem, DropdownMenuSeparator } from '@scribe/ui';
import { FileCode, FileText, FileType2, Loader2, Package } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api, ApiError } from '../../lib/api';
import { log } from '../../lib/debug';
import {
  downloadCompiledPdf,
  exportAsMarkdown,
  exportAsWord,
} from '../../lib/projectExports';
import { supabase } from '../../lib/supabase';
import { useProjectChrome } from '../../stores/projectChrome';

export function ExportMenuItems() {
  const { t } = useTranslation();
  const project = useProjectChrome((s) => s.project);
  const pdfUrl = useProjectChrome((s) => s.pdfUrl);
  // Track which export is in-flight so the user sees a spinner. The
  // server can take a few seconds for big docs (pandoc + citeproc).
  const [busy, setBusy] = useState<null | 'zip' | 'pdf' | 'md' | 'docx'>(null);
  if (project === null) return null;

  async function handleDownloadZip() {
    if (project === null) return;
    setBusy('zip');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? '';
      const resp = await fetch(api.files.zipUrl(project.id), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status.toString()}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => { URL.revokeObjectURL(url); }, 0);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.api.error('zip download failed', e);
      toast.error(t('export.zipFailed', { error: msg }));
    } finally {
      setBusy(null);
    }
  }

  async function handleDownloadPdf() {
    if (project === null || pdfUrl === null) return;
    setBusy('pdf');
    try {
      await downloadCompiledPdf(pdfUrl, project.name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(t('export.pdfFailed', { error: msg }));
    } finally {
      setBusy(null);
    }
  }

  async function handleExport(format: 'md' | 'docx') {
    if (project === null) return;
    setBusy(format);
    try {
      if (format === 'md') {
        await exportAsMarkdown(project.id, project.name);
        toast.success(t('export.exportedAsMarkdown'));
      } else {
        await exportAsWord(project.id, project.name);
        toast.success(t('export.exportedAsWord'));
      }
    } catch (e) {
      // ApiError carries the server's structured message — surface it
      // so the user knows pandoc isn't installed, or which LaTeX
      // command pandoc choked on. Fallback to generic message.
      const msg =
        e instanceof ApiError ? e.body.message : e instanceof Error ? e.message : String(e);
      toast.error(t(format === 'md' ? 'export.markdownFailed' : 'export.wordFailed', { error: msg }));
    } finally {
      setBusy(null);
    }
  }

  const canDownloadPdf = pdfUrl !== null;
  const anyBusy = busy !== null;

  return (
    <>
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault(); // keep menu open while the request runs
          void handleDownloadZip();
        }}
        disabled={anyBusy}
      >
        {busy === 'zip' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Package className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {t('export.downloadZip')}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault();
          void handleDownloadPdf();
        }}
        disabled={!canDownloadPdf || anyBusy}
      >
        {busy === 'pdf' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {t('export.downloadPdf')}
        {!canDownloadPdf ? (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {t('export.compileFirst')}
          </span>
        ) : null}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault();
          void handleExport('md');
        }}
        disabled={anyBusy}
      >
        {busy === 'md' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <FileCode className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {t('export.exportMarkdown')}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault();
          void handleExport('docx');
        }}
        disabled={anyBusy}
      >
        {busy === 'docx' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <FileType2 className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {t('export.exportWord')}
      </DropdownMenuItem>
    </>
  );
}
