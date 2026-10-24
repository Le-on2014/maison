# Déployer le dashboard « Maison » sur le Sonoff iHost

Le dashboard (Hue + Alexa + télés) tourne aujourd'hui sur ce PC. Ce guide le fait tourner **en permanence sur l'iHost**
(`http://192.168.1.91`) dans un conteneur Docker, construit automatiquement par GitHub et publié sur GHCR.

Principe : le **code** va dans un dépôt GitHub (privé, c'est très bien) → GitHub Actions construit l'image pour
armv7 (iHost) et la publie dans `ghcr.io/le-on2014/maison:latest` (**l'image doit être publique**, l'iHost ne sait pas
s'authentifier) → l'iHost tire l'image. **Aucun secret n'est dans l'image** : les clés Hue, le cookie Amazon, les jetons
des télés arrivent par variables d'environnement saisies dans l'iHost, et sont écrits une fois pour toutes dans le
volume `/data` au premier démarrage.

---

## 1. Créer le dépôt GitHub et pousser le code (sur ce PC)

1. Dans PowerShell, dans `C:\Users\leon0\OneDrive\Desktop\HueControl` :
   ```powershell
   .\git-init.ps1
   ```
   Le script crée `.gitignore` (exclut `hue-config.json`, `alexa-cookie.json`, `tv-tokens.json`, `deauville-config.json`,
   `node_modules`, sauvegardes…), initialise git, vérifie qu'aucun secret n'est suivi, puis fait le premier commit.
   S'il réclame une identité git : `git config --global user.name "…"` et `git config --global user.email "…"`, puis relance.
2. Va sur <https://github.com/new> : nom `maison`, **Private** (OK), ne coche ni README ni .gitignore → *Create repository*.
3. De retour dans PowerShell :
   ```powershell
   git remote add origin https://github.com/Le-on2014/maison.git
   git push -u origin main
   ```
   (La première fois, une fenêtre de connexion GitHub s'ouvre dans le navigateur.)

## 2. Attendre l'Action, puis rendre l'image publique

1. Sur GitHub → onglet **Actions** → « Build & push image maison » : ~5 à 10 minutes la première fois (émulation ARM).
2. Quand c'est vert : ta page de profil → **Packages** → `maison` → **Package settings** (à droite) →
   *Danger Zone* → **Change visibility** → **Public** → confirmer en tapant `maison`.
   À ne faire qu'une fois. L'image ne contient aucun secret (voir `.dockerignore`), elle peut être publique sans risque.
3. Conseillé : dans *Package settings* → *Manage Actions access*, laisser le dépôt `maison` en *Write* (c'est le défaut)
   pour que chaque `git push` mette l'image à jour.

## 3. Préparer les variables d'environnement (sur ce PC)

```powershell
.\prepare-env.ps1
```
Le script affiche à l'écran (il n'écrit rien) les valeurs à coller dans l'iHost. Pour copier une valeur directement :
```powershell
.\prepare-env.ps1 -Only ALEXA_COOKIE | Set-Clipboard
```
Variables :

| Variable | Valeur | Rôle |
|---|---|---|
| `HUE_CONFIG` | contenu de `hue-config.json` sur une ligne | pont Hue (IP + clé) |
| `ALEXA_COOKIE` | base64 (gzip) de `alexa\alexa-cookie.json` | connexion Amazon/Alexa |
| `TV_TOKENS` | contenu de `dashboard\tv-tokens.json` | appairage des télés Samsung |
| `DEAUVILLE_CONFIG` | contenu de `dashboard\deauville-config.json` | clé PSK de la Sony |
| `MAISON_PIN` | 4 à 6 chiffres | code demandé aux téléphones/tablettes (obligatoire : sans lui, l'accès réseau est refusé) |
| `MAISON_LAN_IP` | `192.168.1.91` | IP que les télés ouvrent pour afficher un texte (port 8091) |
| `ALEXA_PROXY_IP` | `192.168.1.91` | IP affichée pour la page de reconnexion Amazon (port 3001) si le cookie expire |
| `TZ` | `Europe/Paris` | heure locale dans les journaux |

À la main, l'équivalent PowerShell :
```powershell
# JSON sur une ligne
(Get-Content .\hue-config.json -Raw -Encoding UTF8 | ConvertFrom-Json) | ConvertTo-Json -Compress
# base64 simple d'un fichier (accepté aussi, sans gzip)
[Convert]::ToBase64String([IO.File]::ReadAllBytes('.\alexa\alexa-cookie.json'))
```

Ces variables ne servent **qu'au premier démarrage** : ensuite les fichiers vivent dans le volume `/data` et sont mis à jour
par le serveur (cookie Amazon rafraîchi, jeton d'une nouvelle télé…). Pour forcer une nouvelle valeur plus tard :
supprimer le volume (ou le fichier concerné) et redémarrer le conteneur.

## 4. Créer le conteneur sur l'iHost

1. Navigateur → `http://192.168.1.91` → **Docker** → **Ajouter** (icône +) → *Installer depuis une image / Pull*.
2. **Image** : `ghcr.io/le-on2014/maison:latest` → Télécharger (l'iHost détecte l'architecture arm/v7 tout seul).
3. **Créer le conteneur** avec :
   - **Nom** : `maison`
   - **Réseau** : **host** si l'option est proposée (recommandé : les télés voient directement les ports 8090/8091, et
     Wake-on-LAN de la Samsung 43" fonctionne). Sinon, mode *bridge* avec les ports :
     `8090 → 8090` (dashboard), `8091 → 8091` (texte sur les télés), `3001 → 3001` (reconnexion Amazon, optionnel).
   - **Volume** : volume nommé `maison-data` monté sur `/data` dans le conteneur.
   - **Variables d'environnement** : celles de l'étape 3, une par une (nom = valeur, sans guillemets).
   - **Redémarrage** : *always* / *unless-stopped*.
4. Démarrer. Dans les journaux du conteneur, on doit voir :
   `[config] hue-config.json cree depuis HUE_CONFIG dans /data`, `… alexa-cookie.json …`, puis
   `Dashboard : http://localhost:8090` et `Alexa connectee.`
5. Test : `http://192.168.1.91:8090` depuis un téléphone → écran « code » → `MAISON_PIN` → dashboard.
   Depuis l'iHost lui-même (127.0.0.1) aucun code n'est demandé.

## 5. Après la bascule

- **Raccourcis « Maison »** (téléphones, tablettes, PC, icône sur l'écran d'accueil) : les faire pointer sur
  `http://192.168.1.91:8090` à la place de `http://localhost:8090`. Sur le PC, `Dashboard.vbs` peut rester pour un
  usage local, mais il n'est plus nécessaire : l'iHost tourne 24h/24.
- Le code PIN n'est demandé qu'une fois par appareil (cookie valable 1 an). 5 codes faux → appareil bloqué 10 min.
- **Nanoleaf (Deauville) : ne fonctionnera pas depuis l'iHost.** Les ampoules sont pilotées en Bluetooth par le PC
  (script Python dans `Deauville\`) ; l'iHost n'a pas de Bluetooth exploitable par le conteneur. Les ampoules
  apparaîtront « hors de portée ». Tout le reste (Hue, Alexa, télés Samsung/Sony, Xbox, ambiances, météo, minuteurs,
  historique) fonctionne.
- **Message texte sur les télés** : la télé ouvre `http://192.168.1.91:8091/msg`, d'où `MAISON_LAN_IP`.
- **Cookie Amazon expiré** (après plusieurs semaines sans connexion) : le journal affiche « Ouvre http://… :3001 ».
  Ouvrir `http://192.168.1.91:3001` depuis le réseau local, se connecter à Amazon : le nouveau cookie est écrit dans `/data`.
  (Nécessite le port 3001 ouvert, donc *host* ou le mapping 3001.)
- **Mettre à jour** : modifier le code sur le PC → `git add -A ; git commit -m "…" ; git push` → attendre l'Action →
  sur l'iHost, Docker → conteneur `maison` → *Mettre à jour l'image* / recréer avec la même image et le même volume.
  Les données (`/data`) sont conservées.
- **Tester l'image sur un PC avec Docker** (l'image est aussi amd64) :
  `docker run --rm -p 8090:8090 -p 8091:8091 -v maison-data:/data -e MAISON_PIN=1234 -e HUE_CONFIG='{…}' ghcr.io/le-on2014/maison:latest`

## Dépannage

| Symptôme | Cause / remède |
|---|---|
| `hue-config.json introuvable dans /data (ou variable HUE_CONFIG)` au démarrage | variable absente ou mal collée (il faut le JSON entier, `{…}`) |
| `[config] ALEXA_COOKIE ignore : ni JSON ni base64 de JSON` | valeur tronquée au collage : réessayer avec `-Only ALEXA_COOKIE \| Set-Clipboard` |
| 403 `pin-not-set` depuis un téléphone | `MAISON_PIN` absent ou pas 4–6 chiffres |
| « manifest unknown » au téléchargement sur l'iHost | paquet encore privé (étape 2) ou Action pas terminée |
| Les télés n'affichent pas le texte | `MAISON_LAN_IP` manquant ou port 8091 non exposé (préférer le réseau *host*) |
| Alexa « pas encore connectée » en boucle | pas d'Internet sur l'iHost, ou cookie expiré → port 3001 |
