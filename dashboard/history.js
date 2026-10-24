// Historique des commandes (history.json, 200 dernieres) + libelles francais des actions.
const fs = require('fs');
const path = require('path');

function create({ file = path.join(__dirname, 'history.json'), max = 200 } = {}) {
    let items = [];
    try {
        items = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
        if (!Array.isArray(items)) items = [];
    } catch (e) { items = []; }

    function save() {   // ecriture atomique : jamais de fichier a moitie ecrit (coupure de courant sur l'iHost)
        try { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(items)); fs.renameSync(tmp, file); } catch (e) { /* disque */ }
    }

    // append({ house?, text, source? }) -> entree ajoutee
    function append(entry) {
        const e = { at: Date.now(), source: 'pc', ...entry };
        if (e.house === undefined || e.house === null) delete e.house;
        items.push(e);
        if (items.length > max) items.splice(0, items.length - max);
        save();
        return e;
    }

    function list(limit = 50) {
        const n = Math.max(1, Math.min(max, Math.round(+limit) || 50));
        return items.slice(-n).reverse();   // plus recent d'abord
    }

    const routes = {
        'GET /api/history': async q => list(q.limit),
    };

    return { append, list, routes };
}

// ---------- libelles ----------
const MASC = ['salon', 'bureau', 'couloir', 'garage', 'jardin', 'escalier', 'grenier', 'hall', 'dressing', 'wc', 'palier',
    'balcon', 'sous-sol', 'cellier', 'atelier', 'séjour', 'sejour', 'vestibule', 'spot', 'plafonnier', 'lampadaire', 'ruban'];
const fem = name => !MASC.includes(String(name || '').trim().split(/\s+/)[0].toLowerCase());
const onOff = (name, on) => `${name} ${on ? 'allumé' : 'éteint'}${fem(name) ? 'e' : ''}`;
const q = s => `« ${String(s || '').trim().slice(0, 60)} »`;

// Etat Hue (groupe ou lumiere) -> texte
function hueText(name, b) {
    if (b.on === false) return onOff(name, false);
    if (b.brightness !== undefined) return `${name} → ${Math.round(+b.brightness)} %`;
    if (b.xy) return `${name} : couleur`;
    if (b.mirek) return `${name} : blanc ${Math.round(1000000 / +b.mirek)} K`;
    if (b.on === true) return onOff(name, true);
    return name;
}

// ctx : { hueName(id), alexaName(serial), alexaHouse(serial), tvName(key), tvHouse(key), ambianceName(id) }
function createDescriber(ctx) {
    const get = (fn, ...a) => { try { return ctx[fn] ? ctx[fn](...a) : null; } catch (e) { return null; } };
    const alexaName = s => get('alexaName', s) || 'Alexa';
    const tvName = k => get('tvName', k) || 'Télé';
    const MEDIA = { play: 'lecture', pause: 'pause', next: 'suivant', previous: 'précédent' };

    // (method+url, body, result) -> { house?, text }
    function describe(route, b = {}, result) {
        b = b || {};
        switch (route) {
            case 'POST /api/group': return { house: 'paris', text: hueText(get('hueName', b.id) || 'Pièce', b) };
            case 'POST /api/light': return { house: 'paris', text: hueText(get('hueName', b.id) || 'Lumière', b) };
            case 'POST /api/scene': return { house: 'paris', text: `Scène ${get('hueName', b.id) || ''}`.trim() };
            case 'POST /api/alexa/volume': return { house: get('alexaHouse', b.serial), text: `Volume ${alexaName(b.serial)} → ${Math.round(+b.volume)}` };
            case 'POST /api/alexa/media': return { house: get('alexaHouse', b.serial), text: `${alexaName(b.serial)} : ${MEDIA[b.action] || b.action}` };
            case 'POST /api/alexa/music': return { house: get('alexaHouse', b.serial), text: `${alexaName(b.serial)} : joue ${q(b.search)}` };
            case 'POST /api/alexa/speak': return { house: get('alexaHouse', b.serial), text: `${alexaName(b.serial)} dit ${q(b.text)}` };
            case 'POST /api/alexa/cmd': return { house: get('alexaHouse', b.serial), text: `${alexaName(b.serial)} : ${q(b.text)}` };
            case 'POST /api/alexa/stop': return { house: get('alexaHouse', b.serial), text: `${alexaName(b.serial)} : stop` };
            case 'POST /api/tv/power': return { house: get('tvHouse', b.key), text: onOff(tvName(b.key), !!b.on) };
            case 'POST /api/tv/speak': return { house: get('tvHouse', b.key), text: `${tvName(b.key)} dit ${q(b.text)}` };
            case 'POST /api/tv/volume': { const s = +b.steps || 0; return { house: get('tvHouse', b.key), text: `${tvName(b.key)} : volume ${s > 0 ? '+' : ''}${s}` }; }
            case 'POST /api/tv/volume-set': return { house: get('tvHouse', b.key), text: `${tvName(b.key)} : volume → ${Math.round(+b.volume)}` };
            case 'POST /api/tv/mute': return { house: get('tvHouse', b.key), text: `${tvName(b.key)} : sourdine` };
            case 'POST /api/tv/text': return { house: get('tvHouse', b.key), text: `${tvName(b.key)} : message ${q(b.text)}` };
            case 'POST /api/tv/clear': return { house: get('tvHouse', b.key), text: `${tvName(b.key)} : message effacé` };
            case 'POST /api/tv/remote': return { house: get('tvHouse', b.key), text: `${tvName(b.key)} : touche ${b.button}` };
            case 'POST /api/deauville/bulb': {
                const name = b.id === 'all' ? 'Nanoleaf' : `Ampoule ${b.id}`;
                if (b.on === false) return { house: 'deauville', text: b.id === 'all' ? 'Nanoleaf éteintes' : onOff(name, false) };
                if (b.hue != null || b.saturation != null) return { house: 'deauville', text: `${name} : couleur` };
                if (b.kelvin != null) return { house: 'deauville', text: `${name} : blanc ${Math.round(+b.kelvin)} K` };
                if (b.brightness != null) return { house: 'deauville', text: `${name} → ${Math.round(+b.brightness)} %` };
                return { house: 'deauville', text: b.id === 'all' ? 'Nanoleaf allumées' : onOff(name, true) };
            }
            case 'POST /api/xbox': return { house: 'deauville', text: `Xbox : ${(result && result.sent) || b.action || ''}`.trim() };
            case 'POST /api/ambiance/run': return { house: b.house, text: `Ambiance ${get('ambianceName', b.id) || b.id || ''}`.trim() };
            default: return { text: route.replace(/^POST \/api\//, '').replace(/\//g, ' ') };
        }
    }

    // Cible d'un minuteur -> texte (sans le prefixe "Minuteur : ")
    function describeTarget(t = {}) {
        switch (t.type) {
            case 'hueRoom': return onOff(t.name, false);
            case 'hueAll': return 'Toutes les lumières Paris éteintes';
            case 'bulbs': return 'Nanoleaf éteintes';
            case 'alexaStop': return `${t.device} : stop`;
            case 'alexaVolume': return `Volume ${t.device} → ${Math.round(+t.volume)}`;
            case 'tvOff': return onOff(tvName(t.key), false);
            case 'xbox': return 'Xbox : éteins la Xbox';
            default: return String(t.type || 'inconnu');
        }
    }

    return { describe, describeTarget };
}

module.exports = { create, createDescriber };
