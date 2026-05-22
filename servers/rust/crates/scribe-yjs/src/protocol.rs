//! Yjs binary message framing.
//!
//! Wire format mirrors `y-protocols/sync` and `y-protocols/awareness` on
//! the JS side so the existing y-websocket client (and our `apps/web`
//! ScribeYjsProvider) talk to this server unchanged. Every WS message
//! starts with a single byte message type:
//!
//!   * `MESSAGE_SYNC` (0)      — wraps a `y_sync::sync::Message`
//!   * `MESSAGE_AWARENESS` (1) — wraps an awareness state update
//!
//! Multi-byte numbers use lib0 varuint (the same encoding the JS side
//! uses), which is what `yrs::EncoderV1` produces by default.

use bytes::Bytes;
use std::collections::HashSet;
use y_sync::awareness::Awareness;
use y_sync::sync::{Message, MessageReader, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};
use yrs::{ReadTxn, Transact, Update};

pub const MESSAGE_SYNC: u8 = 0;
pub const MESSAGE_AWARENESS: u8 = 1;

/// Encode sync step 1 (state vector → "send me everything I'm missing").
/// Sent to a new client on connect.
///
/// `Message::encode` writes the outer `MSG_SYNC` tag itself, so we
/// don't add another one.
pub fn encode_sync_step1(awareness: &Awareness) -> Bytes {
    let sv = awareness.doc().transact().state_vector();
    let mut encoder = EncoderV1::new();
    Message::Sync(SyncMessage::SyncStep1(sv)).encode(&mut encoder);
    Bytes::from(encoder.to_vec())
}

/// Encode current awareness state — sent to a new client on connect so
/// they see who else is around.
pub fn encode_initial_awareness(awareness: &Awareness) -> Option<Bytes> {
    let clients: Vec<u64> = awareness.clients().keys().copied().collect();
    if clients.is_empty() {
        return None;
    }
    let update = awareness.update_with_clients(clients).ok()?;
    let mut encoder = EncoderV1::new();
    Message::Awareness(update).encode(&mut encoder);
    Some(Bytes::from(encoder.to_vec()))
}

/// Wrap a raw Yjs update into a sync-protocol `Update` message ready
/// to broadcast.
pub fn encode_sync_update(update: &[u8]) -> Bytes {
    let mut encoder = EncoderV1::new();
    Message::Sync(SyncMessage::Update(update.to_vec())).encode(&mut encoder);
    Bytes::from(encoder.to_vec())
}

/// Outcome of decoding/processing one inbound WS frame.
pub enum HandleOutcome {
    Empty,
    /// Reply destined for the originating connection (e.g. sync step 2
    /// in response to sync step 1).
    Reply(Bytes),
    /// Doc update: raw bytes for persistence + encoded sync message for
    /// broadcast to all OTHER conns.
    DocUpdate { raw_update: Vec<u8>, encoded: Bytes },
    /// Awareness update to broadcast. `client_ids` lists any newly-added
    /// client IDs from this frame so the caller can register them.
    AwarenessBroadcast { encoded: Bytes, client_ids: Vec<u64> },
}

/// Read one framed message from `data` and act on it. Doesn't touch
/// persistence or sockets — the caller wires those up using the
/// returned [`HandleOutcome`].
pub fn handle_message(awareness: &mut Awareness, data: &[u8]) -> HandleOutcome {
    let mut decoder = DecoderV1::from(data);
    let mut reader = MessageReader::new(&mut decoder);
    let Some(Ok(message)) = reader.next() else {
        return HandleOutcome::Empty;
    };

    match message {
        Message::Sync(sync) => handle_sync(awareness, sync),
        Message::Awareness(update) => {
            // Capture the connected client set before applying so we can
            // diff for newly-introduced IDs.
            let before: HashSet<u64> = awareness.clients().keys().copied().collect();
            if awareness.apply_update(update).is_err() {
                return HandleOutcome::Empty;
            }
            let after: HashSet<u64> = awareness.clients().keys().copied().collect();
            let client_ids: Vec<u64> = after.difference(&before).copied().collect();

            // Broadcast the original frame as-is — wire format is the
            // same for client-sent and server-sent awareness updates,
            // and AwarenessUpdate isn't Clone, so we'd otherwise have
            // to re-build a fresh update for re-encoding.
            HandleOutcome::AwarenessBroadcast {
                encoded: Bytes::copy_from_slice(data),
                client_ids,
            }
        }
        Message::Auth(_) | Message::AwarenessQuery | Message::Custom(_, _) => HandleOutcome::Empty,
    }
}

fn handle_sync(awareness: &mut Awareness, message: SyncMessage) -> HandleOutcome {
    match message {
        SyncMessage::SyncStep1(state_vector) => {
            // Reply with sync step 2 carrying the missing updates.
            let doc = awareness.doc();
            let update = doc.transact().encode_state_as_update_v1(&state_vector);
            let mut encoder = EncoderV1::new();
            Message::Sync(SyncMessage::SyncStep2(update)).encode(&mut encoder);
            HandleOutcome::Reply(Bytes::from(encoder.to_vec()))
        }
        SyncMessage::SyncStep2(update) | SyncMessage::Update(update) => {
            // Apply to local doc + emit the same wire bytes for broadcast.
            let Ok(parsed) = Update::decode_v1(&update) else {
                return HandleOutcome::Empty;
            };
            let doc = awareness.doc();
            let mut txn = doc.transact_mut();
            txn.apply_update(parsed);
            drop(txn);
            HandleOutcome::DocUpdate {
                raw_update: update.clone(),
                encoded: encode_sync_update(&update),
            }
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use yrs::Text;

    #[test]
    fn round_trip_sync_step1_starts_with_type_tag() {
        let doc = yrs::Doc::new();
        let awareness = Awareness::new(doc);
        let bytes = encode_sync_step1(&awareness);
        assert!(!bytes.is_empty());
        assert_eq!(bytes[0], MESSAGE_SYNC);
    }

    #[test]
    fn empty_frame_is_dropped() {
        let doc = yrs::Doc::new();
        let mut awareness = Awareness::new(doc);
        let outcome = handle_message(&mut awareness, &[]);
        assert!(matches!(outcome, HandleOutcome::Empty));
    }

    #[test]
    fn encode_sync_update_round_trips_through_handle() {
        let doc = yrs::Doc::new();
        let text = doc.get_or_insert_text("body");
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, "hello");
        }
        let update_bytes = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        let framed = encode_sync_update(&update_bytes);

        let fresh = yrs::Doc::new();
        let mut awareness = Awareness::new(fresh);
        let outcome = handle_message(&mut awareness, &framed);
        match outcome {
            HandleOutcome::DocUpdate { raw_update, .. } => {
                assert_eq!(raw_update, update_bytes);
            }
            _ => panic!("expected DocUpdate"),
        }
    }
}
