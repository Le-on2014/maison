// Ecoute la telecommande Hue Tap Dial en direct :
// bouton 1 maintenu + molette => volume des Alexa du groupe "Chambre".
// Le bouton 1 et la molette sont retires de la config Hue et geres ici, pour que
// bouton 1 + molette ne touche QUE le volume. Boutons 2, 3, 4 restent geres par le pont.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { connect } = require('./alexa-common');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hue-config.json'), 'utf8').replace(/^﻿/, ''));
const SETTINGS = {
    remoteName: 'Hue tap dial switch 1',
    button: 1,
    alexaGroup: 'Chambre',
    stepsPerPoint: 10,       // pas de molette pour 1 point de volume
    minDelta: 1,             // variation minimale par evenement
    maxDelta: 8,             // variation maximale par evenement
    room: 'Chambre Léon',    // piece pilotee par la molette seule
    stepsPerBrightness: 3,   // pas de molette pour 1 % de luminosite
    button1Scenes: [         // appui court bouton 1 (reprend la config d'origine)
        { hour: 0, minute: 0, scene: 'Givre fuchsia 2' },
        { hour: 16, minute: 2, scene: 'Givre fuchsia 2' },
    ],
};

const LOG_FILE = path.join(__dirname, 'hue-alexa.log');
function log(...a) {
    const line = `[${new Date().toLocaleString('fr-FR')}] ${a.join(' ')}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + '\n');
}

// Le pont a un certificat auto-signe : on ne desactive la verification que pour lui
const hueAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

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
            res.on('end', () => { try { resolve(JSON.parse(buf).data); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

// ---------- Etat ----------
let alexa, speakers = [], volumes = {};
let buttonId, rotaryId;
let held = false, rotatedWhileHeld = false;

async function setupHue() {
    const devices = await hue('GET', 'device');
    const remote = devices.find(d => d.metadata.name === SETTINGS.remoteName);
    if (!remote) throw new Error(`Telecommande "${SETTINGS.remoteName}" introuvable`);
    buttonId = (await hue('GET', 'button')).find(b => b.owner.rid === remote.id && b.metadata.control_id === SETTINGS.button).id;
    rotaryId = (await hue('GET', 'relative_rotary')).find(r => r.owner.rid === remote.id).id;
    log(`Telecommande OK (bouton ${SETTINGS.button} = ${buttonId}, molette = ${rotaryId})`);
}

async function setupAlexa() {
    alexa = await connect();
    const group = Object.values(alexa.serialNumbers).find(d => d.deviceFamily === 'WHA' && d.accountName === SETTINGS.alexaGroup);
    if (!group) throw new Error(`Groupe Alexa "${SETTINGS.alexaGroup}" introuvable`);
    speakers = group.clusterMembers.map(s => alexa.serialNumbers[s]).filter(Boolean);
    await refreshVolumes();
    log(`Alexa OK : ${speakers.map(s => `${s.accountName}=${volumes[s.serialNumber]}`).join(', ')}`);
}

function refreshVolumes() {
    return new Promise(resolve => alexa.getAllDeviceVolumes((err, res) => {
        if (!err && res && res.volumes) res.volumes.forEach(v => { if (v.speakerVolume != null) volumes[v.dsn] = v.speakerVolume; });
        resolve();
    }));
}

// ---------- Lumieres (actions retirees de la config Hue, refaites ici) ----------
// Bouton 1 appui court : scene selon l'heure ; appui long : eteindre ; molette seule : varier.
let groupId = null, roomOn = false, roomBri = 0, dimBusy = false, dimPending = 0;

async function setupLights() {
    const room = (await hue('GET', 'room')).find(r => r.metadata.name === SETTINGS.room);
    if (!room) throw new Error(`Piece Hue "${SETTINGS.room}" introuvable`);
    groupId = room.services.find(s => s.rtype === 'grouped_light').rid;
    const g = (await hue('GET', `grouped_light/${groupId}`))[0];
    roomOn = g.on.on; roomBri = g.dimming ? g.dimming.brightness : 0;
}

function sceneForNow() {
    const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
    let pick = SETTINGS.button1Scenes[0];
    for (const s of SETTINGS.button1Scenes) if (mins >= s.hour * 60 + s.minute) pick = s;
    return pick.scene;
}

async function recallScene(name) {
    const sc = (await hue('GET', 'scene')).find(s => s.metadata.name === name);
    if (sc) { await hue('PUT', `scene/${sc.id}`, { recall: { action: 'active' } }); log(`Scene : ${name}`); }
}

const setRoom = body => hue('PUT', `grouped_light/${groupId}`, body);

function queueDim(delta) {
    dimPending += delta;
    if (dimBusy) return;
    dimBusy = true;
    (async () => {
        while (dimPending) {
            const d = dimPending; dimPending = 0;
            try {
                if (!roomOn && d > 0) { await setRoom({ on: { on: true } }); roomOn = true; }
                else if (roomOn && d < 0 && roomBri + d <= 1) { await setRoom({ on: { on: false } }); roomOn = false; }
                else if (roomOn) {
                    await setRoom({ dimming_delta: { action: d > 0 ? 'up' : 'down', brightness_delta: Math.min(100, Math.abs(d)) } });
                    roomBri = Math.max(1, Math.min(100, roomBri + d));
                }
            } catch (e) { log('Erreur lumiere :', e.message); }
        }
        dimBusy = false;
    })();
}

// ---------- Volume ----------
// Une seule requete en vol par Echo ; quand elle revient, on envoie la derniere valeur voulue.
// Evite les commandes qui arrivent dans le desordre (volume qui "baisse puis remonte").
const target = {}, inFlight = {}, sent = {};
let lastChange = 0, groupVolume = null;

function queueVolume(delta) {
    lastChange = Date.now();
    const parts = [];
    // Volume commun aux Echo du groupe (part de la moyenne s'ils sont differents)
    if (groupVolume == null) {
        const known = speakers.map(s => volumes[s.serialNumber]).filter(v => v != null);
        groupVolume = known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : 20;
    }
    groupVolume = Math.max(0, Math.min(100, groupVolume + delta));
    for (const s of speakers) {
        const dsn = s.serialNumber;
        target[dsn] = groupVolume;
        parts.push(`${s.accountName}=${target[dsn]}`);
        pump(s);
    }
    log(`Volume ${delta > 0 ? '+' : ''}${delta} -> ${parts.join(', ')}`);
}

function pump(s) {
    const dsn = s.serialNumber;
    if (inFlight[dsn] || target[dsn] === sent[dsn]) return;
    const v = target[dsn];
    inFlight[dsn] = true;
    alexa.sendCommand(dsn, 'volume', v, err => {
        inFlight[dsn] = false;
        if (err) log(`Erreur volume ${s.accountName} : ${err.message || err}`);
        else { sent[dsn] = v; volumes[dsn] = v; }
        pump(s);
    });
}

// Resynchronise avec Amazon seulement apres 10 s sans toucher la molette
// (si le volume a ete change a la voix entre-temps)
setInterval(() => {
    if (!held && Date.now() - lastChange > 10000 && speakers.every(s => !inFlight[s.serialNumber])) {
        refreshVolumes().then(() => { groupVolume = null; speakers.forEach(s => { target[s.serialNumber] = sent[s.serialNumber] = volumes[s.serialNumber]; }); });
    }
}, 30000);

// ---------- Evenements Hue ----------
function onHueEvent(item) {
    if (item.id === groupId) {
        if (item.on) roomOn = item.on.on;
        if (item.dimming) roomBri = item.dimming.brightness;
    }
    if (item.id === buttonId && item.button && item.button.button_report) {
        const ev = item.button.button_report.event;
        if (ev === 'initial_press') {
            held = true; rotatedWhileHeld = false;
        } else if (ev === 'short_release' || ev === 'long_release') {
            held = false;
            if (!rotatedWhileHeld) {
                if (ev === 'short_release') recallScene(sceneForNow()).catch(e => log('Erreur scene :', e.message));
                else setRoom({ on: { on: false } }).then(() => { roomOn = false; log('Tout eteint'); }).catch(e => log('Erreur :', e.message));
            }
        }
    }
    if (item.id === rotaryId && item.relative_rotary) {
        const r = (item.relative_rotary.rotary_report || item.relative_rotary.last_event || {}).rotation;
        if (!r) return;
        const sign = r.direction === 'clock_wise' ? 1 : -1;
        if (held) {
            rotatedWhileHeld = true;
            const pts = Math.min(SETTINGS.maxDelta, Math.max(SETTINGS.minDelta, Math.round(r.steps / SETTINGS.stepsPerPoint)));
            queueVolume(sign * pts);
        } else {
            queueDim(sign * Math.max(2, Math.round(r.steps / SETTINGS.stepsPerBrightness)));
        }
    }
}

function listen() {
    const req = https.request({
        host: cfg.BridgeIP, path: '/eventstream/clip/v2', agent: new https.Agent({ rejectUnauthorized: false }),
        headers: { 'hue-application-key': cfg.Username, Accept: 'text/event-stream' },
    }, res => {
        log('Ecoute de la telecommande active.');
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, i); buf = buf.slice(i + 2);
                const dataLine = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('');
                if (!dataLine) continue;
                try { JSON.parse(dataLine).forEach(evt => (evt.data || []).forEach(onHueEvent)); } catch (e) { /* bloc incomplet */ }
            }
        });
        res.on('end', () => { log('Flux Hue coupe, reconnexion...'); setTimeout(listen, 3000); });
    });
    req.on('error', e => { log('Erreur flux Hue :', e.message, '- nouvel essai dans 10 s'); setTimeout(listen, 10000); });
    req.end();
}

(async () => {
    try {
        await setupHue();
        await setupLights();
        await setupAlexa();
        listen();
    } catch (e) {
        log('Demarrage impossible :', e.message || e);
        process.exit(1);
    }
})();
