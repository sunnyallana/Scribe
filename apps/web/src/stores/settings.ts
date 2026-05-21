import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  readonly language: string;
  setLanguage: (language: string) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      language: 'en',
      setLanguage: (language) => {
        set({ language });
      },
    }),
    { name: 'scribe-settings' },
  ),
);
