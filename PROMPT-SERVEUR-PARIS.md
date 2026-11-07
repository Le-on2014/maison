# Prompt à donner à l'assistant du serveur de Paris

Copie tout ce qui est entre les deux lignes `====` et colle-le à l'assistant qui tourne sur le serveur.
Les secrets (clés, cookie Amazon, code PIN) ne sont **pas** dans ce prompt : tu les copies à part (étape « Fichiers secrets »).

====

Bonjour. Tu tournes sur un serveur du réseau Wi-Fi de notre maison à Paris (réseau 192.168.1.x, box Livebox en 192.168.1.1).
Je veux que tu installes et fasses tourner **24 h/24** notre tableau de bord domotique « Maison » sur ce serveur.

## Ce qu'est l'application
- Code public : https://github.com/Le-on2014/maison (Node.js, dossiers `dashboard/` et `alexa/`).
- Image Docker déjà construite : `leonleonbj/maison:latest` (Docker Hub, amd64 et arm/v7).
- Elle pilote : le pont Philips Hue (192.168.1.61), les télés Samsung (salon 192.168.1.15, grande 192.168.1.10), les Echo Alexa (par Internet), la météo.
- Ports :
  - 8090 : le tableau de bord, protégé par un code PIN sur le réseau ;
  - 8091 : l'écran d'accueil des télés (`/accueil`) et les messages affichés sur les télés ;
  - 3001 : proxy de connexion Amazon, utilisé seulement pour reconnecter Alexa.

## Ce que je te demande
1. Regarde ce qu'est cette machine (système, Docker installé ou non, adresse IP sur 192.168.1.x) et dis-le-moi avant de changer quoi que ce soit.
2. Installe l'application de la façon la plus simple pour ce système :
   - **si Docker est disponible** : conteneur `leonleonbj/maison:latest`, réseau `host`, redémarrage `unless-stopped`, un volume persistant monté sur `/data` ;
   - **sinon** : Node.js 22, clone du dépôt, `npm install` dans `alexa/`, lancement de `node dashboard/server.js` comme service qui redémarre tout seul (systemd sous Linux, tâche planifiée au démarrage sous Windows).
3. Variables d'environnement :
   - `MAISON_DATA=/data` (ou le dossier de données choisi) ;
   - `MAISON_LAN_IP=<l'adresse IP de ce serveur>` ;
   - `MAISON_PIN=<le code que je te donnerai>` ;
   - `TZ=Europe/Paris`.
4. Fichiers secrets : je vais te donner 4 fichiers à placer dans le dossier de données :
   `hue-config.json`, `alexa-cookie.json`, `tv-tokens.json`, `deauville-config.json`.
   Ne les affiche jamais en entier, ne les envoie nulle part, ne les mets pas dans git.
5. Ouvre les ports 8090, 8091 et 3001 **seulement pour le réseau local** (192.168.1.0/24), pas vers Internet.
6. Empêche la machine de se mettre en veille.
7. Vérifie :
   - `http://<IP>:8090` répond (page du tableau de bord) ;
   - `http://<IP>:8091/accueil.json` renvoie la météo et des pièces Hue (`"hueError": false`) ;
   - les journaux affichent « Alexa connectee » ;
   - après un redémarrage de la machine, tout repart tout seul.
8. Donne-moi à la fin : l'adresse du tableau de bord, comment voir les journaux, comment mettre à jour l'application et comment tout arrêter ou désinstaller.

## Règles
- Ne touche à rien d'autre sur cette machine sans me demander (autres services, autres comptes, pare-feu au-delà des 3 ports).
- Si quelque chose bloque, arrête-toi et explique-moi en français simple ce qu'il faut faire.

====

## Fichiers secrets (à faire toi-même)
Sur le PC, les 4 fichiers sont dans `Desktop\Maison-USB\data\`. Copie-les sur le serveur (clé USB ou dossier partagé), là où l'assistant te le dira.
Le code PIN du tableau de bord est dans `Desktop\Maison-USB\pin.txt` : donne-le à l'assistant seulement quand il te le demande.
