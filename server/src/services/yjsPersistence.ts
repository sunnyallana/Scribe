import { applyUpdate, encodeStateAsUpdate, type Doc as YDoc } from 'yjs';

import type { Database } from '@scribe/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface YjsPersistenceDeps {
  readonly supabase: SupabaseClient<Database>;
  /** When a doc accumulates more than this many updates, compact on next bind. */
  readonly compactionThreshold?: number;
}

export interface YjsPersistence {
  /** Load all stored updates for a doc and apply them to the in-memory Y.Doc. */
  bindState(docId: string, ydoc: YDoc): Promise<void>;
  /** Append a single new update. */
  storeUpdate(docId: string, update: Uint8Array): Promise<void>;
  /** Snapshot a doc — replace all rows with a single compacted update. */
  compact(docId: string, ydoc: YDoc): Promise<void>;
}

const DEFAULT_COMPACTION_THRESHOLD = 100;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function createYjsPersistence({
  supabase,
  compactionThreshold = DEFAULT_COMPACTION_THRESHOLD,
}: YjsPersistenceDeps): YjsPersistence {
  return {
    async bindState(docId, ydoc): Promise<void> {
      const { data, error } = await supabase
        .from('yjs_updates')
        .select('id, update_data')
        .eq('doc_id', docId)
        .order('id', { ascending: true });

      if (error !== null) {
        throw new Error(`yjs_updates load failed: ${error.message}`);
      }

      for (const row of data) {
        try {
          applyUpdate(ydoc, fromBase64(row.update_data));
        } catch {
          // Skip a corrupted row rather than throwing; the rest still apply.
        }
      }

      if (data.length > compactionThreshold) {
        await this.compact(docId, ydoc);
      }
    },

    async storeUpdate(docId, update): Promise<void> {
      const { error } = await supabase
        .from('yjs_updates')
        .insert({ doc_id: docId, update_data: toBase64(update) });
      if (error !== null) {
        throw new Error(`yjs_updates insert failed: ${error.message}`);
      }
    },

    async compact(docId, ydoc): Promise<void> {
      const snapshot = encodeStateAsUpdate(ydoc);
      // Delete-then-insert in a single client roundtrip would need an RPC;
      // PostgREST doesn't expose transactions. We accept a brief window
      // where the doc has both old rows and the new snapshot — both are
      // valid Yjs updates, applying both yields the same state.
      const insert = await supabase
        .from('yjs_updates')
        .insert({ doc_id: docId, update_data: toBase64(snapshot), clock: 0 })
        .select('id')
        .single();
      if (insert.error !== null || insert.data === null) {
        throw new Error(`yjs_updates snapshot insert failed: ${insert.error?.message ?? 'unknown'}`);
      }
      const snapshotId = insert.data.id;
      await supabase
        .from('yjs_updates')
        .delete()
        .eq('doc_id', docId)
        .lt('id', snapshotId);
    },
  };
}
