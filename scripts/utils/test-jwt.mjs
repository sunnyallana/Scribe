// Verify which interpretation of SUPABASE_JWT_SECRET correctly validates
// a known Supabase-issued JWT. Try UTF-8 raw and base64-decoded.

import { createSecretKey } from 'node:crypto';
import { jwtVerify } from 'jose';

const SECRET_STR = 'DzSohoxKlB+F1ceb7dg99rLMGtcFFnIYdU8LR/45q5i888HJjBk/mZioco/QWFgL6g6x9DBBCtORYhlghjWHAA==';
const ANON_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNnbWJ2eHFnb3dicHllaHdtZWR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzNTQ0NDMsImV4cCI6MjA5NDkzMDQ0M30.5wsZnv6QVxUyLRMjuKx_rU0RB5MCzjSUN7-SzmynaFU';

async function tryKey(label, key) {
  try {
    const { payload } = await jwtVerify(ANON_JWT, key, { algorithms: ['HS256'] });
    console.log(`✅ ${label} — verified. payload.role = ${payload.role}`);
  } catch (e) {
    console.log(`❌ ${label} — ${e.message}`);
  }
}

await tryKey('utf-8 raw', createSecretKey(SECRET_STR, 'utf-8'));
await tryKey('base64 decoded', createSecretKey(Buffer.from(SECRET_STR, 'base64')));
await tryKey('base64url decoded', createSecretKey(Buffer.from(SECRET_STR.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url')));
