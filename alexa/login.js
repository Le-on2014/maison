// Premiere connexion a Amazon puis liste des appareils et groupes Alexa.
const { connect, devices } = require('./alexa-common');

connect(msg => { if (/error|erreur|Proxy/i.test(msg)) console.log(msg); })
    .then(alexa => {
        console.log('\nConnecte. Appareils Alexa :');
        for (const d of devices(alexa)) {
            console.log(`  - ${d.name} | ${d.family} | ${d.online ? 'en ligne' : 'hors ligne'}${d.members.length ? ' | membres : ' + d.members.join(', ') : ''}`);
        }
        alexa.getSmarthomeGroups && alexa.getSmarthomeGroups((err, res) => {
            if (!err && res) {
                const groups = (res.applianceGroups || res.groups || []);
                if (groups.length) console.log('\nGroupes (pieces) :');
                groups.forEach(g => console.log(`  - ${g.name} | ${(g.applianceIds || []).length} appareils`));
            }
            process.exit(0);
        }) || process.exit(0);
    })
    .catch(err => { console.error('Echec :', err.message || err); process.exit(1); });
