//! WebSocket route for project-scoped voice signaling.
//!
//! URL: `GET /api/projects/:project_id/voice?token=<jwt>`
//!
//! The server never touches audio media — it only relays SDP / ICE
//! exchanges between peers in the same project's voice room. Media
//! flows directly between browsers over DTLS-SRTP after the WebRTC
//! handshake completes. See `voice/mod.rs` for the room data model.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use scribe_auth::{require_auth, Authenticated, TokenVerifier};
use scribe_shared::{ApiError, ApiResult, ErrorCode, ProjectId};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::{debug, warn};
use uuid::Uuid;

use crate::services::membership::assert_member;
use crate::services::membership::require_role;
use crate::state::AppState;
use crate::voice::{ClientMsg, HubMsg, Peer};

#[derive(Deserialize)]
struct SocketQuery {
    token: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/projects/:project_id/voice", get(upgrade))
        .route(
            "/api/projects/:project_id/voice/peers",
            get(peers).layer(axum::middleware::from_fn(require_auth)),
        )
}

#[derive(Serialize)]
struct PeersResponse {
    peers: Vec<Peer>,
}

/// Read-only snapshot of the voice room. Used by clients that aren't
/// in the call to detect that *someone else* is — so the call icon
/// can show a badge "2 on call". Membership-gated; non-members get
/// the standard `NotFound` from `assert_member`.
async fn peers(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<PeersResponse>> {
    let project = ProjectId::new(project_id);
    let Some(db) = state.db() else {
        return Err(ApiError::new(
            ErrorCode::ServiceUnavailable,
            "database not configured",
        ));
    };
    assert_member(db.pool(), user.id, project).await?;
    let room = state.inner.voice_hub.room(project);
    let peers: Vec<Peer> = room.peers.iter().map(|e| e.value().clone()).collect();
    Ok(Json(PeersResponse { peers }))
}

async fn upgrade(
    State(state): State<AppState>,
    axum::extract::Extension(verifier): axum::extract::Extension<Arc<TokenVerifier>>,
    Path(project_id): Path<Uuid>,
    Query(query): Query<SocketQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    // Auth + membership BEFORE upgrade so unauthorised clients see
    // a clean 401 / 403 instead of a half-handshaken socket.
    let token = match query.token {
        Some(t) if !t.is_empty() => t,
        _ => return api_error(ApiError::unauthorized("missing token query parameter")),
    };
    let user = match verifier.verify(&token).await {
        Ok(u) => u,
        Err(err) => {
            warn!(?err, "voice token verify failed");
            return api_error(ApiError::unauthorized("invalid or expired token"));
        }
    };
    let Some(db) = state.db() else {
        return api_error(ApiError::new(
            ErrorCode::ServiceUnavailable,
            "database not configured",
        ));
    };
    let project = ProjectId::new(project_id);
    // Voice is read-write for any member — viewers can hear and be
    // heard. Different from Yjs which gates writes by role.
    if let Err(err) = require_role(db.pool(), user.id, project).await {
        return api_error(err);
    }
    let hub = state.inner.voice_hub.clone();
    let conn_id = Uuid::new_v4();
    let me = Peer { conn_id, user_id: user.id };
    // Signaling frames are JSON, max a few KB even for large SDPs.
    // Tight caps keep memory bounded under abuse.
    ws.max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| async move {
            serve(socket, project, me, hub).await;
        })
}

async fn serve(
    socket: WebSocket,
    project: ProjectId,
    me: Peer,
    hub: crate::voice::VoiceHub,
) {
    let room = hub.room(project);
    let mut rx = room.tx.subscribe();
    let (mut sink, mut stream) = socket.split();

    // Snapshot of who's already in the room — the new joiner uses
    // this to know whom to initiate offers to. Taken BEFORE inserting
    // ourselves so we don't include self.
    let current_peers: Vec<Peer> =
        room.peers.iter().map(|e| e.value().clone()).collect();
    let welcome = HubMsg::Welcome {
        welcome_for: me.conn_id,
        peers: current_peers,
    };
    // Direct send — broadcast would deliver this to every peer
    // including ourselves, which is wasteful but harmless thanks
    // to the filtering below. Sending direct is faster and cleaner.
    if let Ok(text) = serde_json::to_string(&welcome) {
        let _ = sink.send(Message::Text(text)).await;
    }

    // Register self + announce.
    room.peers.insert(me.conn_id, me.clone());
    let _ = room.tx.send(HubMsg::PeerJoined { peer: me.clone() });
    debug!(%project, conn_id = %me.conn_id, user_id = %me.user_id, "voice peer joined");

    let my_conn = me.conn_id;
    let room_for_write = room.clone();
    // Write loop: forward broadcast messages to the WS, filtering
    // out anything that isn't relevant to this connection.
    let write_task = tokio::spawn(async move {
        loop {
            let msg = match rx.recv().await {
                Ok(m) => m,
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "voice room broadcast lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            };
            // Filter:
            //   • Welcome only goes to its target (broadcast carries
            //     `welcome_for` so other peers can ignore it — but
            //     in this design we send Welcome direct, so the
            //     filter below also covers the unlikely case it
            //     leaks into the broadcast channel).
            //   • Signal only goes to its `to`.
            //   • PeerJoined / PeerLeft / Muted go to everyone
            //     EXCEPT the source.
            let send_it = match &msg {
                HubMsg::Welcome { welcome_for, .. } => *welcome_for == my_conn,
                HubMsg::Signal { from, to, .. } => {
                    *from != my_conn && *to == my_conn
                }
                HubMsg::PeerJoined { peer } => peer.conn_id != my_conn,
                HubMsg::PeerLeft { conn_id } => *conn_id != my_conn,
                HubMsg::Muted { conn_id, .. } => *conn_id != my_conn,
            };
            if !send_it {
                continue;
            }
            let text = match serde_json::to_string(&msg) {
                Ok(t) => t,
                Err(_) => continue,
            };
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
        // Drop the sink reference held by `sink` so the read-side
        // disconnect cleanup below isn't blocked.
        drop(sink);
        // `room_for_write` cleanup happens on the read-side after
        // the read loop exits.
        let _ = &room_for_write;
    });

    // Read loop: parse inbound messages, broadcast onto the room.
    while let Some(frame) = stream.next().await {
        let Ok(frame) = frame else { break };
        let text = match frame {
            Message::Text(t) => t,
            Message::Close(_) => break,
            // Ignore binary / ping — clients should only ever send text JSON.
            _ => continue,
        };
        let parsed: Result<ClientMsg, _> = serde_json::from_str(&text);
        let Ok(msg) = parsed else {
            warn!(conn_id = %my_conn, "malformed voice signaling frame");
            continue;
        };
        match msg {
            ClientMsg::Signal { to, payload } => {
                let _ = room.tx.send(HubMsg::Signal {
                    from: my_conn,
                    to,
                    payload,
                });
            }
            ClientMsg::Mute { muted } => {
                let _ = room.tx.send(HubMsg::Muted {
                    conn_id: my_conn,
                    muted,
                });
            }
        }
    }

    // Cleanup. Order matters: remove from peers map first so a
    // future broadcast doesn't try to deliver to a dead conn,
    // then announce the departure, then garbage-collect the room
    // if it's now empty.
    room.peers.remove(&my_conn);
    let _ = room.tx.send(HubMsg::PeerLeft { conn_id: my_conn });
    write_task.abort();
    hub.drop_if_empty(project);
    debug!(%project, conn_id = %my_conn, "voice peer left");
}

fn api_error(err: ApiError) -> Response {
    err.into_response()
}
