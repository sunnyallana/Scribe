//! Per-project voice signaling hub.
//!
//! WebRTC needs a side-channel to exchange SDP offers/answers and ICE
//! candidates before the peer-to-peer connection is established. We
//! provide that channel here: each project has its own room of
//! WebSocket-connected clients; the server fans out signaling
//! messages but never touches audio media (that flows browser-to-
//! browser, end-to-end encrypted via DTLS-SRTP, after handshake).
//!
//! Topology: full mesh. Each peer maintains an RTCPeerConnection to
//! every other peer in the same project's voice room. Works well up
//! to ~5 participants — beyond that, each peer's upload bandwidth
//! becomes the bottleneck and an SFU would be required.

use std::sync::Arc;

use dashmap::DashMap;
use scribe_shared::{ProjectId, UserId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;
use uuid::Uuid;

/// One WebSocket connection in a voice room. We assign every
/// connection a fresh `conn_id` rather than reusing `user_id` so a
/// single human can join from two tabs without colliding.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub conn_id: Uuid,
    pub user_id: UserId,
}

/// Hub-emitted messages. Serialised to JSON and pushed to every
/// connected peer (or unicast via the `to` field on `Signal`).
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HubMsg {
    /// Sent on first connect — tells the new peer who's already in
    /// the room so they can initiate offers to each existing peer.
    /// Broadcast through the channel but `welcomeFor` lets the
    /// write loop filter it down to one recipient.
    Welcome {
        welcome_for: Uuid,
        peers: Vec<Peer>,
    },
    /// Broadcast to every other peer when someone joins. The new
    /// peer's `Welcome` covers the inverse direction.
    PeerJoined { peer: Peer },
    /// Broadcast when a peer disconnects (graceful or not).
    PeerLeft { conn_id: Uuid },
    /// SDP / ICE between two specific peers. The write loop only
    /// forwards this to the connection matching `to`.
    Signal {
        from: Uuid,
        to: Uuid,
        payload: Value,
    },
    /// Mute state changes. Broadcast — every other peer mirrors it
    /// so the UI can show a struck-through mic on the avatar.
    Muted {
        conn_id: Uuid,
        muted: bool,
    },
}

/// Inbound messages from a connected client.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMsg {
    /// Forward an SDP/ICE payload to another peer.
    Signal { to: Uuid, payload: Value },
    /// Announce a mute toggle. The hub re-broadcasts as `Muted`.
    Mute { muted: bool },
}

/// Per-project room. The broadcast channel fans out every event to
/// all current subscribers; the `peers` map keeps a snapshot so new
/// joiners can be sent the welcome list synchronously.
pub struct VoiceRoom {
    pub peers: DashMap<Uuid, Peer>,
    pub tx: broadcast::Sender<HubMsg>,
}

impl VoiceRoom {
    fn new() -> Self {
        // Capacity sized for short bursts of ICE-candidate flurries
        // when peers join. Lagged receivers just resync — signaling
        // messages are idempotent so an occasional drop is fine.
        let (tx, _) = broadcast::channel(128);
        Self { peers: DashMap::new(), tx }
    }
}

/// Top-level registry, lives on `AppState`. Cloning is cheap (`Arc`).
#[derive(Clone, Default)]
pub struct VoiceHub {
    rooms: Arc<DashMap<ProjectId, Arc<VoiceRoom>>>,
}

impl VoiceHub {
    pub fn new() -> Self {
        Self { rooms: Arc::new(DashMap::new()) }
    }

    /// Get or create the room for a project.
    pub fn room(&self, project: ProjectId) -> Arc<VoiceRoom> {
        self.rooms
            .entry(project)
            .or_insert_with(|| Arc::new(VoiceRoom::new()))
            .clone()
    }

    /// Garbage-collect a room with no peers left so the broadcast
    /// channel and dashmap entry are released. Cheap — only fires
    /// on the last leave.
    pub fn drop_if_empty(&self, project: ProjectId) {
        if let Some(entry) = self.rooms.get(&project) {
            if entry.value().peers.is_empty() {
                drop(entry);
                self.rooms.remove(&project);
            }
        }
    }
}
