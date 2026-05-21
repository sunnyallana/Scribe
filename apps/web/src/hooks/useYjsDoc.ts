import { type Awareness, type PresenceUser, ScribeYjsProvider } from '@scribe/yjs-provider';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Doc as YDoc, type Text as YText } from 'yjs';

import { API_URL, supabase } from '../lib/supabase';

export interface YjsDocHandle {
  readonly provider: ScribeYjsProvider | null;
  readonly doc: YDoc | null;
  readonly yText: YText | null;
  readonly awareness: Awareness | null;
  readonly synced: boolean;
  readonly peers: readonly PresenceUser[];
}

function wsUrlFromApi(apiUrl: string): string {
  const u = new URL(apiUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${u.toString().replace(/\/$/, '')}/api/yjs`;
}

/**
 * Open (or reopen) a Yjs collaboration session for the given file. Token
 * refresh on each mount; the provider also reconnects on its own when the
 * server closes the socket.
 */
export function useYjsDoc(
  projectId: string | null,
  fileId: string | null,
  user: PresenceUser | null,
): YjsDocHandle {
  const [provider, setProvider] = useState<ScribeYjsProvider | null>(null);
  const [synced, setSynced] = useState(false);
  const [peers, setPeers] = useState<readonly PresenceUser[]>([]);
  const userRef = useRef(user);
  userRef.current = user;

  useEffect(() => {
    if (projectId === null || fileId === null) {
      setProvider(null);
      setSynced(false);
      setPeers([]);
      return;
    }

    let cancelled = false;
    let active: ScribeYjsProvider | null = null;

    void (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token === undefined || cancelled) return;

      const next = new ScribeYjsProvider({
        url: wsUrlFromApi(API_URL),
        docId: `${projectId}/${fileId}`,
        token,
        ...(userRef.current !== null ? { user: userRef.current } : {}),
      });
      active = next;
      next.on('synced', ({ synced: s }: { synced: boolean }) => { setSynced(s); });
      next.on('presence', ({ peers: p }: { peers: readonly PresenceUser[] }) => { setPeers(p); });
      setProvider(next);
    })();

    return () => {
      cancelled = true;
      active?.destroy();
      setProvider(null);
      setSynced(false);
      setPeers([]);
    };
  }, [projectId, fileId]);

  // Keep awareness user up to date.
  useEffect(() => {
    if (provider !== null && user !== null) {
      provider.setUser(user);
    }
  }, [provider, user]);

  return useMemo<YjsDocHandle>(
    () => ({
      provider,
      doc: provider?.doc ?? null,
      yText: provider !== null ? provider.doc.getText('text') : null,
      awareness: provider?.awareness ?? null,
      synced,
      peers,
    }),
    [provider, synced, peers],
  );
}
