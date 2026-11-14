// Grate City submissions API (Cloudflare Worker + D1).
//
// Public:
//   POST /submit            multipart form: lat, lon, address, cleaned, name, email, note, photos (1-4 images)
//   GET  /approved          approved submissions as map entries
//   GET  /photo/:id         an approved submission's photo (admins can see pending ones too)
// Admin (Authorization: Bearer <ADMIN_KEY>):
//   GET  /admin/list?status=pending|approved|rejected
//   POST /admin/:id/approve  JSON {address?, label?, cleaned?}
//   POST /admin/:id/reject
//   GET  /admin/check

const ALLOWED_ORIGINS = ['https://grate.city', 'https://www.grate.city', 'https://benbarth2.github.io', 'http://localhost:8765'];
const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 2_500_000;   // the page shrinks photos before upload; this is a backstop
const MAX_PER_HOUR = 12;             // per IP
// Rough box around greater New Orleans
const BOUNDS = { minLat: 29.80, maxLat: 30.15, minLon: -90.40, maxLon: -89.75 };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const p = url.pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'POST' && p === '/submit') return await submit(req, env, cors);
      if (req.method === 'GET' && p === '/approved') return await approved(env, cors, url);
      let m;
      if (req.method === 'GET' && (m = p.match(/^\/photo\/(\d+)$/))) return await photo(req, env, cors, +m[1]);
      if (p.startsWith('/admin')) {
        if (!isAdmin(req, env)) return json({ error: 'Wrong admin key' }, 401, cors);
        if (req.method === 'GET' && p === '/admin/check') return json({ ok: true }, 200, cors);
        if (req.method === 'GET' && p === '/admin/list') return await adminList(env, cors, url);
        if (req.method === 'POST' && (m = p.match(/^\/admin\/(\d+)\/(approve|reject|pending)$/))) return await adminSet(req, env, cors, +m[1], m[2]);
      }
      if (p === '/') return json({ service: 'Grate City submissions' }, 200, cors);
      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      console.error(e);
      return json({ error: 'Something went wrong. Please try again.' }, 500, cors);
    }
  },
};

function json(obj, status, headers, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json', ...extra } });
}

function isAdmin(req, env) {
  const h = req.headers.get('Authorization') || '';
  const key = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!env.ADMIN_KEY || !key || key.length !== env.ADMIN_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ env.ADMIN_KEY.charCodeAt(i);
  return diff === 0;
}

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

async function submit(req, env, cors) {
  const ct = req.headers.get('Content-Type') || '';
  if (!ct.includes('multipart/form-data')) return json({ error: 'Expected a form upload.' }, 400, cors);
  const f = await req.formData();
  if (clean(f.get('website'), 100)) return json({ ok: true }, 200, cors); // honeypot: quietly drop bots

  const lat = Number(f.get('lat')), lon = Number(f.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lon < BOUNDS.minLon || lon > BOUNDS.maxLon)
    return json({ error: 'Please drop the pin on the basin you cleaned (it needs to be in the New Orleans area).' }, 400, cors);
  const cleaned = clean(f.get('cleaned'), 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return json({ error: 'Please pick the date you cleaned it.' }, 400, cors);
  const today = new Date().toISOString().slice(0, 10);
  if (cleaned > today || cleaned < '2025-01-01') return json({ error: 'That date doesn’t look right.' }, 400, cors);

  const files = f.getAll('photos').filter(x => x && typeof x === 'object' && x.size > 0);
  if (files.length > MAX_PHOTOS) return json({ error: `Up to ${MAX_PHOTOS} photos, please.` }, 400, cors);
  for (const x of files) {
    if (!/^image\/(jpeg|png|webp)$/.test(x.type)) return json({ error: 'Photos need to be JPEG, PNG or WebP.' }, 400, cors);
    if (x.size > MAX_PHOTO_BYTES) return json({ error: 'One of the photos is too large.' }, 400, cors);
  }

  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE ip = ? AND created > datetime('now','-1 hour')").bind(ip).first();
  if (recent && recent.n >= MAX_PER_HOUR) return json({ error: 'Lots of submissions from here in the last hour — please try again later.' }, 429, cors);

  const r = await env.DB.prepare(
    `INSERT INTO submissions (created, status, lat, lon, address, cleaned, name, email, note, ip)
     VALUES (datetime('now'), 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(lat, lon, clean(f.get('address'), 160), cleaned, clean(f.get('name'), 80), clean(f.get('email'), 120), clean(f.get('note'), 600), ip).run();
  const id = r.meta.last_row_id;
  for (const x of files) {
    const b64 = toB64(new Uint8Array(await x.arrayBuffer()));
    await env.DB.prepare('INSERT INTO photos (sub_id, type, data) VALUES (?, ?, ?)').bind(id, x.type, b64).run();
  }
  return json({ ok: true, id }, 200, cors);
}

async function approved(env, cors, url) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.lat, s.lon, s.address, s.cleaned, s.label,
            (SELECT group_concat(p.id) FROM photos p WHERE p.sub_id = s.id) AS photo_ids
     FROM submissions s WHERE s.status = 'approved' ORDER BY s.cleaned DESC, s.id DESC`
  ).all();
  const base = url.hostname === 'localhost' ? url.origin : 'https://' + url.host;
  const out = results.map(s => ({
    a: s.address || 'Submitted basin',
    d: s.cleaned,
    n: s.label || 'Neighbor submissions',
    lat: s.lat, lon: s.lon, p: 'sub', sid: s.id,
    ph: s.photo_ids ? String(s.photo_ids).split(',').map(i => `${base}/photo/${i}`) : [],
  }));
  return json(out, 200, cors, { 'Cache-Control': 'public, max-age=60' });
}

async function photo(req, env, cors, id) {
  const row = await env.DB.prepare('SELECT p.type, p.data, s.status FROM photos p JOIN submissions s ON s.id = p.sub_id WHERE p.id = ?').bind(id).first();
  if (!row) return json({ error: 'Not found' }, 404, cors);
  const url = new URL(req.url);
  const admin = isAdmin(req, env) || (url.searchParams.get('k') && isAdmin(new Request(req.url, { headers: { Authorization: 'Bearer ' + url.searchParams.get('k') } }), env));
  if (row.status !== 'approved' && !admin) return json({ error: 'Not found' }, 404, cors);
  return new Response(fromB64(row.data), {
    headers: { ...cors, 'Content-Type': row.type, 'Cache-Control': row.status === 'approved' ? 'public, max-age=86400' : 'private, no-store' },
  });
}

async function adminList(env, cors, url) {
  const status = ['pending', 'approved', 'rejected'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'pending';
  const { results } = await env.DB.prepare(
    `SELECT s.*, (SELECT group_concat(p.id) FROM photos p WHERE p.sub_id = s.id) AS photo_ids
     FROM submissions s WHERE s.status = ? ORDER BY s.id DESC LIMIT 200`
  ).bind(status).all();
  const counts = {};
  for (const r of (await env.DB.prepare('SELECT status, COUNT(*) AS n FROM submissions GROUP BY status').all()).results) counts[r.status] = r.n;
  return json({ counts, items: results.map(r => ({ ...r, ip: undefined, photo_ids: r.photo_ids ? String(r.photo_ids).split(',').map(Number) : [] })) }, 200, cors, { 'Cache-Control': 'no-store' });
}

async function adminSet(req, env, cors, id, action) {
  const status = { approve: 'approved', reject: 'rejected', pending: 'pending' }[action];
  let body = {};
  try { body = await req.json(); } catch {}
  const row = await env.DB.prepare('SELECT id FROM submissions WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'Not found' }, 404, cors);
  await env.DB.prepare(
    `UPDATE submissions SET status = ?, reviewed = datetime('now'),
       address = COALESCE(?, address), label = COALESCE(?, label), cleaned = COALESCE(?, cleaned) WHERE id = ?`
  ).bind(
    status,
    body.address != null ? clean(body.address, 160) : null,
    body.label != null ? (clean(body.label, 80) || null) : null,
    /^\d{4}-\d{2}-\d{2}$/.test(body.cleaned || '') ? body.cleaned : null,
    id
  ).run();
  return json({ ok: true, id, status }, 200, cors);
}

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
