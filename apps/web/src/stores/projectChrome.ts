import { create } from 'zustand';

import type { Project } from '@scribe/shared';

interface ProjectChromeState {
  /** Active project the navbar should render in its center slot. Null
   *  outside a project view (dashboard, settings, auth). */
  project: Project | null;
  /** Open the project's settings sheet. Wired up by ProjectPage. */
  openSettings: (() => void) | null;
  set: (next: Partial<ProjectChromeState>) => void;
  clear: () => void;
}

export const useProjectChrome = create<ProjectChromeState>((set) => ({
  project: null,
  openSettings: null,
  set: (next) => { set(next); },
  clear: () => { set({ project: null, openSettings: null }); },
}));
