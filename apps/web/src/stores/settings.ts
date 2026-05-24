import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface EditorPreferences {
  readonly fontSize: number;
  readonly rulerColumn: number;
  readonly vimMode: boolean;
  readonly autocomplete: boolean;
  readonly ghostText: boolean;
  readonly liveCompile: boolean;
  readonly liveCompileDelayMs: number;
  /** When false, style-lint (chktex) entries are hidden from the
   *  compile log AND the editor gutter. The server still runs the
   *  linter — this is purely a display toggle, so flipping it back
   *  on shows existing warnings immediately without recompiling. */
  readonly lintEnabled: boolean;
}

export const DEFAULT_EDITOR_PREFS: EditorPreferences = {
  fontSize: 14,
  rulerColumn: 80,
  vimMode: false,
  autocomplete: true,
  ghostText: false,
  liveCompile: false,
  liveCompileDelayMs: 3000,
  lintEnabled: true,
};

interface SettingsState {
  readonly language: string;
  readonly editor: EditorPreferences;
  setLanguage: (language: string) => void;
  setEditorPref: <K extends keyof EditorPreferences>(key: K, value: EditorPreferences[K]) => void;
  resetEditor: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      language: 'en',
      editor: DEFAULT_EDITOR_PREFS,
      setLanguage: (language) => {
        set({ language });
      },
      setEditorPref: (key, value) => {
        set((state) => ({ editor: { ...state.editor, [key]: value } }));
      },
      resetEditor: () => {
        set({ editor: DEFAULT_EDITOR_PREFS });
      },
    }),
    { name: 'scribe-settings', version: 3 },
  ),
);
