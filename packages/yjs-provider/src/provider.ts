import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import {
  messageYjsSyncStep2,
  messageYjsUpdate,
  readSyncMessage,
  writeSyncStep1,
  writeUpdate,
} from 'y-protocols/sync';
import { Doc as YDoc } from 'yjs';

import {
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
  type PresenceUser,
  type YjsProviderConfig,
} from './protocol.js';

export type ProviderStatus = 'connecting' | 'connected' | 'disconnected';

export interface ProviderEvents {
  status: { status: ProviderStatus };
  synced: { synced: boolean };
  presence: { peers: readonly PresenceUser[] };
  destroy: undefined;
}

type Listener<T> = (payload: T) => void;

class Emitter<E> {
  private readonly listeners = new Map<keyof E, Set<Listener<E[keyof E]>>>();

  on<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const targetSet = set;
    targetSet.add(listener as Listener<E[keyof E]>);
    return () => {
      targetSet.delete(listener as Listener<E[keyof E]>);
    };
  }

  off<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<E[keyof E]>);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;
    for (const listener of set) {
      (listener as Listener<E[K]>)(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

export class ScribeYjsProvider {
  readonly doc: YDoc;
  readonly awareness: Awareness;

  private readonly emitter = new Emitter<ProviderEvents>();
  private readonly config: YjsProviderConfig;
  private socket: WebSocket | null = null;
  private status: ProviderStatus = 'disconnected';
  private synced = false;
  private destroyed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentToken: string;

  constructor(config: YjsProviderConfig, existingDoc?: YDoc) {
    this.config = config;
    this.currentToken = config.token;
    this.doc = existingDoc ?? new YDoc();
    this.awareness = new Awareness(this.doc);

    if (config.user !== undefined) {
      this.awareness.setLocalState({ user: config.user });
    }

    this.doc.on('update', this.handleDocUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.handleBeforeUnload);
    }
    this.connect();
  }

  get connectionStatus(): ProviderStatus {
    return this.status;
  }

  get isSynced(): boolean {
    return this.synced;
  }

  setToken(token: string): void {
    this.currentToken = token;
    // Reconnect to use the new token.
    this.socket?.close();
  }

  setUser(user: PresenceUser): void {
    this.awareness.setLocalState({ user });
  }

  setCursor(file: string, anchor: number, head: number): void {
    const local = this.awareness.getLocalState();
    const user =
      local !== null && typeof local === 'object' && 'user' in local
        ? (local.user as PresenceUser | undefined)
        : undefined;
    if (user === undefined) return;
    this.awareness.setLocalState({
      user: { ...user, currentFile: file, cursorAnchor: anchor, cursorHead: head },
    });
  }

  on<K extends keyof ProviderEvents>(event: K, listener: Listener<ProviderEvents[K]>): () => void {
    return this.emitter.on(event, listener);
  }

  off<K extends keyof ProviderEvents>(event: K, listener: Listener<ProviderEvents[K]>): void {
    this.emitter.off(event, listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.handleBeforeUnload);
    }
    this.doc.off('update', this.handleDocUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
    if (this.socket !== null) {
      this.socket.close();
      this.socket = null;
    }
    this.emitter.emit('destroy', undefined);
    this.emitter.clear();
  }

  private connect(): void {
    if (this.destroyed) return;
    this.setStatus('connecting');
    const url = `${this.config.url.replace(/\/$/, '')}/${this.config.docId}/socket?token=${encodeURIComponent(this.currentToken)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.socket = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus('connected');
      // Server sends sync step 1 + current awareness on connect; we respond
      // with our own sync step 1 + awareness state.
      const syncEncoder = encoding.createEncoder();
      encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
      writeSyncStep1(syncEncoder, this.doc);
      ws.send(encoding.toUint8Array(syncEncoder));

      const states = this.awareness.getStates();
      if (states.size > 0) {
        const aw = encoding.createEncoder();
        encoding.writeVarUint(aw, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(aw, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
        ws.send(encoding.toUint8Array(aw));
      }
    };

    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const data = new Uint8Array(event.data);
      try {
        const decoder = decoding.createDecoder(data);
        const messageType = decoding.readVarUint(decoder);
        if (messageType === MESSAGE_SYNC) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          const syncMessageType = readSyncMessage(decoder, encoder, this.doc, this);
          // y-protocols constants:
          //   messageYjsSyncStep1 = 0  (state-vector request)
          //   messageYjsSyncStep2 = 1  (full state response — what we want)
          //   messageYjsUpdate    = 2  (incremental change)
          //
          // Previously we compared against the magic number `2`, which
          // is `messageYjsUpdate` — so `synced` only flipped to true on
          // the FIRST keystroke from a peer, never on the initial state
          // load. With no co-editor that update never arrived, so the
          // collab-timeout fallback always fired at 2.5 s, leaving the
          // editor in solo mode and silently disabling live sync.
          if (
            (syncMessageType === messageYjsSyncStep2 || syncMessageType === messageYjsUpdate) &&
            !this.synced
          ) {
            this.synced = true;
            this.emitter.emit('synced', { synced: true });
          }
          if (encoding.length(encoder) > 1) {
            ws.send(encoding.toUint8Array(encoder));
          }
        } else if (messageType === MESSAGE_AWARENESS) {
          applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        }
      } catch (err) {
        // Malformed protocol message — ignore.
        console.warn('Yjs provider message error', err);
      }
    };

    ws.onclose = () => {
      this.socket = null;
      const wasSynced = this.synced;
      this.synced = false;
      if (wasSynced) {
        this.emitter.emit('synced', { synced: false });
      }
      this.setStatus('disconnected');
      // Drop remote awareness states; they'll be re-sent on reconnect.
      const remoteIds = Array.from(this.awareness.getStates().keys()).filter(
        (id) => id !== this.doc.clientID,
      );
      if (remoteIds.length > 0) {
        removeAwarenessStates(this.awareness, remoteIds, this);
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire next and trigger reconnect.
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(status: ProviderStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emitter.emit('status', { status });
  }

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Origin === this means this update came from `readSyncMessage`
    // applying a remote frame we just received — already on the wire,
    // don't echo it back.
    if (origin === this) return;
    if (this.socket?.readyState !== WebSocket.OPEN) {
      // The editor is emitting updates but our socket is closed.
      // Whoever pulls the editor's content via the autosave path will
      // still persist it via HTTP; the WS broadcast is what's lost.
      // eslint-disable-next-line no-console
      console.warn('[Scribe:yjs] dropping outbound update — socket not open', {
        readyState: this.socket?.readyState,
        bytes: update.length,
        docId: this.config.docId,
      });
      return;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    writeUpdate(encoder, update);
    this.socket.send(encoding.toUint8Array(encoder));
  };

  private readonly handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const changed = added.concat(updated, removed);
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN && origin !== this) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, changed));
      this.socket.send(encoding.toUint8Array(encoder));
    }
    this.emitPresence();
  };

  private readonly handleBeforeUnload = (): void => {
    if (this.awareness.getLocalState() !== null) {
      removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload');
    }
  };

  private emitPresence(): void {
    const peers: PresenceUser[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.doc.clientID) return;
      const user = (state as { user?: PresenceUser }).user;
      if (user !== undefined) peers.push(user);
    });
    this.emitter.emit('presence', { peers });
  }
}

export function createScribeYjsProvider(
  config: YjsProviderConfig,
  existingDoc?: YDoc,
): ScribeYjsProvider {
  return new ScribeYjsProvider(config, existingDoc);
}
