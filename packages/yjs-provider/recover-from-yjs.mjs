// Recovery: read main.tex from the Yjs persistence (it still has the
// pre-corruption content) and PUT it back to Storage.

import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { readSyncMessage, writeSyncStep1 } from 'y-protocols/sync';

const SUPABASE_URL = 'https://sgmbvxqgowbpyehwmedv.supabase.co';
const SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNnbWJ2eHFnb3dicHllaHdtZWR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzNTQ0NDMsImV4cCI6MjA5NDkzMDQ0M30.5wsZnv6QVxUyLRMjuKx_rU0RB5MCzjSUN7-SzmynaFU';
const API_URL = 'http://127.0.0.1:3010';

const PROJECT_ID = '905e42c5-fcc0-4409-830c-82a983348d6a';
const FILE_ID = '1d04c17f-f500-4e43-a66c-3f8675c4c938';

const MESSAGE_SYNC = 0;

async function signIn() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@scribe.local', password: 'Demo123!demo' }),
  });
  const { access_token } = await r.json();
  return access_token;
}

const token = await signIn();
const url = `ws://127.0.0.1:3010/api/yjs/${PROJECT_ID}/${FILE_ID}/socket?token=${encodeURIComponent(token)}`;
const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';
const doc = new Y.Doc();

ws.on('open', () => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  writeSyncStep1(enc, doc);
  ws.send(encoding.toUint8Array(enc));
});

ws.on('message', (data) => {
  try {
    const u8 = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const dec = decoding.createDecoder(u8);
    const type = decoding.readVarUint(dec);
    console.log(`  ws msg type=${type} len=${u8.length}`);
    if (type === MESSAGE_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MESSAGE_SYNC);
      readSyncMessage(dec, reply, doc, 'recover');
      console.log(`    after readSyncMessage: yText.length=${doc.getText('text').length}`);
    }
  } catch (err) {
    console.log('  (skip malformed frame:', err.message, ')');
  }
});

// Wait 2s for sync step 2 to land.
await new Promise((r) => setTimeout(r, 2000));
ws.close();

const recovered = doc.getText('text').toString();
console.log(`Recovered from Yjs: ${recovered.length} bytes`);
console.log(`first 80 chars: '${recovered.slice(0, 80)}'`);

if (recovered.length === 0) {
  console.error('Yjs persistence is also empty — nothing to recover.');
  process.exit(1);
}

// PUT to /api/files/...
const put = await fetch(
  `${API_URL}/api/projects/${PROJECT_ID}/files/${FILE_ID}/content`,
  {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: recovered }),
  },
);
console.log(`PUT returned ${put.status}`);
const respBody = await put.json();
console.log(`  size_bytes=${respBody.size_bytes}`);

// Verify
const verify = await fetch(
  `${API_URL}/api/projects/${PROJECT_ID}/files/${FILE_ID}/content`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const verifyBody = await verify.json();
console.log(`Storage after recovery: ${verifyBody.content.length} bytes`);
console.log(`Match? ${verifyBody.content === recovered}`);
process.exit(0);
