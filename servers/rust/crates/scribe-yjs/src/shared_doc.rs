//! `WSSharedDoc` — the live, server-side instance of a Yjs document.
//!
//! One per `(project_id, file_id)` pair, identified by `docId =
//! "{project_id}/{file_id}"`. Holds the canonical `yrs::Doc`, an
//! `Awareness` instance, and the set of currently-connected clients.
//! Every client edit:
//!
//!   1. arrives as a y-sync protocol message on a WebSocket,
//!   2. is decoded + applied to the Doc (via `apply_update`),
//!   3. is persisted to Postgres,
//!   4. is broadcast to all OTHER connected clients.
//!
//! Awareness updates (cursor positions, names) flow through the same
//! WebSocket but aren't persisted.

use std::sync::Arc;

use bytes::Bytes;
use dashmap::DashMap;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};
use uuid::Uuid;
use y_sync::awareness::Awareness;
use yrs::Doc;

use crate::persistence::YjsPersistence;

/// Outgoing message channel for a single connection. Bounded so a slow
/// peer can't unbound-buffer our memory; we drop the connection if it
/// can't keep up.
pub type ConnSender = mpsc::Sender<Bytes>;

/// One connected WebSocket as seen by the shared doc.
struct Conn {
    /// Stable id we use in broadcast loops to skip the originating conn.
    id: ConnId,
    sender: ConnSender,
    /// Awareness client IDs introduced by this connection. Cleared on disconnect.
    awareness_clients: parking_lot::Mutex<Vec<u64>>,
}

/// Opaque connection identifier — distinct per WebSocket attach.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ConnId(Uuid);

impl ConnId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ConnId {
    fn default() -> Self {
        Self::new()
    }
}

pub struct SharedDoc {
    doc_id: String,
    pub awareness: Mutex<Awareness>,
    conns: DashMap<ConnId, Arc<Conn>>,
    persistence: Arc<dyn YjsPersistence>,
}

impl SharedDoc {
    pub async fn new(doc_id: String, persistence: Arc<dyn YjsPersistence>) -> Arc<Self> {
        let doc = Doc::new();
        if let Err(err) = persistence.bind_state(&doc_id, &doc).await {
            warn!(?err, doc_id = %doc_id, "yjs bind_state failed");
        }
        let awareness = Mutex::new(Awareness::new(doc));
        Arc::new(Self { doc_id, awareness, conns: DashMap::new(), persistence })
    }

    pub fn doc_id(&self) -> &str {
        &self.doc_id
    }

    pub fn conn_count(&self) -> usize {
        self.conns.len()
    }

    pub fn register(&self, sender: ConnSender) -> ConnId {
        let id = ConnId::new();
        self.conns.insert(
            id,
            Arc::new(Conn { id, sender, awareness_clients: parking_lot::Mutex::new(Vec::new()) }),
        );
        debug!(doc_id = %self.doc_id, ?id, conn_count = self.conns.len(), "yjs conn registered");
        id
    }

    pub fn unregister(&self, id: ConnId) {
        if let Some((_, conn)) = self.conns.remove(&id) {
            let clients = conn.awareness_clients.lock().clone();
            if !clients.is_empty() {
                let mut awareness = self.awareness.lock();
                for client_id in clients {
                    awareness.remove_state(client_id);
                }
            }
            debug!(doc_id = %self.doc_id, ?id, conn_count = self.conns.len(), "yjs conn unregistered");
        }
    }

    /// Record awareness client IDs introduced by this connection so we
    /// can broadcast tombstones on disconnect.
    pub fn track_awareness_client(&self, id: ConnId, client_id: u64) {
        if let Some(conn) = self.conns.get(&id) {
            let mut clients = conn.awareness_clients.lock();
            if !clients.contains(&client_id) {
                clients.push(client_id);
            }
        }
    }

    /// Broadcast a message to every connection except the originator.
    /// Sends are non-blocking — if a peer's channel is full we drop the
    /// frame for that peer rather than blocking the doc.
    pub fn broadcast(&self, except: Option<ConnId>, message: Bytes) {
        for entry in self.conns.iter() {
            let conn = entry.value();
            if Some(conn.id) == except {
                continue;
            }
            if let Err(err) = conn.sender.try_send(message.clone()) {
                debug!(doc_id = %self.doc_id, ?err, "dropping ws frame to slow peer");
            }
        }
    }

    /// Apply an incoming Yjs update to the doc, persist it, and broadcast.
    pub async fn apply_and_persist_update(
        &self,
        from: ConnId,
        bytes: &[u8],
        encoded_message: Bytes,
    ) {
        // Persist BEFORE broadcasting so a successful broadcast guarantees
        // we'd recover that update on restart. Errors here are logged but
        // don't block the broadcast — losing a single delta is preferable
        // to losing the user's typing experience.
        if let Err(err) = self.persistence.store_update(&self.doc_id, bytes).await {
            warn!(?err, doc_id = %self.doc_id, "yjs persist failed");
        }
        info!(
            doc_id = %self.doc_id,
            from = ?from,
            update_bytes = bytes.len(),
            peer_count = self.conns.len(),
            "yjs update persisted + broadcast"
        );
        self.broadcast(Some(from), encoded_message);
    }

    /// Snapshot the in-memory Doc state. Used when sending sync step 2
    /// to a new peer.
    pub fn encoded_state(&self) -> Vec<u8> {
        use yrs::{ReadTxn, Transact};
        let awareness = self.awareness.lock();
        let doc = awareness.doc();
        let txn = doc.transact();
        txn.encode_state_as_update_v1(&yrs::StateVector::default())
    }
}

/// Process-wide registry of live docs. Same doc_id from different
/// requests reuses the in-memory Doc; idle docs (no connections) are
/// dropped after the last `unregister`.
pub struct DocRegistry {
    persistence: Arc<dyn YjsPersistence>,
    docs: DashMap<String, Arc<SharedDoc>>,
    /// Async lock to make get-or-create atomic per doc_id. DashMap's
    /// entry API isn't async-friendly, so we synchronize separately.
    init_lock: tokio::sync::Mutex<()>,
}

impl DocRegistry {
    pub fn new(persistence: Arc<dyn YjsPersistence>) -> Arc<Self> {
        Arc::new(Self {
            persistence,
            docs: DashMap::new(),
            init_lock: tokio::sync::Mutex::new(()),
        })
    }

    pub async fn get_or_create(&self, doc_id: &str) -> Arc<SharedDoc> {
        if let Some(existing) = self.docs.get(doc_id) {
            return existing.clone();
        }
        // Hold init_lock so two concurrent first-connections don't both
        // build a SharedDoc and race on bind_state.
        let _guard = self.init_lock.lock().await;
        if let Some(existing) = self.docs.get(doc_id) {
            return existing.clone();
        }
        let doc = SharedDoc::new(doc_id.to_string(), self.persistence.clone()).await;
        self.docs.insert(doc_id.to_string(), doc.clone());
        doc
    }

    /// Drop the doc if no clients remain. Called from the per-connection
    /// task when it sees `conn_count == 0` after unregister.
    pub fn drop_if_empty(&self, doc_id: &str) {
        if let Some(entry) = self.docs.get(doc_id) {
            if entry.conn_count() == 0 {
                drop(entry);
                self.docs.remove_if(doc_id, |_, doc| doc.conn_count() == 0);
            }
        }
    }
}
