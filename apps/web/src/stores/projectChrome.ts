import { create } from 'zustand';

import type { Project } from '@scribe/shared';

interface ProjectChromeState {
  /** Active project the navbar should render in its center slot. Null
   *  outside a project view (dashboard, settings, auth). */
  project: Project | null;
  /** Open the project's settings sheet. Wired up by ProjectPage. */
  openSettings: (() => void) | null;
  /** Signed URL of the most recently compiled PDF, or null when no
   *  compile has succeeded yet. Drives the "Download PDF" menu item —
   *  hidden when null. Published by ProjectWorkspace; consumed by the
   *  navbar project menu and the sidebar download button. */
  pdfUrl: string | null;
  set: (next: Partial<ProjectChromeState>) => void;
  clear: () => void;
}

export const useProjectChrome = create<ProjectChromeState>((set) => ({
  project: null,
  openSettings: null,
  pdfUrl: null,
  set: (next) => { set(next); },
  clear: () => {
    set({ project: null, openSettings: null, pdfUrl: null });
  },
}));
