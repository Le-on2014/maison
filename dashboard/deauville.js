// Deauville : ampoules Nanoleaf (Bluetooth via CLI Python), tele Sony BRAVIA (REST/IRCC), Samsung 43", Xbox.
// Toutes les sondes ont des delais courts : a Paris ces appareils sont simplement "hors de portee".
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const { spawn, execFile } = require('child_process');
const appConfig = require('./config');   // fichiers dans dataDir (dashboard/ sur le PC, /data dans le conteneur)

const CFG_FILE = 'deauville-config.json';
const DV_DIR = path.join(__dirname, '..', '..', 'Deauville');
const NL_PY = path.join(DV_DIR, 'venv', 'Scripts', 'python.exe');
const NL_SCRIPT = path.join(DV_DIR, 'tools', 'nanoleaf.py');

const PSK_HINT = 'Sur la télé Sony : Paramètres → Réseau → Configuration du réseau domestique → Contrôle IP → '
    + 'Authentification : « Normal et clé pré-partagée », puis choisir une clé pré-partagée. '
    + 'Recopier cette clé dans HueControl\\dashboard\\deauville-config.json (champ "sonyPsk"), sans redémarrer.';

const SONY = { key: 'sony', name: 'Télé du salon', brand: 'sony', ip: '192.168.1.19', house: 'deauville' };
const XBOX = { ip: '192.168.1.22' };

const BUTTONS = ['power', 'up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu', 'volup', 'voldown', 'mute',
    'chup', 'chdown', 'play', 'pause', 'source', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const SAMSUNG_KEYS = {
    power: 'KEY_POWER', up: 'KEY_UP', down: 'KEY_DOWN', left: 'KEY_LEFT', right: 'KEY_RIGHT', ok: 'KEY_ENTER',
    back: 'KEY_RETURN', home: 'KEY_HOME', menu: 'KEY_MENU', volup: 'KEY_VOLUP', voldown: 'KEY_VOLDOWN', mute: 'KEY_MUTE',
    chup: 'KEY_CHUP', chdown: 'KEY_CHDOWN', play: 'KEY_PLAY', pause: 'KEY_PAUSE', source: 'KEY_SOURCE',
};
const SONY_NAMES = {
    power: 'TvPower', up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'Confirm', back: 'Return', home: 'Home',
    menu: 'Options', volup: 'VolumeUp', voldown: 'VolumeDown', mute: 'Mute', chup: 'ChannelUp', chdown: 'ChannelDown',
    play: 'Play', pause: 'Pause', source: 'Input',
};
for (let i = 0; i <= 9; i++) { SAMSUNG_KEYS[i] = 'KEY_' + i; SONY_NAMES[i] = 'Num' + i; }

// ---------- utilitaires reseau ----------
function probe(ip, port, ms = 1500) {
    return new Promise(resolve => {
        const s = net.connect({ host: ip, port });
        const done = ok => { s.destroy(); resolve(ok); };
        s.setTimeout(ms, () => done(false));
        s.on('connect', () => done(true));
        s.on('error', () => done(false));
    });
}

function httpReq(opts, body, ms = 2000) {
    return new Promise((resolve, reject) => {
        const req = http.request(opts, res => {
            let b = '';
            res.setEncoding('utf8');
            res.on('data', c => b += c);
            res.on('end', () => resolve({ status: res.statusCode, body: b }));
        });
        const timer = setTimeout(() => req.destroy(new Error('hors de portée')), ms);   // connexion comprise
        req.on('error', e => { clearTimeout(timer); reject(e); });
        req.on('close', () => clearTimeout(timer));
        if (body) req.write(body);
        req.end();
    });
}

// ping : Windows (-n/-w en ms) ou Linux/Alpine (-c/-W en s) ; une reponse contient "ttl="
const PING_ARGS = process.platform === 'win32' ? ['-n', '1', '-w', '1000'] : ['-c', '1', '-W', '1'];
function ping(ip) {
    return new Promise(resolve => {
        execFile('ping', [...PING_ARGS, ip], { timeout: 2500, windowsHide: true },
            (err, out) => resolve(/ttl=/i.test(String(out || ''))));
    });
}

function wakeOnLan(mac) {
    const hex = mac.replace(/[^0-9a-f]/gi, '');
    const pkt = Buffer.from('ff'.repeat(6) + hex.repeat(16), 'hex');
    const s = dgram.createSocket('udp4');
    s.bind(() => {
        s.setBroadcast(true);
        s.send(pkt, 9, '255.255.255.255', () => s.send(pkt, 9, '192.168.1.255', () => s.close()));
    });
}

function config() {
    const c = appConfig.readJson(CFG_FILE, {});
    return c && typeof c === 'object' ? c : {};
}
// 1er lancement : fichier vide a remplir (la cle PSK de la Sony)
if (!appConfig.exists(CFG_FILE)) { try { appConfig.writeJson(CFG_FILE, { sonyPsk: '' }); } catch (e) { /* lecture seule */ } }

function pskError() {
    const e = new Error('psk');
    e.status = 409;
    e.body = { error: 'psk', hint: PSK_HINT };
    return e;
}

// ---------- Sony BRAVIA ----------
const psk = () => String(config().sonyPsk || '').trim();
let sonyPskRejected = null;   // la cle refusee (on reessaie si elle change)

async function sonyApi(service, method, params = [], needAuth = false) {
    const k = psk();
    if (needAuth && (!k || k === sonyPskRejected)) throw pskError();
    const body = JSON.stringify({ method, id: 1, params, version: '1.0' });
    const r = await httpReq({ host: SONY.ip, path: `/sony/${service}`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(k ? { 'X-Auth-PSK': k } : {}) } }, body);
    let j = {};
    try { j = JSON.parse(r.body); } catch (e) { /* vide */ }
    if (r.status === 403 || r.status === 401 || (j.error && (j.error[0] === 403 || j.error[0] === 401))) {
        if (k) sonyPskRejected = k;
        throw pskError();
    }
    if (j.error) throw new Error(`Sony : ${j.error[1] || j.error[0]}`);
    if (needAuth) sonyPskRejected = null;
    return j.result;
}

let sonyCodes = null;   // nom IRCC -> code
async function sonyLoadCodes() {
    if (sonyCodes) return sonyCodes;
    const r = await sonyApi('system', 'getRemoteControllerInfo');
    sonyCodes = Object.fromEntries((r[1] || []).map(c => [c.name, c.value]));
    return sonyCodes;
}

async function sonyIrcc(name) {
    const k = psk();
    if (!k || k === sonyPskRejected) throw pskError();
    const codes = await sonyLoadCodes();
    const code = codes[name];
    if (!code) throw new Error(`Touche Sony inconnue : ${name}`);
    const body = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        + `<s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>${code}</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>`;
    const r = await httpReq({ host: SONY.ip, path: '/sony/IRCC', method: 'POST', headers: {
        'content-type': 'text/xml; charset=UTF-8', SOAPACTION: '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
        'X-Auth-PSK': k, 'content-length': Buffer.byteLength(body) } }, body);
    if (r.status === 403 || r.status === 401) { sonyPskRejected = k; throw pskError(); }
    if (r.status !== 200) throw new Error(`Sony IRCC : HTTP ${r.status}`);
    sonyPskRejected = null;
}

async function sonyPowerToggle() {
    const st = await sonyApi('system', 'getPowerStatus');
    const on = st && st[0] && st[0].status === 'active';
    await sonyApi('system', 'setPowerStatus', [{ status: !on }], true);
}

// Mise en veille (minuteurs) : ne fait rien si la tele est deja eteinte
async function sonyPowerOff() {
    const st = await sonyApi('system', 'getPowerStatus');
    if (st && st[0] && st[0].status !== 'active') return;
    await sonyApi('system', 'setPowerStatus', [{ status: false }], true);
}

// ---------- Nanoleaf (une operation Bluetooth a la fois) ----------
const BULBS = [{ id: 'D47', name: 'Ampoule D47' }, { id: '7ED', name: 'Ampoule 7ED' }];
const bulbs = Object.fromEntries(BULBS.map(b => [b.id, { id: b.id, name: b.name, reachable: null, on: null,
    brightness: null, hue: null, saturation: null, kelvin: null, error: null, updatedAt: 0 }]));
const nlQueue = [];
let nlRunning = null, nlLastState = 0;
const targets = t => t === 'all' ? BULBS.map(b => b.id) : [t];

function nlParse(out) {
    for (const line of String(out).split(/\r?\n/)) {
        const m = line.match(/^\s*(\w+):\s*(.*)$/);
        if (!m || !bulbs[m[1]]) continue;
        const b = bulbs[m[1]], rest = m[2];
        b.updatedAt = Date.now();
        if (/^LightState/.test(rest)) {
            const f = k => { const x = rest.match(new RegExp(k + '=(\\w+)')); return x ? x[1] : null; };
            const num = k => { const v = f(k); return v && v !== 'None' ? +v : null; };
            Object.assign(b, { reachable: true, error: null, on: f('on') === 'True', brightness: num('brightness'),
                hue: num('hue'), saturation: num('saturation'), kelvin: num('colour_temperature') });
        } else if (/introuvable/i.test(rest)) {
            Object.assign(b, { reachable: false, error: null });
        } else {
            Object.assign(b, { reachable: true, error: rest.trim() });   // vue en Bluetooth mais commande en echec
        }
    }
}

function nlPump() {
    if (nlRunning || !nlQueue.length) return;
    const job = nlRunning = nlQueue.shift();
    // Pas de Python/Bluetooth ici (iHost) : les ampoules sont simplement hors de portee
    if (!fs.existsSync(NL_PY)) {
        targets(job.target).forEach(id => Object.assign(bulbs[id], { reachable: false, error: 'Bluetooth indisponible ici', updatedAt: Date.now() }));
        if (job.cmd === 'state') nlLastState = Date.now();
        nlRunning = null;
        return nlPump();
    }
    let out = '', finished = false;
    const p = spawn(NL_PY, [NL_SCRIPT, job.target, job.cmd, ...job.args.map(String)],
        { cwd: DV_DIR, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const timer = setTimeout(() => { try { p.kill(); } catch (e) { /* deja fini */ } }, 60000);
    const done = err => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        nlParse(out);
        if (err) targets(job.target).forEach(id => { bulbs[id].error = 'ERREUR ' + err.message; });
        if (job.cmd === 'state') nlLastState = Date.now();
        nlRunning = null;
        nlPump();
    };
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    p.on('error', done);
    p.on('close', () => done());
}

// Remplace une commande du meme type encore en attente : on ne garde que la derniere valeur
function nlEnqueue(target, cmd, args = []) {
    const kind = cmd === 'on' || cmd === 'off' ? 'power' : cmd === 'color' || cmd === 'kelvin' ? 'colour' : cmd;
    if (kind === 'state' && (nlRunning || nlQueue.length)) return;   // chaque commande relit deja l'etat
    for (let i = nlQueue.length - 1; i >= 0; i--) {
        if (nlQueue[i].target === target && nlQueue[i].kind === kind) nlQueue.splice(i, 1);
    }
    nlQueue.push({ target, cmd, args, kind });
    nlPump();
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v)));
function bulbCommand(b) {
    const id = b.id;
    if (id !== 'all' && !bulbs[id]) throw new Error('Ampoule inconnue');
    const ids = targets(id);
    const set = o => ids.forEach(i => Object.assign(bulbs[i], o));   // affichage immediat
    if (b.on === false) { nlEnqueue(id, 'off'); set({ on: false }); return; }
    let any = false;
    if (b.hue != null || b.saturation != null) {
        const h = clamp(b.hue != null ? b.hue : 0, 0, 360), s = clamp(b.saturation != null ? b.saturation : 100, 0, 100);
        nlEnqueue(id, 'color', [h, s]); set({ on: true, hue: h, saturation: s, kelvin: null }); any = true;
    } else if (b.kelvin != null) {
        const k = clamp(b.kelvin, 1500, 6500);
        nlEnqueue(id, 'kelvin', [k]); set({ on: true, kelvin: k }); any = true;
    }
    if (b.brightness != null) {
        const v = clamp(b.brightness, 0, 100);
        nlEnqueue(id, 'brightness', [v]); set({ on: true, brightness: v }); any = true;
    }
    if (!any && b.on === true) { nlEnqueue(id, 'on'); set({ on: true }); any = true; }
    if (!any) throw new Error('Rien à faire');
}

function busy(id) {
    const hit = j => j && (j.target === id || j.target === 'all');
    return hit(nlRunning) || nlQueue.some(hit);
}

// ---------- etat des teles / Xbox (rafraichi en arriere-plan) ----------
function create({ samsungTv, tvKey, tvTokens }) {
    const cache = { sony: { reachable: null, on: null }, samsung: { reachable: null, on: null }, xbox: null };
    let lastClient = 0, probing = false, lastProbe = 0;

    async function samsungInfo(tv) {
        const r = await httpReq({ host: tv.ip, port: 8001, path: '/api/v2/' }, null, 2000);
        const d = JSON.parse(r.body).device || {};
        if (tv.model && d.modelName !== tv.model) throw new Error('autre appareil');
        return d;
    }

    async function refresh() {
        if (probing) return;
        probing = true;
        lastProbe = Date.now();
        const tv = samsungTv();
        await Promise.all([
            sonyApi('system', 'getPowerStatus')
                .then(r => { cache.sony = { reachable: true, on: !!(r && r[0] && r[0].status === 'active') }; })
                .catch(() => { cache.sony = { reachable: false, on: null }; }),
            samsungInfo(tv)
                .then(d => { cache.samsung = { reachable: true, on: d.PowerState ? d.PowerState === 'on' : true }; })
                .catch(() => { cache.samsung = { reachable: false, on: null }; }),
            ping(XBOX.ip).then(ok => { cache.xbox = ok; }),
        ]);
        probing = false;
    }

    setInterval(() => {
        if (Date.now() - lastClient > 120000) return;
        if (Date.now() - lastProbe > 10000) refresh();
        if (Date.now() - nlLastState >= 60000) nlEnqueue('all', 'state');
    }, 5000);

    function state() {
        lastClient = Date.now();
        if (Date.now() - lastProbe > 10000) refresh();
        if (Date.now() - nlLastState >= 60000) nlEnqueue('all', 'state');
        const tv = samsungTv();
        const k = psk();
        return {
            bulbs: BULBS.map(b => ({ ...bulbs[b.id], busy: busy(b.id) })),
            tvs: [
                { key: SONY.key, name: SONY.name, brand: 'sony', ip: SONY.ip, ...cache.sony, paired: !!k && k !== sonyPskRejected, needsPsk: !k || k === sonyPskRejected },
                { key: tv.key, name: tv.name, brand: 'samsung', ip: tv.ip, ...cache.samsung, paired: !!tvTokens()[tv.key], needsPsk: false },
            ],
            xbox: { ip: XBOX.ip, reachable: cache.xbox },
        };
    }

    // Telecommande de toutes les teles. tv = entree de TVS (Samsung) ou null pour la Sony.
    async function remote(tv, button, samsungPower) {
        if (!BUTTONS.includes(button)) throw new Error('Touche inconnue');
        if (!tv) {
            if (button === 'power') return sonyPowerToggle();
            return sonyIrcc(SONY_NAMES[button]);
        }
        if (button === 'power') return samsungPower(tv);
        if (!(await probe(tv.ip, 8002, 1500)) && !(await probe(tv.ip, 8001, 1500))) throw new Error('Télé hors de portée');
        return tvKey(tv, SAMSUNG_KEYS[button]);
    }

    async function remoteInfo(tv) {
        if (!tv) {
            const k = psk();
            let reachable = false, buttons = BUTTONS;
            try {
                const codes = await sonyLoadCodes();
                reachable = true;
                buttons = BUTTONS.filter(b => b === 'power' || codes[SONY_NAMES[b]]);
            } catch (e) {
                reachable = await probe(SONY.ip, 80, 1500);
            }
            return { buttons, needsPsk: !k || k === sonyPskRejected, reachable };
        }
        const reachable = (await probe(tv.ip, 8002, 1500)) || (await probe(tv.ip, 8001, 1500));
        return { buttons: BUTTONS, needsPsk: false, reachable };
    }

    return { state, bulbCommand, remote, remoteInfo, samsungInfo, refresh, sonyPowerOff };
}

module.exports = { create, probe, wakeOnLan, SONY, BUTTONS, PSK_HINT };
