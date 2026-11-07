// Prepare l'appli Tizen "Maison" (ecran d'accueil des profils) dans tv-app/src :
// index.html genere depuis dashboard/tvhome.js (meme ecran que http://<serveur>:8091/accueil),
// config.xml, icone et avatars. Ensuite : tizen package -t wgt -s <profil de certificat> -- src
const fs = require('fs');
const path = require('path');
const tvhome = require('../dashboard/tvhome');

const root = path.join(__dirname, '..');
const src = path.join(__dirname, 'src');
const hueCfg = JSON.parse(fs.readFileSync(path.join(root, 'hue-config.json'), 'utf8').replace(/^﻿/, ''));

fs.mkdirSync(path.join(src, 'avatars'), { recursive: true });
fs.writeFileSync(path.join(src, 'index.html'), tvhome.appPage({ ip: hueCfg.BridgeIP, user: hueCfg.Username }));
for (const f of fs.readdirSync(path.join(root, 'dashboard', 'avatars'))) {
    fs.copyFileSync(path.join(root, 'dashboard', 'avatars', f), path.join(src, 'avatars', f));
}
fs.copyFileSync(path.join(root, 'icon', 'icon-512.png'), path.join(src, 'icon.png'));
fs.writeFileSync(path.join(src, 'config.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="http://maison.local/accueil" version="1.0.0" viewmodes="maximized">
    <tizen:application id="MaisonAcc1.Maison" package="MaisonAcc1" required_version="6.0"/>
    <content src="index.html"/>
    <feature name="http://tizen.org/feature/screen.size.normal.1080.1920"/>
    <icon src="icon.png"/>
    <name>Maison</name>
    <access origin="*" subdomains="true"/>
    <tizen:allow-navigation>*</tizen:allow-navigation>
    <tizen:content-security-policy>default-src * 'unsafe-inline' data:; script-src 'self' 'unsafe-inline'; img-src * data:</tizen:content-security-policy>
    <tizen:privilege name="http://tizen.org/privilege/internet"/>
    <tizen:privilege name="http://tizen.org/privilege/application.launch"/>
    <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>
    <tizen:profile name="tv-samsung"/>
    <tizen:setting screen-orientation="landscape" context-menu="disable" background-support="disable" encryption="disable" install-location="auto" hwkey-event="enable"/>
</widget>
`);
console.log('Appli prete dans', src);
