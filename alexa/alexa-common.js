// Connexion Alexa partagee : reutilise le jeton enregistre, sinon ouvre le proxy de connexion Amazon.
const fs = require('fs');
const path = require('path');
const Alexa = require('alexa-remote2');
const config = require('../dashboard/config');

// Sur le PC : alexa/alexa-cookie.json (inchange). Dans le conteneur : ${MAISON_DATA}/alexa-cookie.json,
// cree au 1er demarrage depuis la variable ALEXA_COOKIE (voir dashboard/config.js).
const COOKIE_NAME = 'alexa-cookie.json';
const COOKIE_FILE = config.inContainer ? config.filePath(COOKIE_NAME) : path.join(__dirname, COOKIE_NAME);
const PROXY_PORT = 3001;
const PROXY_IP = config.env.alexaProxyIp || 'localhost';

function readCookie() {
    if (config.inContainer) {
        try { return config.readJson(COOKIE_NAME, null); } catch (e) { return null; }
    }
    try { return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8').replace(/^﻿/, '')); } catch (e) { return null; }   // premiere connexion
}

function writeCookie(data) {
    if (config.inContainer) return config.writeJson(COOKIE_NAME, data);
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(data, null, 2));
}

function connect(log = () => {}) {
    return new Promise((resolve, reject) => {
        const alexa = new Alexa();
        const saved = readCookie();

        alexa.on('cookie', () => {
            try { writeCookie(alexa.cookieData); log('Jeton Amazon enregistre.'); }
            catch (e) { console.log('Alexa : jeton non enregistre :', e.message); }
        });

        if (!saved) {
            console.log(`\n>>> Ouvre http://${PROXY_IP}:${PROXY_PORT} dans ton navigateur et connecte-toi a ton compte Amazon.\n`);
        }

        alexa.init({
            cookie: saved || undefined,
            formerRegistrationData: saved || undefined,
            proxyOnly: true,
            proxyOwnIp: PROXY_IP,
            proxyPort: PROXY_PORT,
            proxyLogLevel: 'warn',
            amazonPage: 'amazon.fr',
            alexaServiceHost: 'alexa.amazon.fr',
            acceptLanguage: 'fr-FR',
            useWsMqtt: false,
            cookieRefreshInterval: 4 * 24 * 60 * 60 * 1000,
            logger: log,
        }, (err) => {
            if (err) {
                // Pendant la premiere connexion, init renvoie une "erreur" tant que le proxy attend l'utilisateur
                if (/Please open|login to Amazon/i.test(String(err && err.message || err))) return;
                return reject(err);
            }
            try { alexa.stopProxyServer && alexa.stopProxyServer(); } catch (e) { /* deja arrete */ }
            resolve(alexa);
        });
    });
}

function devices(alexa) {
    return Object.values(alexa.serialNumbers).map(d => ({
        name: d.accountName,
        serial: d.serialNumber,
        family: d.deviceFamily,
        type: d.deviceType,
        online: d.online,
        members: (d.clusterMembers || []).map(s => (alexa.serialNumbers[s] || {}).accountName || s),
    }));
}

module.exports = { connect, devices, COOKIE_FILE };
