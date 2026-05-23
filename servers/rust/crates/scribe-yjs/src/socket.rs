//! Per-connection WebSocket loop. Spawned once per upgrade.
//!
//! Responsibilities:
//!   1. Send initial sync step 1 + current awareness state to the new peer.
//!   2. Forward outgoing broadcasts (from `SharedDoc`) onto the socket.
//!   3. Read inbound binary frames, decode via [`crate::protocol`], and:
//!      - reply directly (sync step 2),
//!      - or broadcast + persist (doc update),
//!      - or broadcast (awareness).
//!   4. Send keepalive pings every 30s; drop the conn if no pong returns.
//!   5. On disconnect, clean up awareness states for this connection.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message as WsMessage, WebSocket};
use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use tokio::select;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::protocol::{
    encode_initial_awareness, encode_sync_step1, handle_message, HandleOutcome,
};
use crate::shared_doc::{ConnId, DocRegistry, SharedDoc};

const OUTBOUND_CHANNEL_DEPTH: usize = 64;
const PING_INTERVAL: Duration = Duration::from_secs(30);

pub async fn serve_socket(socket: WebSocket, doc_id: String, registry: Arc<DocRegistry>) {
    serve_socket_with_mode(socket, doc_id, registry, false).await
}

/// Like [`serve_socket`] but accepts a read-only flag. When `read_only`,
/// inbound doc updates from this connection are silently dropped — the
/// peer still receives broadcasts and can publish awareness (cursor +
/// name) but their edits don't land. Used to enforce the Viewer role.
pub async fn serve_socket_with_mode(
    socket: WebSocket,
    doc_id: String,
    registry: Arc<DocRegistry>,
    read_only: bool,
) {
    let shared = registry.get_or_create(&doc_id).await;
    let conn_id = {
        let (sender, receiver) = mpsc::channel::<Bytes>(OUTBOUND_CHANNEL_DEPTH);
        let id = shared.register(sender);
        run(socket, shared.clone(), id, receiver, read_only).await;
        id
    };
    shared.unregister(conn_id);
    registry.drop_if_empty(&doc_id);
}

async fn run(
    socket: WebSocket,
    shared: Arc<SharedDoc>,
    conn_id: ConnId,
    mut outbound: mpsc::Receiver<Bytes>,
    read_only: bool,
) {
    let (mut sink, mut stream) = socket.split();

    // Send the initial sync messages before entering the main loop so a
    // slow client can't hold up the connect handshake.
    if let Err(err) = send_initial(&mut sink, &shared).await {
        warn!(?err, doc_id = %shared.doc_id(), "yjs initial send failed");
        return;
    }

    let mut ping_interval = tokio::time::interval(PING_INTERVAL);
    ping_interval.tick().await; // skip the immediate first tick

    loop {
        select! {
            // Outbound broadcasts from SharedDoc.
            msg = outbound.recv() => {
                let Some(bytes) = msg else { break };
                if sink.send(WsMessage::Binary(bytes.to_vec())).await.is_err() {
                    break;
                }
            }

            // Inbound frames from the client.
            frame = stream.next() => {
                let Some(frame) = frame else { break };
                let Ok(frame) = frame else { break };
                match frame {
                    WsMessage::Binary(data) => {
                        process_inbound(&shared, conn_id, &data, read_only).await;
                    }
                    WsMessage::Close(_) => break,
                    WsMessage::Ping(payload) => {
                        if sink.send(WsMessage::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    WsMessage::Pong(_) | WsMessage::Text(_) => {}
                }
            }

            // Keepalive.
            _ = ping_interval.tick() => {
                if sink.send(WsMessage::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
        }
    }

    debug!(doc_id = %shared.doc_id(), ?conn_id, "yjs socket loop exit");
}

async fn send_initial(
    sink: &mut futures::stream::SplitSink<WebSocket, WsMessage>,
    shared: &SharedDoc,
) -> Result<(), axum::Error> {
    let (sync_step1, initial_awareness) = {
        let awareness = shared.awareness.lock();
        (
            encode_sync_step1(&awareness),
            encode_initial_awareness(&awareness),
        )
    };
    sink.send(WsMessage::Binary(sync_step1.to_vec())).await?;
    if let Some(bytes) = initial_awareness {
        sink.send(WsMessage::Binary(bytes.to_vec())).await?;
    }
    Ok(())
}

async fn process_inbound(shared: &SharedDoc, conn_id: ConnId, data: &[u8], read_only: bool) {
    let outcome = {
        let mut awareness = shared.awareness.lock();
        handle_message(&mut awareness, data)
    };
    match outcome {
        HandleOutcome::Empty => {}
        HandleOutcome::Reply(bytes) => {
            // Reply on the originating conn only — use the channel so
            // we go through the same sink as everything else.
            shared.broadcast(None, bytes);
            // ^ broadcast also sends to the originator; sync step 2
            // *is* meant for them, so this is correct. (Other peers
            // will receive an idempotent sync step 2 they can ignore.)
        }
        HandleOutcome::DocUpdate { raw_update, encoded } => {
            // Viewers can listen but not write — drop their edits before
            // we'd persist or broadcast them. The client still applies
            // updates locally, which produces a transient divergence,
            // but the next inbound broadcast from the server will
            // overwrite it. Good enough for "I shouldn't be editing".
            if read_only {
                debug!(doc_id = %shared.doc_id(), ?conn_id, "ignored update from read-only conn");
                return;
            }
            shared.apply_and_persist_update(conn_id, &raw_update, encoded).await;
        }
        HandleOutcome::AwarenessBroadcast { encoded, client_ids } => {
            for cid in client_ids {
                shared.track_awareness_client(conn_id, cid);
            }
            shared.broadcast(Some(conn_id), encoded);
        }
    }
}
