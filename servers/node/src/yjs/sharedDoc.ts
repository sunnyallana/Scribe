import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Doc as YDoc } from 'yjs';

import type { YjsPersistence } from '../services/yjsPersistence.js';
import type { WebSocket } from 'ws';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/**
 * A live doc on the server. One instance per (project, file). Maintains:
 *   - the canonical Y.Doc state
 *   - a set of connected WebSockets
 *   - an Awareness instance for presence/cursors
 *   - persistence hooks that flush updates to Postgres
 */
export class WSSharedDoc {
  readonly docId: string;
  readonly doc: YDoc;
  readonly awareness: Awareness;
  readonly conns = new Map<WebSocket, Set<number>>();
  private readonly persistence: YjsPersistence;
  private readonly logger: { warn: (obj: object, msg: string) => void };
  private isReady = false;
  private readonly readyPromise: Promise<void>;

  constructor(
    docId: string,
    persistence: YjsPersistence,
    logger: { warn: (obj: object, msg: string) => void },
  ) {
    this.docId = docId;
    this.persistence = persistence;
    this.logger = logger;
    this.doc = new YDoc();
    this.doc.gc = true;
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalState(null);

    this.readyPromise = persistence
      .bindState(docId, this.doc)
      .catch((err: unknown) => {
        this.logger.warn({ err, docId }, 'yjs bindState failed');
      })
      .finally(() => {
        this.isReady = true;
      });

    this.doc.on('update', this.handleDocUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  get isReadyNow(): boolean {
    return this.isReady;
  }

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Persist every update.
    void this.persistence.storeUpdate(this.docId, update).catch((err: unknown) => {
      this.logger.warn({ err, docId: this.docId }, 'yjs storeUpdate failed');
    });

    // Broadcast to all connected sockets except the originating one.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    for (const conn of this.conns.keys()) {
      if (conn === origin) continue;
      sendMessage(conn, message);
    }
  };

  private readonly handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const changed = added.concat(updated, removed);
    if (changed.length === 0) return;
    if (origin !== null && this.conns.has(origin as WebSocket)) {
      // Track which clientIDs are associated with this connection so we can
      // clean them up if the connection drops.
      const clientIds = this.conns.get(origin as WebSocket);
      if (clientIds !== undefined) {
        added.forEach((id) => clientIds.add(id));
        removed.forEach((id) => clientIds.delete(id));
      }
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, changed));
    const message = encoding.toUint8Array(encoder);
    for (const conn of this.conns.keys()) {
      sendMessage(conn, message);
    }
  };

  addConnection(conn: WebSocket): void {
    this.conns.set(conn, new Set());
  }

  removeConnection(conn: WebSocket): void {
    const clientIds = this.conns.get(conn);
    if (clientIds !== undefined && clientIds.size > 0) {
      removeAwarenessStates(this.awareness, Array.from(clientIds), null);
    }
    this.conns.delete(conn);
  }

  /**
   * Handle an incoming protocol message from `conn`. Returns the reply to
   * send (or undefined if there is no reply).
   */
  handleMessage(conn: WebSocket, data: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(data);
      const messageType = decoding.readVarUint(decoder);

      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        readSyncMessage(decoder, encoder, this.doc, conn);
        if (encoding.length(encoder) > 1) {
          sendMessage(conn, encoding.toUint8Array(encoder));
        }
      } else if (messageType === MESSAGE_AWARENESS) {
        applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), conn);
      }
    } catch (err) {
      this.logger.warn({ err, docId: this.docId }, 'yjs handleMessage error');
    }
  }

  /**
   * Send the initial sync step 1 and any current awareness state to a
   * newly connected client.
   */
  sendInitialState(conn: WebSocket): void {
    // sync step 1
    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
    writeSyncStep1(syncEncoder, this.doc);
    sendMessage(conn, encoding.toUint8Array(syncEncoder));

    // current awareness
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        aw,
        encodeAwarenessUpdate(this.awareness, Array.from(states.keys())),
      );
      sendMessage(conn, encoding.toUint8Array(aw));
    }
  }
}

function sendMessage(conn: WebSocket, data: Uint8Array): void {
  if (conn.readyState !== 1 /* OPEN */) return;
  try {
    conn.send(data, { binary: true });
  } catch {
    /* swallow; the conn close handler will clean up */
  }
}
