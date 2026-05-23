import { type Awareness, type PresenceUser, ScribeYjsProvider } from '@scribe/yjs-provider';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Doc as YDoc, type Text as YText } from 'yjs';

import { features } from '../lib/config';
import { log } from '../lib/debug';
import { supabase, wsOrigin } from '../lib/supabase';

export interface YjsDocHandle {
  readonly provider: ScribeYjsProvider | null;
  readonly doc: YDoc | null;
  readonly yText: YText | null;
  readonly awareness: Awareness | null;
  readonly synced: boolean;
  readonly peers: readonly PresenceUser[];
}

function yjsWsUrl(): string {
  return `${wsOrigin()}/api/yjs`;
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

    log.yjs('useYjsDoc mount', { projectId, fileId });

    void (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (cancelled) {
        // Expected when StrictMode runs the cleanup before the async
        // IIFE resolves — the second mount will retry. Not an error.
        return;
      }
      if (token === undefined) {
        log.yjs.warn('useYjsDoc: no Supabase session token, skipping provider create');
        return;
      }

      const next = new ScribeYjsProvider({
        url: yjsWsUrl(),
        docId: `${projectId}/${fileId}`,
        token,
        ...(userRef.current !== null ? { user: userRef.current } : {}),
      });
      active = next;
      next.on('status', ({ status }: { status: string }) => { log.ws(`status → ${status}`, { docId: `${projectId}/${fileId}` }); });
      next.on('synced', ({ synced: s }: { synced: boolean }) => {
        log.yjs(s ? 'synced' : 'unsynced', { docId: `${projectId}/${fileId}` });
        setSynced(s);
      });
      next.on('presence', ({ peers: p }: { peers: readonly PresenceUser[] }) => {
        log.yjs('presence update', { peerCount: p.length, peers: p.map((u) => u.displayName) });
        setPeers(p);
      });
      setProvider(next);
      // Dev-only diagnostic: exposes the live provider so you can dump
      // the current Y.Text content from DevTools:
      //   __scribe.yjs.yText.toString()
      //   __scribe.yjs.provider.connectionStatus
      // Gated by `features.devGlobals` so production users never get
      // a global handle to session-scoped Yjs state.
      if (typeof window !== 'undefined' && features.devGlobals) {
        (window as unknown as { __scribe?: Record<string, unknown> }).__scribe = {
          yjs: {
            provider: next,
            doc: next.doc,
            yText: next.doc.getText('text'),
            awareness: next.awareness,
          },
        };
      }
    })();

    return () => {
      log.yjs('useYjsDoc unmount', { projectId, fileId });
      cancelled = true;
      active?.destroy();
      // Drop the dev global so it doesn't dangle a reference to the
      // destroyed provider for the next mount to confuse.
      if (typeof window !== 'undefined') {
        delete (window as unknown as { __scribe?: unknown }).__scribe;
      }
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
