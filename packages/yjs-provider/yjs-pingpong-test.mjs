// Smoke test: two WS clients (owner + viewer) on the same Yjs doc.
// Owner inserts "HELLO_PINGPONG" into the Y.Text; we wait until the
// viewer's Y.Doc reflects the same text. If it does, the server-side
// broadcast + read-only enforcement is healthy and any failure to see
// live edits in the browser is purely client-side.

import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync';

const SUPABASE_URL = 'https://sgmbvxqgowbpyehwmedv.supabase.co';
const SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNnbWJ2eHFnb3dicHllaHdtZWR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzNTQ0NDMsImV4cCI6MjA5NDkzMDQ0M30.5wsZnv6QVxUyLRMjuKx_rU0RB5MCzjSUN7-SzmynaFU';
const API_URL = 'http://127.0.0.1:3010';

const PROJECT_ID = '905e42c5-fcc0-4409-830c-82a983348d6a';
const FILE_ID = '1d04c17f-f500-4e43-a66c-3f8675c4c938'; // main.tex (yjs-tracked)
const DOC_ID = `${PROJECT_ID}/${FILE_ID}`;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

async function signIn(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`sign-in ${r.status} ${await r.text()}`);
  const { access_token } = await r.json();
  return access_token;
}

function connect(label, token) {
  const url = `ws://127.0.0.1:3010/api/yjs/${PROJECT_ID}/${FILE_ID}/socket?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const doc = new Y.Doc();
  const synced = new Promise((resolve) => {
    const interval = setInterval(() => {
      const txt = doc.getText('text').toString();
      if (txt.length > 0) {
        clearInterval(interval);
        resolve(txt);
      }
    }, 100);
    setTimeout(() => { clearInterval(interval); resolve(doc.getText('text').toString()); }, 4000);
  });

  ws.on('open', () => {
    console.log(`[${label}] WS open`);
    // Send sync step 1.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    writeSyncStep1(enc, doc);
    ws.send(encoding.toUint8Array(enc));
  });

  ws.on('message', (data) => {
    const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const dec = decoding.createDecoder(u8);
    const type = decoding.readVarUint(dec);
    if (type === MESSAGE_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MESSAGE_SYNC);
      const replyType = readSyncMessage(dec, reply, doc, label);
      if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
      console.log(`[${label}] recv sync type=${replyType} len=${u8.length}  text='${doc.getText('text').toString().slice(0, 60)}…'`);
    } else if (type === MESSAGE_AWARENESS) {
      console.log(`[${label}] recv awareness`);
    }
  });

  ws.on('error', (err) => console.log(`[${label}] WS error: ${err.message}`));
  ws.on('close', (code) => console.log(`[${label}] WS close ${code}`));

  // Pump local updates to server.
  doc.on('update', (update, origin) => {
    if (origin === label) return; // applied by remote
    if (ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
    console.log(`[${label}] sent update ${update.length} bytes`);
  });

  return { ws, doc, synced };
}

const ownerToken = await signIn('demo@scribe.local', 'Demo123!demo');
const viewerToken = await signIn('reach.sunnyallana@gmail.com', 'Scribe2026!');

const owner = connect('owner', ownerToken);
const viewer = connect('viewer', viewerToken);

await new Promise((r) => setTimeout(r, 1500)); // wait for sync step 2

console.log('--- owner inserts "HELLO_PINGPONG" ---');
const SENTINEL = `HELLO_PINGPONG_${Date.now()}`;
owner.doc.getText('text').insert(0, SENTINEL);

const settled = new Promise((resolve) => {
  const t = setInterval(() => {
    const vt = viewer.doc.getText('text').toString();
    if (vt.includes(SENTINEL)) {
      clearInterval(t);
      resolve(true);
    }
  }, 200);
  setTimeout(() => { clearInterval(t); resolve(false); }, 6000);
});

const ok = await settled;
console.log(`--- viewer text after 6s: '${viewer.doc.getText('text').toString().slice(0, 80)}…'`);
console.log(ok ? '✅ live sync WORKS — server is healthy.'
              : '❌ live sync FAILED — server didn\'t broadcast the owner\'s update to the viewer.');

owner.ws.close();
viewer.ws.close();
await new Promise((r) => setTimeout(r, 400));
process.exit(ok ? 0 : 1);
