// Emplacement des fichiers de donnees + bootstrap des secrets depuis l'environnement.
//
// - Sur le PC : dataDir = ce dossier (dashboard/), rien ne change.
// - Dans le conteneur (iHost) : MAISON_DATA=/data (volume). Au 1er demarrage, un fichier absent de /data est
//   cree a partir de la variable d'environnement correspondante (JSON brut, ou base64 d'un JSON, ou base64 d'un
//   JSON gzippe). Ensuite c'est le fichier de /data qui fait foi (mis a jour par le serveur : cookie Amazon
//   rafraichi, jeton de tele, etc.). Variante tout-en-un : MAISON_BOOTSTRAP (voir applyBootstrapBundle).
// - Un fichier absent partout tombe sur la copie livree avec le code (ex. ambiances.json), puis sur `fallback`.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const env = process.env;
const inContainer = !!env.MAISON_DATA;
const dataDir = env.MAISON_DATA || __dirname;

// nom de fichier -> variable d'environnement qui le fournit au 1er demarrage
const ENV_FILES = {
    'hue-config.json': 'HUE_CONFIG',           // { BridgeIP, Username, ClientKey }
    'alexa-cookie.json': 'ALEXA_COOKIE',       // base64 (gzip) de alexa/alexa-cookie.json
    'tv-tokens.json': 'TV_TOKENS',             // { salon: "...", grande: "...", samsung43: "..." }
    'deauville-config.json': 'DEAUVILLE_CONFIG', // { sonyPsk: "..." }
    'ambiances.json': 'AMBIANCES',             // facultatif : sinon la copie livree avec le code
};

try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* lecture seule : on verra a l'ecriture */ }

const stripBom = s => String(s).replace(/^﻿/, '');
const filePath = name => path.join(dataDir, path.basename(name));
const bundledPath = name => path.join(__dirname, path.basename(name));

// Variable d'env -> texte JSON. Accepte : JSON brut, base64(JSON), base64(gzip(JSON)).
function decodeEnv(value) {
    const v = String(value || '').trim();
    if (!v) return null;
    if (/^[\[{]/.test(v)) return stripBom(v);
    let buf;
    try { buf = Buffer.from(v.replace(/\s+/g, ''), 'base64'); } catch (e) { return null; }
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        try { buf = zlib.gunzipSync(buf); } catch (e) { return null; }
    }
    const text = stripBom(buf.toString('utf8'));
    return /^\s*[\[{]/.test(text) ? text : null;
}

function parse(text, name) {
    try { return JSON.parse(stripBom(text)); }
    catch (e) { throw new Error(`${name} : JSON invalide (${e.message})`); }
}

function writeText(name, text) {
    const p = filePath(name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, p);   // ecriture atomique : jamais de fichier a moitie ecrit
    return p;
}

// 1er demarrage : cree le fichier dans dataDir depuis la variable d'environnement. Renvoie true si cree.
function bootstrap(name) {
    const varName = ENV_FILES[path.basename(name)];
    if (!varName || !env[varName]) return false;
    const text = decodeEnv(env[varName]);
    if (!text) { console.log(`[config] ${varName} ignore : ni JSON ni base64 de JSON`); return false; }
    try {
        const obj = parse(text, varName);
        writeText(name, JSON.stringify(obj, null, 2));
        console.log(`[config] ${name} cree depuis ${varName} dans ${dataDir}`);
        return true;
    } catch (e) { console.log(`[config] ${e.message}`); return false; }
}

// readJson(name, fallback) : dataDir -> variable d'env (bootstrap) -> copie livree -> fallback (sinon erreur)
function readJson(name, fallback) {
    const p = filePath(name);
    if (!fs.existsSync(p)) bootstrap(name);
    if (fs.existsSync(p)) {
        try { return parse(fs.readFileSync(p, 'utf8'), name); }
        catch (e) { console.log(`[config] ${e.message}`); if (fallback !== undefined) return fallback; throw e; }
    }
    const b = bundledPath(name);
    if (b !== p && fs.existsSync(b)) {
        try { return parse(fs.readFileSync(b, 'utf8'), name); } catch (e) { /* copie livree illisible */ }
    }
    if (fallback !== undefined) return fallback;
    const varName = ENV_FILES[path.basename(name)];
    throw new Error(`${name} introuvable dans ${dataDir}${varName ? ` (ou variable d'environnement ${varName} / MAISON_BOOTSTRAP)` : ''}`);
}

function writeJson(name, obj) {
    return writeText(name, JSON.stringify(obj, null, 2));
}

const exists = name => fs.existsSync(filePath(name)) || (bootstrap(name) && fs.existsSync(filePath(name)));

// ---------- MAISON_BOOTSTRAP : tout en une seule variable ----------
// base64 (gzip facultatif) d'un JSON :
//   { "files": { "hue-config.json": {...}, "alexa-cookie.json": {...}, ... },
//     "env":   { "MAISON_PIN": "123456", "MAISON_LAN_IP": "192.168.1.91", "ALEXA_PROXY_IP": "...", "TZ": "Europe/Paris" } }
// Produit par `.\prepare-env.ps1 -Bootstrap`. Memes regles que les variables par fichier : un fichier n'est cree dans
// dataDir que s'il n'existe pas encore ; une entree `env` n'est appliquee que si la variable n'est pas deja definie
// (une variable saisie a la main dans l'iHost garde donc la priorite). Doit tourner AVANT la lecture des reglages.
function applyBootstrapBundle() {
    if (!env.MAISON_BOOTSTRAP) return;
    const text = decodeEnv(env.MAISON_BOOTSTRAP);
    if (!text) { console.log('[config] MAISON_BOOTSTRAP ignore : ni JSON ni base64 de JSON'); return; }
    let bundle;
    try { bundle = parse(text, 'MAISON_BOOTSTRAP'); } catch (e) { console.log(`[config] ${e.message}`); return; }
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
        console.log('[config] MAISON_BOOTSTRAP ignore : il faut un objet { files, env }');
        return;
    }
    const files = (bundle.files && typeof bundle.files === 'object') ? bundle.files : {};
    for (const [name, value] of Object.entries(files)) {
        if (value === null || value === undefined) continue;
        const base = path.basename(name);
        if (!/\.json$/i.test(base)) { console.log(`[config] MAISON_BOOTSTRAP : ${name} ignore (pas un .json)`); continue; }
        if (fs.existsSync(filePath(base))) continue;      // le fichier de dataDir fait foi
        try {
            const obj = typeof value === 'string' ? parse(value, base) : value;   // objet direct, ou JSON en texte
            writeText(base, JSON.stringify(obj, null, 2));
            console.log(`[config] ${base} cree depuis MAISON_BOOTSTRAP dans ${dataDir}`);
        } catch (e) { console.log(`[config] ${e.message}`); }
    }
    const vars = (bundle.env && typeof bundle.env === 'object') ? bundle.env : {};
    for (const [key, value] of Object.entries(vars)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value === null || value === undefined) continue;
        if (String(env[key] || '').trim()) continue;      // deja definie : on ne touche pas
        env[key] = String(value);
    }
}
applyBootstrapBundle();

// ---------- reglages serveur ----------
const pin = /^\d{4,6}$/.test(String(env.MAISON_PIN || '').trim()) ? String(env.MAISON_PIN).trim() : null;
if (env.MAISON_PIN && !pin) console.log('[config] MAISON_PIN ignore : il faut 4 a 6 chiffres');

const settings = {
    pin,                                                        // null = pas de code (acces local seulement)
    bind: (env.MAISON_BIND || (inContainer ? '0.0.0.0' : '127.0.0.1')).trim(),
    port: +env.MAISON_PORT || 8090,
    lanIp: (env.MAISON_LAN_IP || '').trim() || null,            // IP de la machine vue par les teles (iHost : 192.168.1.91)
    alexaProxyIp: (env.ALEXA_PROXY_IP || '').trim() || null,    // IP affichee pour la page de connexion Amazon (port 3001)
    inContainer, dataDir,
};

module.exports = { dataDir, inContainer, filePath, readJson, writeJson, exists, env: settings, ENV_FILES };
