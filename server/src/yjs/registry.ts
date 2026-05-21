import { createYjsPersistence, type YjsPersistence } from '../services/yjsPersistence.js';

import { WSSharedDoc } from './sharedDoc.js';

import type { Database } from '@scribe/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Process-local registry of live Yjs docs. One process owns a doc; in a
 * multi-process deploy we'd need a Redis-backed sticky-session router, but
 * for v1 we run a single Fastify process and this map suffices.
 */
export class YjsRegistry {
  private readonly docs = new Map<string, WSSharedDoc>();
  private readonly persistence: YjsPersistence;
  private readonly logger: FastifyBaseLogger;

  constructor(supabase: SupabaseClient<Database>, logger: FastifyBaseLogger) {
    this.persistence = createYjsPersistence({ supabase });
    this.logger = logger;
  }

  async get(docId: string): Promise<WSSharedDoc> {
    const existing = this.docs.get(docId);
    if (existing !== undefined) {
      await existing.ready();
      return existing;
    }
    const doc = new WSSharedDoc(docId, this.persistence, this.logger);
    this.docs.set(docId, doc);
    await doc.ready();
    return doc;
  }

  remove(docId: string): void {
    this.docs.delete(docId);
  }

  removeIfEmpty(docId: string): void {
    const doc = this.docs.get(docId);
    if (doc?.conns.size === 0) {
      this.docs.delete(docId);
    }
  }
}
