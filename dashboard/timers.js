// Minuteurs (sommeil) : timers.json, restaures au redemarrage. Quand il sonne : execute, historique, supprime.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOUSES = ['paris', 'deauville'];
const TYPES = ['hueRoom', 'hueAll', 'bulbs', 'alexaStop', 'alexaVolume', 'tvOff', 'xbox'];
const MAX_MINUTES = 720;
const STALE_MS = 60 * 60000;   // un minuteur echu depuis plus d'1 h au redemarrage est abandonne

const bad = msg => { const e = new Error(msg); e.status = 400; return e; };

// ctx : { file?, execute(target) -> Promise, describeTarget(target) -> texte, tvHouse(key) -> maison|null,
//         onFired({ timer, ok, error }) , log(msg) }
function create(ctx) {
    const file = ctx.file || path.join(__dirname, 'timers.json');
    const log = ctx.log || (() => {});
    const timers = new Map();   // id -> { id, label, house, target, endsAt, createdAt, handle }

    function save() {   // ecriture atomique : jamais de fichier a moitie ecrit
        try {
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify([...timers.values()].map(pub), null, 2));
            fs.renameSync(tmp, file);
        } catch (e) { /* disque */ }
    }
    const pub = t => ({ id: t.id, label: t.label, house: t.house, target: t.target, endsAt: t.endsAt, createdAt: t.createdAt });

    function validateTarget(t) {
        if (!t || typeof t !== 'object' || !TYPES.includes(t.type)) throw bad('Type de minuteur inconnu');
        const str = (v, m) => { if (typeof v !== 'string' || !v.trim()) throw bad(m); return v.trim(); };
        switch (t.type) {
            case 'hueRoom': return { type: 'hueRoom', name: str(t.name, 'Nom de pièce manquant') };
            case 'hueAll': return { type: 'hueAll' };
            case 'bulbs': return { type: 'bulbs' };
            case 'alexaStop': return { type: 'alexaStop', device: str(t.device, 'Appareil Alexa manquant') };
            case 'alexaVolume': {
                const v = Math.round(+t.volume);
                if (!Number.isFinite(v) || v < 0 || v > 100) throw bad('Volume 0–100 attendu');
                return { type: 'alexaVolume', device: str(t.device, 'Appareil Alexa manquant'), volume: v };
            }
            case 'tvOff': {
                const key = str(t.key, 'Télé manquante');
                if (ctx.tvHouse && !ctx.tvHouse(key)) throw bad('Télé inconnue');
                return { type: 'tvOff', key };
            }
            case 'xbox':
                if (t.action !== 'off') throw bad('Action Xbox non prise en charge (off uniquement)');
                return { type: 'xbox', action: 'off', ...(t.device ? { device: String(t.device) } : {}) };
        }
    }

    function defaultHouse(t) {
        if (t.type === 'hueRoom' || t.type === 'hueAll') return 'paris';
        if (t.type === 'bulbs' || t.type === 'xbox') return 'deauville';
        if (t.type === 'tvOff' && ctx.tvHouse) return ctx.tvHouse(t.key);
        return null;
    }

    async function fire(id) {
        const t = timers.get(id);
        if (!t) return;
        timers.delete(id);
        save();
        let ok = true, error = null;
        try { await ctx.execute(t.target); }
        catch (e) { ok = false; error = e.message || String(e); }
        log(`Minuteur « ${t.label} » : ${ok ? 'exécuté' : 'échec : ' + error}`);
        try { ctx.onFired && ctx.onFired({ timer: pub(t), ok, error }); } catch (e) { /* historique */ }
    }

    function schedule(t) {
        clearTimeout(t.handle);
        // setTimeout plafonne a ~24,8 jours ; un minuteur fait 12 h max mais on reste prudent
        t.handle = setTimeout(() => { fire(t.id).catch(e => log(`Minuteur : ${e.message || e}`)); }, Math.min(2147483647, Math.max(0, t.endsAt - Date.now())));
        timers.set(t.id, t);
    }

    function add({ house, target, minutes, label }) {
        const tgt = validateTarget(target);
        const m = Math.round(+minutes);
        if (!Number.isFinite(m) || m < 1 || m > MAX_MINUTES) throw bad(`Durée : 1 à ${MAX_MINUTES} minutes`);
        const h = HOUSES.includes(house) ? house : defaultHouse(tgt);
        if (!h) throw bad('Maison invalide');
        const now = Date.now();
        const t = {
            id: crypto.randomBytes(5).toString('hex'),
            label: (typeof label === 'string' && label.trim()) ? label.trim().slice(0, 80) : ctx.describeTarget(tgt),
            house: h, target: tgt, endsAt: now + m * 60000, createdAt: now,
        };
        schedule(t);
        save();
        return { id: t.id, endsAt: t.endsAt };
    }

    function cancel(id) {
        const t = timers.get(String(id || ''));
        if (!t) throw bad('Minuteur inconnu');
        clearTimeout(t.handle);
        timers.delete(t.id);
        save();
    }

    function list() { return [...timers.values()].map(pub).sort((a, b) => a.endsAt - b.endsAt); }

    // Restauration au demarrage
    (function restore() {
        let saved = [];
        try { saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { saved = []; }
        if (!Array.isArray(saved)) saved = [];
        let dropped = 0;
        for (const s of saved) {
            try {
                const tgt = validateTarget(s.target);
                if (!s.id || !Number.isFinite(+s.endsAt)) throw new Error('entrée invalide');
                if (Date.now() - +s.endsAt > STALE_MS) { dropped++; continue; }
                schedule({ id: String(s.id), label: String(s.label || ctx.describeTarget(tgt)), house: HOUSES.includes(s.house) ? s.house : defaultHouse(tgt),
                    target: tgt, endsAt: +s.endsAt, createdAt: +s.createdAt || Date.now() });
            } catch (e) { dropped++; }
        }
        if (timers.size || dropped) log(`Minuteurs restaurés : ${timers.size}${dropped ? ` (${dropped} abandonné(s))` : ''}`);
        if (dropped) save();
    })();

    const routes = {
        'GET /api/timers': async () => list(),
        'POST /api/timers': async b => add(b || {}),
        'POST /api/timers/cancel': async b => { cancel(b && b.id); return {}; },
    };

    return { routes, add, cancel, list, fire, TYPES };
}

module.exports = { create, TYPES, MAX_MINUTES };
