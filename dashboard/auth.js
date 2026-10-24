// Protection par code PIN du dashboard quand il est visible sur le reseau (iHost).
//
// - Requetes locales (127.0.0.1 / ::1) : toujours acceptees.
// - Les autres doivent presenter le cookie `maison=<jeton>` obtenu par POST /api/login {pin}.
//   Les jetons sont gardes dans ${dataDir}/access.json (survivent au redemarrage).
// - 5 codes faux par IP -> 429 pendant 10 minutes.
// - GET / (et tout ce qui n'est pas /api/*) passe toujours : la page affiche elle-meme l'ecran "code".
// - GET /api/login-required -> { required, pinConfigured }
// - Autre /api/* sans jeton -> 401 { error: "login" }. Sans MAISON_PIN configure, l'acces distant est
//   refuse (403 { error: "pin-not-set" }) : on ne laisse jamais le dashboard ouvert a tout le reseau.
//
// Usage dans server.js, tout en haut du handler HTTP :  if (auth.handle(req, res)) return;
const crypto = require('crypto');
const config = require('./config');

const ACCESS_FILE = 'access.json';
const COOKIE = 'maison';
const TOKEN_DAYS = 365;
const MAX_TOKENS = 50;
const MAX_FAILS = 5;
const BLOCK_MS = 10 * 60000;

let store = config.readJson(ACCESS_FILE, { tokens: [] });
if (!store || !Array.isArray(store.tokens)) store = { tokens: [] };
const save = () => { try { config.writeJson(ACCESS_FILE, store); } catch (e) { console.log('[auth] access.json :', e.message); } };

const fails = new Map();   // ip -> { count, until }

const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');

function clientIp(req) {
    const a = (req.socket && req.socket.remoteAddress) || '';
    return a.startsWith('::ffff:') ? a.slice(7) : a;
}

function isLocal(req) {
    const ip = clientIp(req);
    return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function tokenOf(req) {
    const t = cookies(req)[COOKIE];
    if (!t) return null;
    const h = hash(t);
    const now = Date.now();
    const rec = store.tokens.find(x => x.hash === h);
    if (!rec || (rec.expiresAt && rec.expiresAt < now)) return null;
    if (now - (rec.lastSeen || 0) > 3600000) { rec.lastSeen = now; save(); }
    return rec;
}

const isAuthed = req => !!config.env.pin && !!tokenOf(req);

function json(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
    return true;
}

function readBody(req, limit = 2048) {
    return new Promise(resolve => {
        let b = '';
        req.on('data', c => { b += c; if (b.length > limit) { b = ''; req.destroy(); } });
        req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
        req.on('error', () => resolve({}));
    });
}

function blocked(ip) {
    const f = fails.get(ip);
    if (!f) return 0;
    if (f.until && f.until > Date.now()) return f.until;
    if (f.until) fails.delete(ip);   // blocage termine
    return 0;
}

function pinMatches(pin) {
    const a = Buffer.from(String(pin || '')), b = Buffer.from(config.env.pin);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function issueToken(req, res) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    store.tokens.push({ hash: hash(token), createdAt: now, lastSeen: now, expiresAt: now + TOKEN_DAYS * 86400000,
        ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 120) });
    store.tokens = store.tokens.filter(t => !t.expiresAt || t.expiresAt > now).slice(-MAX_TOKENS);
    save();
    const cookie = `${COOKIE}=${token}; Path=/; Max-Age=${TOKEN_DAYS * 86400}; HttpOnly; SameSite=Lax`;
    return json(res, 200, { ok: true }, { 'set-cookie': cookie });
}

async function login(req, res) {
    if (!config.env.pin) return json(res, 403, { error: 'pin-not-set', message: 'Aucun code configuré (variable MAISON_PIN).' });
    const ip = clientIp(req);
    const until = blocked(ip);
    if (until) return json(res, 429, { error: 'too-many', retryAfter: Math.ceil((until - Date.now()) / 1000) }, { 'retry-after': String(Math.ceil((until - Date.now()) / 1000)) });
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (pinMatches(body.pin)) { fails.delete(ip); return issueToken(req, res); }
    const f = fails.get(ip) || { count: 0, until: 0 };
    f.count++;
    if (f.count >= MAX_FAILS) { f.until = Date.now() + BLOCK_MS; f.count = 0; console.log(`[auth] ${ip} bloquee 10 min (codes faux)`); }
    fails.set(ip, f);
    if (f.until) return json(res, 429, { error: 'too-many', retryAfter: Math.ceil(BLOCK_MS / 1000) });
    return json(res, 401, { error: 'pin', remaining: MAX_FAILS - f.count });
}

function logout(req, res) {
    const t = cookies(req)[COOKIE];
    if (t) { const h = hash(t); store.tokens = store.tokens.filter(x => x.hash !== h); save(); }
    return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` });
}

// -> true si la requete a ete entierement traitee (ou refusee) ici ; false = le serveur continue normalement.
function handle(req, res) {
    const url = (req.url || '/').split('?')[0];
    if (!url.startsWith('/api/')) return false;             // page, icones, manifeste : toujours servis
    if (url === '/api/login-required' && req.method === 'GET') {
        const local = isLocal(req);
        return json(res, 200, { required: !local && !isAuthed(req), pinConfigured: !!config.env.pin, local });
    }
    if (url === '/api/login' && req.method === 'POST') { login(req, res); return true; }
    if (url === '/api/logout' && req.method === 'POST') return logout(req, res);
    if (isLocal(req)) return false;
    if (!config.env.pin) return json(res, 403, { error: 'pin-not-set', message: 'Accès distant refusé : définis la variable MAISON_PIN.' });
    if (tokenOf(req)) return false;
    return json(res, 401, { error: 'login' });
}

module.exports = { handle, isLocal, isAuthed, clientIp };
