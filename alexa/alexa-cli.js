// Outil Alexa en ligne de commande, appele par le module PowerShell.
// Usage : node alexa-cli.js <commande> [appareil] [valeur...]
//   list                       appareils + volume + lecture en cours
//   volume <appareil> <0-100|+N|-N>
//   play|pause|next|previous|stop <appareil>
//   music <appareil> <recherche>   ex. "musique jazz sur Spotify"
//   speak <appareil> <texte>
//   cmd <appareil> <texte>          commande comme si on parlait a Alexa
// La sortie est toujours une ligne JSON : {"ok":true,...} ou {"ok":false,"error":"..."}
const { connect } = require('./alexa-common');

const SPEAKER_FAMILIES = ['ECHO', 'KNIGHT', 'ROOK', 'WHA'];
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const out = obj => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(obj.ok ? 0 : 1); };
const cb = fn => new Promise((res, rej) => fn((e, r) => e ? rej(e) : res(r)));

function speakers(alexa) {
    return Object.values(alexa.serialNumbers).filter(d => SPEAKER_FAMILIES.includes(d.deviceFamily));
}

function findDevice(alexa, name) {
    const all = speakers(alexa);
    const k = norm(name);
    let hit = all.filter(d => norm(d.accountName) === k);
    if (!hit.length) hit = all.filter(d => norm(d.accountName).includes(k));
    if (hit.length !== 1) {
        throw new Error(hit.length ? `"${name}" est ambigu : ${hit.map(d => d.accountName).join(', ')}`
            : `Alexa "${name}" introuvable. Disponibles : ${all.map(d => d.accountName).join(', ')}`);
    }
    return hit[0];
}

// Un groupe multiroom (WHA) : le volume s'applique a chacun de ses membres
const targetsOf = (alexa, dev) => dev.deviceFamily === 'WHA'
    ? dev.clusterMembers.map(s => alexa.serialNumbers[s]).filter(Boolean) : [dev];

async function volumes(alexa) {
    const r = await cb(c => alexa.getAllDeviceVolumes(c));
    const v = {};
    (r.volumes || []).forEach(x => { v[x.dsn] = x.speakerVolume; });
    return v;
}

async function nowPlaying(alexa, dev) {
    try {
        const r = await cb(c => alexa.getPlayerInfo(dev.serialNumber, c));
        const p = r && r.playerInfo;
        if (!p || !p.infoText) return null;
        return {
            state: p.state, title: p.infoText.title, artist: p.infoText.subText1, source: p.provider && p.provider.providerName,
            progress: p.progress && p.progress.mediaProgress, length: p.progress && p.progress.mediaLength,
        };
    } catch (e) { return null; }
}

async function main() {
    const [command, name, ...rest] = process.argv.slice(2);
    const value = rest.join(' ');
    const alexa = await connect();

    switch (command) {
        case 'list': {
            const vol = await volumes(alexa);
            const list = [];
            for (const d of speakers(alexa)) {
                const isGroup = d.deviceFamily === 'WHA';
                list.push({
                    name: d.accountName,
                    group: isGroup,
                    members: isGroup ? targetsOf(alexa, d).map(m => m.accountName) : [],
                    online: d.online,
                    volume: isGroup ? null : (vol[d.serialNumber] != null ? vol[d.serialNumber] : null),
                    playing: d.online ? await nowPlaying(alexa, d) : null,
                });
            }
            return out({ ok: true, devices: list });
        }
        case 'volume': {
            const dev = findDevice(alexa, name);
            const vol = await volumes(alexa);
            const done = [];
            for (const t of targetsOf(alexa, dev)) {
                const cur = vol[t.serialNumber] != null ? vol[t.serialNumber] : 20;
                const next = /^[+-]/.test(value) ? cur + parseInt(value, 10) : parseInt(value, 10);
                if (isNaN(next)) throw new Error('Volume invalide : donne un nombre 0-100, ou +N / -N');
                const v = Math.max(0, Math.min(100, next));
                await cb(c => alexa.sendSequenceCommand(t.serialNumber, 'volume', v, c));
                done.push({ name: t.accountName, volume: v });
            }
            return out({ ok: true, result: done });
        }
        case 'play': case 'pause': case 'next': case 'previous': {
            const dev = findDevice(alexa, name);
            await cb(c => alexa.sendCommand(dev.serialNumber, command, null, c));
            return out({ ok: true });
        }
        case 'stop': {
            const dev = findDevice(alexa, name);
            await cb(c => alexa.sendSequenceCommand(dev.serialNumber, 'deviceStop', null, c));
            return out({ ok: true });
        }
        case 'music': {
            const dev = findDevice(alexa, name);
            if (!value) throw new Error('Precise ce qu\'il faut jouer');
            await cb(c => alexa.sendSequenceCommand(dev.serialNumber, 'textCommand', `joue ${value}`, c));
            return out({ ok: true });
        }
        case 'speak': {
            const dev = findDevice(alexa, name);
            await cb(c => alexa.sendSequenceCommand(dev.serialNumber, 'speak', value, c));
            return out({ ok: true });
        }
        case 'cmd': {
            const dev = findDevice(alexa, name);
            await cb(c => alexa.sendSequenceCommand(dev.serialNumber, 'textCommand', value, c));
            return out({ ok: true });
        }
        default:
            throw new Error(`Commande inconnue : ${command}`);
    }
}

main().catch(e => out({ ok: false, error: String(e && e.message || e) }));
