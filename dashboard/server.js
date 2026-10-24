// Dashboard Hue + Alexa + teles : http://localhost:8090
// - Sur ce PC : ecoute sur 127.0.0.1 uniquement (accessible depuis ce PC), fichiers dans dashboard/.
// - Dans le conteneur (iHost, MAISON_DATA=/data) : ecoute sur 0.0.0.0, les appareils du reseau doivent saisir le
//   code MAISON_PIN (voir auth.js) ; les fichiers de donnees vivent dans /data (voir config.js).
// La page d'affichage pour les teles (port 8091, lecture du texte uniquement) est toujours visible sur le reseau local.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const config = require('./config');
const auth = require('./auth');
const { connect } = require('../alexa/alexa-common');

const PORT = config.env.port;
// Cle du pont Hue : dataDir (ou variable HUE_CONFIG), sinon le hue-config.json a la racine du projet (PC)
let cfg = config.readJson('hue-config.json', null);
if (!cfg) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hue-config.json'), 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { throw new Error(`hue-config.json introuvable dans ${config.dataDir} (ou variable d'environnement HUE_CONFIG)`); }
}
const hueAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true }); // certificat auto-signe du pont

// ---------- Hue ----------
function hue(method, p, body) {
    return new Promise((resolve, reject) => {
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = https.request({
            host: cfg.BridgeIP, path: `/clip/v2/resource/${p}`, method, agent: hueAgent,
            headers: { 'hue-application-key': cfg.Username, 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}) },
        }, res => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', c => buf += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(buf);
                    if (j.errors && j.errors.length && !j.data.length) return reject(new Error(j.errors[0].description));
                    resolve(j.data);
                } catch (e) { reject(e); }
            });
        });
        // Delai court (connexion comprise) : a Deauville le pont de Paris est hors de portee, on ne bloque pas
        const timer = setTimeout(() => req.destroy(new Error('Pont Hue hors de portée')), 4000);
        req.on('error', e => { clearTimeout(timer); reject(e); });
        req.on('close', () => clearTimeout(timer));
        if (data) req.write(data);
        req.end();
    });
}

const hueNames = {};
async function hueState() {
    const [rooms, zones, grouped, lights, scenes, zigbee] = await Promise.all(
        ['room', 'zone', 'grouped_light', 'light', 'scene', 'zigbee_connectivity'].map(r => hue('GET', r)));
    const gl = Object.fromEntries(grouped.map(g => [g.id, g]));
    const reach = Object.fromEntries(zigbee.map(z => [z.owner.rid, z.status === 'connected']));
    const lightByDevice = {};
    lights.forEach(l => { (lightByDevice[l.owner.rid] = lightByDevice[l.owner.rid] || []).push(l); });
    // Noms pour l'historique (id de groupe, lumiere, piece ou scene -> nom)
    [...rooms, ...zones].forEach(r => { const g = r.services.find(s => s.rtype === 'grouped_light'); hueNames[r.id] = r.metadata.name; if (g) hueNames[g.rid] = r.metadata.name; });
    lights.forEach(l => { hueNames[l.id] = l.metadata.name; });
    scenes.forEach(s => { hueNames[s.id] = s.metadata.name; });

    return [...rooms, ...zones].map(r => {
        const g = gl[(r.services.find(s => s.rtype === 'grouped_light') || {}).rid];
        const roomLights = r.type === 'room'
            ? r.children.flatMap(c => lightByDevice[c.rid] || [])
            : lights.filter(l => r.children.some(c => c.rid === l.id));
        return {
            id: r.id, name: r.metadata.name, archetype: r.metadata.archetype,
            groupId: g && g.id, on: !!(g && g.on.on), brightness: g && g.dimming ? g.dimming.brightness : 0,
            lights: roomLights.map(l => ({
                id: l.id, name: l.metadata.name, on: l.on.on,
                brightness: l.dimming ? l.dimming.brightness : 0,
                xy: l.color ? l.color.xy : null,
                mirek: l.color_temperature && l.color_temperature.mirek_valid ? l.color_temperature.mirek : null,
                reachable: reach[l.owner.rid] !== false,
            })).sort((a, b) => a.name.localeCompare(b.name)),
            scenes: scenes.filter(s => s.group.rid === r.id)
                .map(s => ({ id: s.id, name: s.metadata.name, active: s.status && s.status.active !== 'inactive' }))
                .sort((a, b) => a.name.localeCompare(b.name)),
        };
    }).filter(r => r.groupId);
}

// ---------- Alexa ----------
let alexa = null, alexaError = null;
const NET_ERR = /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up/i;
const SPEAKERS = ['ECHO', 'KNIGHT', 'ROOK', 'WHA'];
const DEAUVILLE_ECHOS = ['G8M2DB06440201PX'];   // Echo "Deauville" ; toutes les autres sont a Paris
const volumes = {}, players = {};
const cb = fn => new Promise((res, rej) => fn((e, r) => e ? rej(e) : res(r)));

function speakerList() {
    return Object.values(alexa.serialNumbers).filter(d => SPEAKERS.includes(d.deviceFamily));
}
const membersOf = d => d.deviceFamily === 'WHA' ? (d.clusterMembers || []).map(s => alexa.serialNumbers[s]).filter(Boolean) : [d];

async function refreshAlexa() {
    if (!alexa) return;
    try {
        const r = await cb(c => alexa.getAllDeviceVolumes(c));
        (r.volumes || []).forEach(v => { if (v.speakerVolume != null && target[v.dsn] === undefined && !inFlight[v.dsn] && Date.now() - (lastSet[v.dsn] || 0) > 15000) volumes[v.dsn] = v.speakerVolume; });
    } catch (e) { /* reseau */ }
    await Promise.all(speakerList().filter(d => d.online).map(async d => {
        try {
            const r = await cb(c => alexa.getPlayerInfo(d.serialNumber, c));
            const p = r && r.playerInfo;
            players[d.serialNumber] = p && p.infoText && p.infoText.title ? {
                state: p.state, title: p.infoText.title, artist: p.infoText.subText1 || '', album: p.infoText.subText2 || '',
                art: p.mainArt && p.mainArt.url, provider: p.provider && p.provider.providerName,
                progress: p.progress && p.progress.mediaProgress, length: p.progress && p.progress.mediaLength,
            } : null;
        } catch (e) { players[d.serialNumber] = null; }
    }));
}

function alexaState() {
    if (!alexa) return { ready: false, error: alexaError };
    return {
        ready: true,
        devices: speakerList().map(d => {
            const m = membersOf(d);
            const vols = m.map(x => volumes[x.serialNumber]).filter(v => v != null);
            return {
                house: m.length && m.every(x => DEAUVILLE_ECHOS.includes(x.serialNumber)) ? 'deauville' : 'paris',
                serial: d.serialNumber, name: d.accountName, group: d.deviceFamily === 'WHA',
                members: d.deviceFamily === 'WHA' ? m.map(x => x.accountName) : [],
                online: d.online,
                volume: vols.length ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : null,
                player: players[d.serialNumber] || null,
            };
        }).sort((a, b) => (a.group - b.group) || a.name.localeCompare(b.name)),
    };
}

// Une requete de volume a la fois par Echo, toujours avec la derniere valeur (pas de "yoyo")
const target = {}, inFlight = {}, lastSet = {};  // lastSet : on ignore les volumes relus chez Amazon 15 s apres un reglage
function setVolume(serial, v) {
    const dev = alexa.serialNumbers[serial];
    if (!dev) throw new Error('Alexa inconnue');
    for (const m of membersOf(dev)) { target[m.serialNumber] = v; volumes[m.serialNumber] = v; lastSet[m.serialNumber] = Date.now(); pump(m.serialNumber); }
}
function pump(dsn) {
    if (inFlight[dsn] || target[dsn] === undefined) return;
    const v = target[dsn]; delete target[dsn];
    inFlight[dsn] = true;
    alexa.sendSequenceCommand(dsn, 'volume', v, () => { inFlight[dsn] = false; pump(dsn); });
}

// ---------- Teles Samsung ----------
// Allumer/eteindre, parler et volume passent par Alexa (rien a configurer sur la tele).
// Le texte a l'ecran passe par la tele en local : elle ouvre une page plein ecran servie par ce PC.
const WebSocket = require(path.join(__dirname, '..', 'alexa', 'node_modules', 'ws'));
const os = require('os');
const DISPLAY_PORT = PORT + 1;
const TOKENS_FILE = 'tv-tokens.json';   // dans config.dataDir
const TVS = [
    { key: 'salon', house: 'paris', name: 'Télé du salon', size: '50"', ip: '192.168.1.15', serial: 'ADWXYXMAMWQBN', entity: 'AlexaBridge_ADWXYXMAMWQBN@A2QPKXCDRNWZ2T_ADWXYXMAMWQBN' },
    { key: 'grande', house: 'paris', name: 'Grande télé', size: '75"', ip: '192.168.1.10', serial: 'WFSUHDW6TBVAX', entity: 'AlexaBridge_WFSUHDW6TBVAX@A2QPKXCDRNWZ2T_WFSUHDW6TBVAX' },
    // Deauville : pas d'Alexa, allumage par Wake-on-LAN / touche POWER
    { key: 'samsung43', house: 'deauville', name: 'Samsung 43"', size: '43"', ip: '192.168.1.133', model: 'TQ43QN90FATXXC', mac: '04:E4:B6:B9:ED:B4' },
];
const dvLib = require('./deauville');
const tvPower = {};
let tvTokens = config.readJson(TOKENS_FILE, {});   // {} = pas encore appairee
if (!tvTokens || typeof tvTokens !== 'object') tvTokens = {};
const saveTvTokens = () => { try { config.writeJson(TOKENS_FILE, tvTokens); } catch (e) { console.log('[tv] tv-tokens.json :', e.message); } };
let currentMessage = { text: '', color: '#ffffff', at: 0 };

const tvByKey = k => { const t = TVS.find(x => x.key === k); if (!t) throw new Error('Tele inconnue'); return t; };

function lanIp() {
    if (config.env.lanIp) return config.env.lanIp;   // conteneur : IP de l'iHost (MAISON_LAN_IP)
    for (const list of Object.values(os.networkInterfaces())) {
        for (const i of list) if (i.family === 'IPv4' && !i.internal && i.address.startsWith('192.168.1.')) return i.address;
    }
    return null;
}

async function refreshTvPower() {
    if (!alexa) return;
    try {
        const r = await cb(c => alexa.querySmarthomeDevices(TVS.filter(t => t.entity).map(t => t.entity), c));
        (r.deviceStates || []).forEach(s => {
            const tv = TVS.find(t => t.entity === s.entity.entityId);
            const p = (s.capabilityStates || []).map(c => JSON.parse(c)).find(c => c.namespace === 'Alexa.PowerController');
            if (tv && p) tvPower[tv.key] = p.value === 'ON';
        });
    } catch (e) { /* reseau */ }
}

async function tvSetPower(tv, on) {
    if (!tv.entity) {   // tele sans Alexa (Deauville)
        let isOn = false;
        try { isOn = (await dv.samsungInfo(tv)).PowerState !== 'standby'; } catch (e) { /* eteinte */ }
        if (isOn !== on) await samsungPowerToggle(tv);
        tvPower[tv.key] = on;
        return;
    }
    await cb(c => alexa.executeSmarthomeDeviceAction(tv.entity, { action: on ? 'turnOn' : 'turnOff' }, c));
    tvPower[tv.key] = on;
}

// Connexion locale a la tele ; la 1re fois elle affiche "Autoriser ?" (30 s pour accepter)
async function tvSocket(tv) {
    // Sonde TCP courte d'abord : une tele de l'autre maison est hors de portee, on ne reste pas bloque
    let base = null;
    if (await dvLib.probe(tv.ip, 8002, 1500)) base = `wss://${tv.ip}:8002`;
    else if (await dvLib.probe(tv.ip, 8001, 1500)) base = `ws://${tv.ip}:8001`;
    if (!base) throw new Error('Télé hors de portée');
    return new Promise((resolve, reject) => {
        const name = Buffer.from('Dashboard Maison').toString('base64');
        const token = tvTokens[tv.key] ? `&token=${tvTokens[tv.key]}` : '';
        const ws = new WebSocket(`${base}/api/v2/channels/samsung.remote.control?name=${name}${token}`, { rejectUnauthorized: false });
        const timer = setTimeout(() => { ws.terminate(); reject(new Error('La tele ne repond pas. Si elle affiche "Autoriser ?", accepte avec la telecommande puis reessaie.')); }, 35000);
        ws.on('message', raw => {
            const m = JSON.parse(raw);
            if (m.event === 'ms.channel.connect') {
                clearTimeout(timer);
                if (m.data && m.data.token) { tvTokens[tv.key] = m.data.token; saveTvTokens(); }
                resolve(ws);
            } else if (m.event === 'ms.channel.unauthorized') {
                clearTimeout(timer); ws.close(); reject(new Error('Acces refuse par la tele (il faut accepter "Autoriser" sur l\'ecran)'));
            }
        });
        ws.on('error', e => { clearTimeout(timer); reject(new Error('Tele injoignable : ' + e.message)); });
    });
}

// Connexion gardee ouverte par tele : les touches partent tout de suite
const tvConns = {};
async function tvConn(tv) {
    const c = tvConns[tv.key];
    if (c && c.readyState === WebSocket.OPEN) return c;
    const ws = await tvSocket(tv);
    tvConns[tv.key] = ws;
    ws.on('close', () => { if (tvConns[tv.key] === ws) delete tvConns[tv.key]; });
    ws.on('error', () => {});
    return ws;
}

async function tvSend(tv, payload) {
    (await tvConn(tv)).send(JSON.stringify(payload));
}

const tvKey = (tv, key) => tvSend(tv, { method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } });

// Volume reel de la tele : touches volume de la telecommande (le volume Alexa des teles est en sourdine)
async function tvVolumeSteps(tv, steps) {
    const key = steps > 0 ? 'KEY_VOLUP' : 'KEY_VOLDOWN';
    const n = Math.min(20, Math.abs(Math.round(steps)));
    for (let i = 0; i < n; i++) { await tvKey(tv, key); await new Promise(r => setTimeout(r, 120)); }
}

async function tvShowText(tv, text, color) {
    const ip = lanIp();
    if (!ip) throw new Error('Adresse du PC introuvable sur le reseau');
    currentMessage = { text, color: color || '#ffffff', at: Date.now() };
    const url = `http://${ip}:${DISPLAY_PORT}/msg?t=${Date.now()}`;
    await tvSend(tv, { method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId: 'org.tizen.browser', action_type: 'NATIVE_LAUNCH', metaTag: url } } });
}

// ---------- Deauville + telecommande ----------
const dv = dvLib.create({ samsungTv: () => tvByKey('samsung43'), tvKey: (tv, k) => tvKey(tv, k), tvTokens: () => tvTokens });

// Bouton power : Alexa pour les teles de Paris, sinon touche POWER (veille) ou Wake-on-LAN (eteinte)
async function samsungPowerToggle(tv) {
    if (tv.entity) return tvSetPower(tv, !tvPower[tv.key]);
    let info = null;
    try { info = await dv.samsungInfo(tv); } catch (e) { /* eteinte ou hors de portee */ }
    if (info) return tvKey(tv, 'KEY_POWER');
    if (tv.mac) return dvLib.wakeOnLan(tv.mac);
    throw new Error('Télé hors de portée');
}

function tvState() {
    return TVS.filter(t => t.house === 'paris').map(t => {
        const d = alexa && alexa.serialNumbers[t.serial];
        return { key: t.key, name: t.name, size: t.size, serial: t.serial, on: tvPower[t.key], paired: !!tvTokens[t.key],
            volume: volumes[t.serial] != null ? volumes[t.serial] : null, alexaOnline: !!(d && d.online) };
    });
}

// Page affichee sur la tele (seule page accessible depuis le reseau local)
const MSG_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}
#m{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:4vw;box-sizing:border-box;
font:700 12vw/1.05 "Segoe UI",Arial,sans-serif;word-break:break-word;text-shadow:0 0 4vw rgba(255,255,255,.25)}</style></head>
<body><div id="m"></div><script>
let last=0;const m=document.getElementById('m');
function fit(){let s=14;m.style.fontSize=s+'vw';while((m.scrollHeight>innerHeight||m.scrollWidth>innerWidth)&&s>2){s-=.5;m.style.fontSize=s+'vw';}}
async function poll(){try{const r=await fetch('/msg.json?'+Date.now());const j=await r.json();if(j.at!==last){last=j.at;m.textContent=j.text;m.style.color=j.color;fit();}}catch(e){}setTimeout(poll,1000);}
poll();addEventListener('resize',fit);
</script></body></html>`;

const displayServer = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/msg') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(MSG_PAGE); }
    if (url === '/msg.json') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); return res.end(JSON.stringify(currentMessage)); }
    res.writeHead(404); res.end();
});

// ---------- Temps reel (Hue eventstream -> navigateur) ----------
const clients = new Set();
let pushTimer = null;
function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(async () => {
        pushTimer = null;
        try {
            const msg = `data: ${JSON.stringify({ hue: await hueState() })}\n\n`;
            clients.forEach(c => c.write(msg));
        } catch (e) { /* pont injoignable */ }
    }, 300);
}

function listenHue() {
    const req = https.request({
        host: cfg.BridgeIP, path: '/eventstream/clip/v2', agent: new https.Agent({ rejectUnauthorized: false }),
        headers: { 'hue-application-key': cfg.Username, Accept: 'text/event-stream' },
    }, res => {
        res.on('data', chunk => { if (String(chunk).includes('"type":"update"')) schedulePush(); });
        res.on('end', () => setTimeout(listenHue, 3000));
    });
    req.on('error', () => setTimeout(listenHue, 10000));
    req.end();
}

// ---------- HTTP ----------
function readBody(req) {
    return new Promise(resolve => {
        let b = '';
        req.on('data', c => b += c);
        req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
    });
}

function hueBody(b) {
    const s = {};
    if (b.on !== undefined) s.on = { on: !!b.on };
    if (b.brightness !== undefined) { s.dimming = { brightness: Math.max(1, Math.min(100, +b.brightness)) }; s.on = { on: true }; }
    if (b.xy) { s.color = { xy: b.xy }; s.on = { on: true }; }
    if (b.mirek) { s.color_temperature = { mirek: Math.round(b.mirek) }; s.on = { on: true }; }
    return s;
}

const routes = {
    'GET /api/state': async () => {
        try { return { hue: await hueState(), alexa: alexaState() }; }
        catch (e) { return { hue: [], hueError: 'hors de portée', alexa: alexaState() }; }
    },
    'GET /api/deauville': async () => dv.state(),
    'POST /api/deauville/bulb': async b => { dv.bulbCommand(b); return { queued: true }; },
    'POST /api/tv/remote': async b => { await dv.remote(b.key === 'sony' ? null : tvByKey(b.key), String(b.button), samsungPowerToggle); return {}; },
    'GET /api/tv/remote-info': async q => dv.remoteInfo(q.key === 'sony' ? null : tvByKey(q.key)),
    'GET /api/alexa': async () => alexaState(),
    'POST /api/group': async b => { await hue('PUT', `grouped_light/${b.id}`, hueBody(b)); return {}; },
    'POST /api/light': async b => { await hue('PUT', `light/${b.id}`, hueBody(b)); return {}; },
    'POST /api/scene': async b => { await hue('PUT', `scene/${b.id}`, { recall: { action: 'active' } }); return {}; },
    'POST /api/alexa/volume': async b => { setVolume(b.serial, Math.max(0, Math.min(100, +b.volume))); return {}; },
    'POST /api/alexa/media': async b => {
        if (!['play', 'pause', 'next', 'previous'].includes(b.action)) throw new Error('Action invalide');
        await cb(c => alexa.sendCommand(b.serial, b.action, null, c));
        setTimeout(refreshAlexa, 1200);
        return {};
    },
    'POST /api/alexa/music': async b => {
        await cb(c => alexa.sendSequenceCommand(b.serial, 'textCommand', `joue ${b.search}`, c));
        setTimeout(refreshAlexa, 4000);
        return {};
    },
    'POST /api/alexa/speak': async b => { await cb(c => alexa.sendSequenceCommand(b.serial, 'speak', String(b.text || ''), c)); return {}; },
    'POST /api/alexa/cmd': async b => { await cb(c => alexa.sendSequenceCommand(b.serial, 'textCommand', String(b.text || ''), c)); return {}; },
    'GET /api/tv': async () => { await refreshTvPower(); return tvState(); },
    'POST /api/tv/power': async b => { await tvSetPower(tvByKey(b.key), !!b.on); return {}; },
    'POST /api/tv/speak': async b => { await cb(c => alexa.sendSequenceCommand(tvByKey(b.key).serial, 'speak', String(b.text || ''), c)); return {}; },
    'POST /api/tv/volume': async b => { await tvVolumeSteps(tvByKey(b.key), +b.steps || 0); return {}; },
    'POST /api/tv/mute': async b => { await tvKey(tvByKey(b.key), 'KEY_MUTE'); return {}; },
    'POST /api/tv/text': async b => {
        const tv = tvByKey(b.key);
        if (tvPower[tv.key] === false) { await tvSetPower(tv, true); await new Promise(r => setTimeout(r, 6000)); }
        await tvShowText(tv, String(b.text || ''), b.color);
        return {};
    },
    'POST /api/tv/clear': async b => { currentMessage = { text: '', color: '#fff', at: Date.now() }; await tvKey(tvByKey(b.key), 'KEY_EXIT'); return {}; },
    'POST /api/alexa/stop': async b => { await cb(c => alexa.sendSequenceCommand(b.serial, 'deviceStop', null, c)); return {}; },
};
// Ambiances + meteo
const extras = require('./extras').create({
    hue, alexa: () => alexa, setVolume, bulbCommand: b => dv.bulbCommand(b), log: m => console.log(m),
});
Object.assign(routes, extras.routes);

// ---------- Historique + minuteurs ----------
const alexaBy = device => {
    if (!alexa) throw new Error('Alexa pas encore connectée');
    const d = alexa.serialNumbers[device] || Object.values(alexa.serialNumbers).find(x => x.accountName === device);
    if (!d) throw new Error(`Alexa « ${device} » introuvable`);
    return d;
};
const alexaHouse = serial => {
    const d = alexa && alexa.serialNumbers[serial];
    if (!d) return null;
    const m = membersOf(d);
    return m.length && m.every(x => DEAUVILLE_ECHOS.includes(x.serialNumber)) ? 'deauville' : 'paris';
};
const tvHouse = key => key === 'sony' ? dvLib.SONY.house : ((TVS.find(t => t.key === key) || {}).house || null);
const tvName = key => key === 'sony' ? `${dvLib.SONY.name} (Deauville)` : (TVS.find(t => t.key === key) || {}).name;

const history = require('./history');
const hist = history.create({ file: config.filePath('history.json') });
const labels = history.createDescriber({
    hueName: id => hueNames[id],
    alexaName: s => { const d = alexa && alexa.serialNumbers[s]; return d && d.accountName; },
    alexaHouse, tvName, tvHouse,
    ambianceName: id => { const a = extras.loadAmbiances().find(x => x.id === id); return a && a.name; },
});
Object.assign(routes, hist.routes);

// Ce que fait un minuteur quand il sonne (memes chemins que les routes correspondantes)
async function runTimerTarget(t) {
    switch (t.type) {
        case 'hueRoom': {
            const [rooms, zones] = await Promise.all([hue('GET', 'room'), hue('GET', 'zone')]);
            const r = [...rooms, ...zones].find(x => x.metadata.name === t.name);
            const g = r && r.services.find(s => s.rtype === 'grouped_light');
            if (!g) throw new Error(`Pièce Hue « ${t.name} » introuvable`);
            return hue('PUT', `grouped_light/${g.rid}`, { on: { on: false } });
        }
        case 'hueAll': {
            const groups = await hue('GET', 'grouped_light');
            const home = groups.find(g => g.owner && g.owner.rtype === 'bridge_home');
            if (home) return hue('PUT', `grouped_light/${home.id}`, { on: { on: false } });
            return Promise.all(groups.filter(g => g.on && g.on.on).map(g => hue('PUT', `grouped_light/${g.id}`, { on: { on: false } })));
        }
        case 'bulbs': return dv.bulbCommand({ id: 'all', on: false });
        case 'alexaStop': { const d = alexaBy(t.device); return cb(c => alexa.sendSequenceCommand(d.serialNumber, 'deviceStop', null, c)); }
        case 'alexaVolume': { const d = alexaBy(t.device); return setVolume(d.serialNumber, Math.max(0, Math.min(100, +t.volume))); }
        case 'tvOff': return t.key === 'sony' ? dv.sonyPowerOff() : tvSetPower(tvByKey(t.key), false);
        case 'xbox': return routes['POST /api/xbox']({ action: 'off', ...(t.device ? { device: t.device } : {}) });
        default: throw new Error('Type de minuteur inconnu');
    }
}

const timers = require('./timers').create({
    file: config.filePath('timers.json'),
    execute: runTimerTarget, describeTarget: labels.describeTarget, tvHouse, log: m => console.log(m),
    onFired: ({ timer, ok, error }) => hist.append({ house: timer.house, text: `Minuteur : ${labels.describeTarget(timer.target)}${ok ? '' : ` (échec : ${error})`}` }),
});
Object.assign(routes, timers.routes);

// Historique generique : toute route POST qui pilote quelque chose (sauf la gestion des minuteurs)
function logHistory(route, body, result) {
    if (!route.startsWith('POST /api/') || route.startsWith('POST /api/timers')) return;
    try { hist.append(labels.describe(route, body, result)); } catch (e) { /* jamais bloquant */ }
}

const server = http.createServer(async (req, res) => {
    if (auth.handle(req, res)) return;   // code PIN pour les appareils du reseau (jamais demande en local)
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    const ICONS = { '/icon-256.png': ['icon-256.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/favicon.ico': ['Maison.ico', 'image/x-icon'] };
    if (req.method === 'GET' && ICONS[url]) {
        try {
            const data = fs.readFileSync(path.join(__dirname, '..', 'icon', ICONS[url][0]));
            res.writeHead(200, { 'content-type': ICONS[url][1], 'cache-control': 'max-age=86400' });
            return res.end(data);
        } catch (e) { res.writeHead(404); return res.end(); }
    }
    if (req.method === 'GET' && url === '/manifest.webmanifest') {
        res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
        return res.end(JSON.stringify({ name: 'Maison', short_name: 'Maison', start_url: '/', display: 'standalone', background_color: '#0e1015', theme_color: '#0e1015',
            icons: [{ src: '/icon-256.png?v=2', sizes: '256x256', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any' }] }));
    }
    if (url === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': ok\n\n');
        clients.add(res);
        return req.on('close', () => clients.delete(res));
    }
    const fn = routes[`${req.method} ${url}`];
    if (!fn) { res.writeHead(404); return res.end(); }
    try {
        if (url.startsWith('/api/alexa/') && !alexa) throw new Error('Alexa pas encore connectee');
        const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
        const body = req.method === 'POST' ? await readBody(req) : query;
        // Coupure reseau passagere (DNS, bascule Wi-Fi/4G) : on reessaie une fois apres 2 s
        let result;
        try { result = await fn(body); }
        catch (e) {
            if (!NET_ERR.test(String(e.message))) throw e;
            await new Promise(r => setTimeout(r, 2000));
            result = await fn(body);
        }
        logHistory(`${req.method} ${url}`, body, result);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
    } catch (e) {
        const msg = NET_ERR.test(String(e.message)) ? 'Connexion Internet coupée un instant, réessaie' : e.message;
        res.writeHead(e.status || 500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(e.body || { error: msg }));
    }
});

server.listen(PORT, config.env.bind, () => console.log(`Dashboard : http://localhost:${PORT} (ecoute ${config.env.bind}, donnees ${config.dataDir}, `
    + (config.env.pin ? 'code PIN actif pour le reseau)' : 'pas de code PIN : acces local seulement)')));
displayServer.listen(DISPLAY_PORT, '0.0.0.0', () => console.log(`Page d'affichage tele : port ${DISPLAY_PORT}`));
setInterval(refreshTvPower, 15000);
listenHue();
// Si la connexion Alexa echoue (pas d'Internet au demarrage), on reessaie toutes les 30 s
function connectAlexa() {
    connect()
        .then(a => { alexa = a; alexaError = null; console.log('Alexa connectee.'); return refreshAlexa(); })
        .catch(e => { alexaError = e.message || String(e); console.log('Alexa :', alexaError); setTimeout(connectAlexa, 30000); });
}
connectAlexa();
setInterval(refreshAlexa, 8000);
