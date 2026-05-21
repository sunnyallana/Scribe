import { create } from 'zustand';

import { supabase } from '../lib/supabase';

import type { Session, User } from '@supabase/supabase-js';

export type AuthStatus = 'initializing' | 'authenticated' | 'unauthenticated';

interface AuthState {
  readonly status: AuthStatus;
  readonly user: User | null;
  readonly session: Session | null;
  initialize: () => Promise<void>;
  signOut: () => Promise<void>;
}

let initialized = false;

export const useAuthStore = create<AuthState>((set) => ({
  status: 'initializing',
  user: null,
  session: null,

  async initialize() {
    if (initialized) return;
    initialized = true;

    const {
      data: { session },
    } = await supabase.auth.getSession();
    set({
      session,
      user: session?.user ?? null,
      status: session === null ? 'unauthenticated' : 'authenticated',
    });

    supabase.auth.onAuthStateChange((_event, nextSession) => {
      set({
        session: nextSession,
        user: nextSession?.user ?? null,
        status: nextSession === null ? 'unauthenticated' : 'authenticated',
      });
    });
  },

  async signOut() {
    await supabase.auth.signOut();
    set({ session: null, user: null, status: 'unauthenticated' });
  },
}));
