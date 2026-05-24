// Sign in via Supabase token endpoint, then call /api/projects to inspect
// what our Fastify auth gate sees.

const SUPABASE_URL = 'https://sgmbvxqgowbpyehwmedv.supabase.co';
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNnbWJ2eHFnb3dicHllaHdtZWR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzNTQ0NDMsImV4cCI6MjA5NDkzMDQ0M30.5wsZnv6QVxUyLRMjuKx_rU0RB5MCzjSUN7-SzmynaFU';

const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
  body: JSON.stringify({ email: 'demo@scribe.local', password: 'Demo123!demo' }),
});
const session = await r.json();
console.log('signin status:', r.status);
if (!session.access_token) {
  console.log('no access_token. body:', JSON.stringify(session, null, 2));
  process.exit(1);
}

// Decode the JWT payload
const parts = session.access_token.split('.');
const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
console.log('JWT payload:', JSON.stringify(payload, null, 2));

// Now hit our backend
const api = await fetch('http://127.0.0.1:3000/api/projects', {
  headers: { Authorization: `Bearer ${session.access_token}` },
});
console.log('api status:', api.status);
console.log('api body:', await api.text());
