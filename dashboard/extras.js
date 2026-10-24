// Ambiances en un clic (ambiances.json) + meteo Paris / Deauville (Open-Meteo, sans cle).
const dgram = require('dgram');
const config = require('./config');   // fichiers dans dataDir (dashboard/ sur le PC, /data dans le conteneur)

const HOUSES = ['paris', 'deauville'];

function deauvilleConfig() {
    const c = config.readJson('deauville-config.json', {});
    return c && typeof c === 'object' ? c : {};
}

// Allumage direct de la Xbox (protocole SmartGlass, UDP 5050) : paquet "power on" avec l'ID Xbox Live.
// Prerequis sur la console : mode d'alimentation "Veille" + fonctionnalites a distance.
function xboxWake(liveId, ip, tries = 5) {
    return new Promise((resolve, reject) => {
        const id = Buffer.from(String(liveId).trim(), 'ascii');
        const payload = Buffer.concat([Buffer.from([0x00, id.length]), id, Buffer.from([0x00])]);
        const packet = Buffer.concat([Buffer.from([0xdd, 0x02, 0x00, payload.length, 0x00, 0x00]), payload]);
        const sock = dgram.createSocket('udp4');
        let n = 0, failed = null;
        sock.bind(() => sock.setBroadcast(true));
        const tick = () => {
            const targets = ip ? [ip, '255.255.255.255'] : ['255.255.255.255'];
            targets.forEach(t => sock.send(packet, 5050, t, e => { if (e) failed = e; }));
            if (++n >= tries) { setTimeout(() => { sock.close(); failed ? reject(failed) : resolve(n); }, 300); }
            else setTimeout(tick, 1000);
        };
        sock.on('error', e => { failed = e; });
        setTimeout(tick, 50);
    });
}

function loadAmbiances() {
    const j = config.readJson('ambiances.json', []);   // dataDir, sinon la copie livree avec le code
    return Array.isArray(j) ? j : (j && j.ambiances) || [];
}

// ctx : { hue(method, path, body), alexa() -> instance ou null, setVolume(serial, v), bulbCommand(body), log(msg) }
function create(ctx) {
    const status = { running: null, step: null, error: null, log: [] };
    const cb = fn => new Promise((res, rej) => fn((e, r) => e ? rej(e) : res(r)));

    function alexaDevice(name) {
        const a = ctx.alexa();
        if (!a) throw new Error('Alexa pas encore connectée');
        const d = Object.values(a.serialNumbers).find(x => x.accountName === name);
        if (!d) throw new Error(`Alexa « ${name} » introuvable`);
        return { a, d };
    }

    async function hueRoomByName(name) {
        const [rooms, zones] = await Promise.all([ctx.hue('GET', 'room'), ctx.hue('GET', 'zone')]);
        const r = [...rooms, ...zones].find(x => x.metadata.name === name);
        if (!r) throw new Error(`Pièce Hue « ${name} » introuvable`);
        return r;
    }

    const STEPS = {
        async hueScene(s) {
            const scenes = (await ctx.hue('GET', 'scene')).filter(x => x.metadata.name === s.name);
            if (!scenes.length) throw new Error(`Scène « ${s.name} » introuvable`);
            let scene = scenes[0];
            if (s.room) {
                const r = await hueRoomByName(s.room).catch(() => null);
                scene = (r && scenes.find(x => x.group.rid === r.id)) || scene;   // sinon la 1re scene de ce nom
            }
            await ctx.hue('PUT', `scene/${scene.id}`, { recall: { action: 'active' } });
        },
        async hueRoom(s) {
            const r = await hueRoomByName(s.name);
            const g = r.services.find(x => x.rtype === 'grouped_light');
            if (!g) throw new Error(`« ${s.name} » n'a pas de lumières`);
            const body = {};
            if (s.on !== undefined) body.on = { on: !!s.on };
            if (s.brightness !== undefined) { body.on = { on: true }; body.dimming = { brightness: Math.max(1, Math.min(100, +s.brightness)) }; }
            await ctx.hue('PUT', `grouped_light/${g.rid}`, body);
        },
        async alexaVolume(s) { const { d } = alexaDevice(s.device); ctx.setVolume(d.serialNumber, Math.max(0, Math.min(100, +s.volume))); },
        async alexaStop(s) { const { a, d } = alexaDevice(s.device); await cb(c => a.sendSequenceCommand(d.serialNumber, 'deviceStop', null, c)); },
        async alexaSpeak(s) { const { a, d } = alexaDevice(s.device); await cb(c => a.sendSequenceCommand(d.serialNumber, 'speak', String(s.text || ''), c)); },
        async nanoleaf(s) {
            const { type, ...body } = s;
            ctx.bulbCommand(body);   // file Bluetooth : la commande part dans l'ordre, sans bloquer
        },
        async wait(s) { await new Promise(r => setTimeout(r, Math.max(0, Math.min(60000, +s.ms || 0)))); },
    };

    function stepsFor(amb, house) {
        const steps = amb[house] || [];
        for (const s of steps) if (!STEPS[s.type]) throw new Error(`Étape inconnue : ${s.type}`);
        return steps;
    }

    async function run(amb, house, steps) {
        status.running = amb.id; status.error = null; status.log = [];
        for (let i = 0; i < steps.length; i++) {
            status.step = i + 1;
            try { await STEPS[steps[i].type](steps[i]); }
            catch (e) {   // appareil hors de portee : on note et on continue
                const msg = `Étape ${i + 1} (${steps[i].type}) : ${e.message}`;
                status.error = msg; status.log.push(msg); ctx.log(`Ambiance ${amb.id} - ${msg}`);
            }
        }
        status.running = null; status.step = null;
    }

    // ---------- meteo ----------
    const PLACES = { paris: [48.8566, 2.3522], deauville: [49.3570, 0.0700] };
    const WMO = [
        [[0], '☀️', 'Dégagé'], [[1], '🌤', 'Peu nuageux'], [[2], '⛅', 'Nuageux'], [[3], '☁️', 'Couvert'],
        [[45, 48], '🌫', 'Brouillard'], [[51, 53, 55, 56, 57], '🌦', 'Bruine'], [[61, 63, 65, 66, 67], '🌧', 'Pluie'],
        [[71, 73, 75, 77], '❄️', 'Neige'], [[80, 81, 82], '🌧', 'Averses'], [[85, 86], '🌨', 'Averses de neige'],
        [[95, 96, 99], '⛈', 'Orage'],
    ];
    const wmo = c => WMO.find(w => w[0].includes(c)) || [[], '🌡', 'Inconnu'];
    const weatherCache = {};   // house -> { at, data }

    async function weatherOne(house) {
        const c = weatherCache[house];
        if (c && Date.now() - c.at < 15 * 60000) return c.data;
        const [lat, lon] = PLACES[house];
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m`
            + '&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=Europe%2FParis&forecast_days=1';
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            const [, icon, label] = wmo(j.current.weather_code);
            const hm = s => (s || '').slice(11, 16);
            const data = {
                temp: Math.round(j.current.temperature_2m), code: j.current.weather_code, label, icon,
                wind: Math.round(j.current.wind_speed_10m), high: Math.round(j.daily.temperature_2m_max[0]),
                low: Math.round(j.daily.temperature_2m_min[0]), sunrise: hm(j.daily.sunrise[0]), sunset: hm(j.daily.sunset[0]),
            };
            weatherCache[house] = { at: Date.now(), data };
            return data;
        } catch (e) {
            return c ? c.data : { error: 'Météo indisponible : ' + e.message };
        }
    }

    const routes = {
        'GET /api/ambiances': async q => {
            const house = HOUSES.includes(q.house) ? q.house : 'paris';
            return loadAmbiances().map(a => ({ id: a.id, name: a.name, emoji: a.emoji, steps: (a[house] || []).length }));
        },
        'POST /api/ambiance/run': async b => {
            const house = HOUSES.includes(b.house) ? b.house : null;
            if (!house) throw new Error('Maison invalide');
            const amb = loadAmbiances().find(a => a.id === b.id);
            if (!amb) throw new Error('Ambiance inconnue');
            if (status.running) throw new Error('Une ambiance est déjà en cours');
            const steps = stepsFor(amb, house);
            run(amb, house, steps);
            return { started: true };
        },
        'GET /api/ambiance/status': async () => ({ running: status.running, step: status.step, error: status.error }),
        'GET /api/weather': async () => {
            const [paris, deauville] = await Promise.all(HOUSES.map(weatherOne));
            return { paris, deauville };
        },
        // Xbox via la skill Xbox d'Alexa : l'Echo recoit la phrase comme si on la disait
        'POST /api/xbox': async b => {
            const phrases = {
                on: 'allume la Xbox',
                off: 'éteins la Xbox',
                pause: 'mets en pause sur la Xbox',
                play: 'reprends la lecture sur la Xbox',
                home: "va à l'accueil sur la Xbox",
                volup: 'monte le volume de la Xbox',
                voldown: 'baisse le volume de la Xbox',
                screenshot: "prends une capture d'écran sur la Xbox",
            };
            let text = phrases[b.action];
            if (b.action === 'launch') {
                const game = String(b.game || '').trim();
                if (!game) throw new Error('Indique le jeu à lancer');
                text = `lance ${game} sur la Xbox`;
            }
            const dv = deauvilleConfig();
            // "wake" : allumage direct par le reseau, sans Alexa (PC allume)
            if (b.action === 'wake' || (b.action === 'on' && dv.xboxLiveId)) {
                if (!dv.xboxLiveId) throw new Error('ID Xbox Live manquant dans deauville-config.json');
                const sent = await xboxWake(dv.xboxLiveId, dv.xboxIp);
                ctx.log && ctx.log(`Xbox : paquet d'allumage direct envoye (${sent} essais)`);
                if (b.action === 'wake') return { sent: 'allumage direct (réseau)' };
                // pour "on", on envoie aussi la phrase a Alexa si elle est disponible (double securite)
                try {
                    const { a, d } = alexaDevice(b.device || 'Deauville');
                    await cb(c => a.sendSequenceCommand(d.serialNumber, 'textCommand', text, c));
                } catch (e) { /* Alexa indisponible : l'allumage direct suffit */ }
                return { sent: 'allumage direct (réseau) + « allume la Xbox »' };
            }
            if (!text) throw new Error('Action Xbox inconnue');
            const { a, d } = alexaDevice(b.device || 'Deauville');
            await cb(c => a.sendSequenceCommand(d.serialNumber, 'textCommand', text, c));
            ctx.log && ctx.log(`Xbox : « ${text} » via ${d.accountName}`);
            return { sent: text };
        },
    };

    return { routes, loadAmbiances, stepsFor };
}

module.exports = { create };
