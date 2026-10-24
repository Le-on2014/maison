# Initialise le depot git de HueControl (une seule fois), avec un .gitignore qui exclut tous les secrets,
# fait le premier commit, puis affiche les 2 commandes a lancer apres avoir cree le depot sur GitHub.
# Ne pousse rien et ne cree aucun depot distant.
[CmdletBinding()]
param(
    [string] $GitHubUser = 'Le-on2014',
    [string] $Repo = 'maison'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git introuvable : installe Git for Windows (https://git-scm.com).' }

# --- .gitignore (memes exclusions que .dockerignore, cote code source) ---
$gitignore = @'
# Secrets : ne JAMAIS commiter
hue-config.json
**/hue-config.json
**/alexa-cookie.json
**/tv-tokens.json
**/deauville-config.json
**/access.json
backup-*.json
**/backup-*.json
nanoleaf*
**/nanoleaf*

# Donnees d'execution
**/history.json
**/timers.json
**/*.log

# Dependances / environnements
**/node_modules/
**/venv/
**/.venv/
**/__pycache__/
Deauville/

# Windows / editeurs
Thumbs.db
desktop.ini
.vscode/
'@
$gi = Join-Path $root '.gitignore'
if (-not (Test-Path $gi)) {
    [IO.File]::WriteAllText($gi, $gitignore, (New-Object Text.UTF8Encoding($false)))
    Write-Host '.gitignore cree.' -ForegroundColor Green
} else {
    Write-Host '.gitignore deja present, conserve.' -ForegroundColor DarkGray
}

# --- init ---
if (-not (Test-Path (Join-Path $root '.git'))) {
    git init -b main | Out-Null
    if (-not $?) { git init | Out-Null; git checkout -b main | Out-Null }
    Write-Host 'Depot git initialise (branche main).' -ForegroundColor Green
} else {
    Write-Host 'Depot git deja initialise.' -ForegroundColor DarkGray
}

# Identite git (necessaire pour commiter) : on propose, on n'impose rien
$name = git config user.name
$mail = git config user.email
if (-not $name -or -not $mail) {
    Write-Host 'Identite git absente. Lance d''abord :' -ForegroundColor Yellow
    Write-Host '   git config --global user.name  "Ton Nom"'
    Write-Host '   git config --global user.email "ton@email"'
    Write-Host 'puis relance ce script.'
    exit 1
}

git add -A

# Garde-fou : aucun fichier secret ne doit etre suivi
$staged = git diff --cached --name-only
$leak = $staged | Where-Object { $_ -match 'hue-config\.json|alexa-cookie\.json|tv-tokens\.json|deauville-config\.json|access\.json|backup-.*\.json|nanoleaf' }
if ($leak) {
    git reset | Out-Null
    Write-Host 'STOP : des fichiers secrets seraient commites :' -ForegroundColor Red
    $leak | ForEach-Object { Write-Host "   $_" -ForegroundColor Red }
    Write-Host 'Verifie .gitignore puis relance.' -ForegroundColor Red
    exit 1
}

$pending = git status --porcelain
if ($pending) {
    git commit -q -m 'Dashboard Maison : image Docker pour Sonoff iHost (Dockerfile, workflow GHCR, config/auth)'
    Write-Host 'Commit effectue.' -ForegroundColor Green
} else {
    Write-Host 'Rien a commiter.' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host "Fichiers suivis : $(( git ls-files | Measure-Object ).Count)" -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Etape suivante : cree le depot sur https://github.com/new' -ForegroundColor Cyan
Write-Host "   nom : $Repo   (prive OK ; ne coche ni README ni .gitignore)" -ForegroundColor Cyan
Write-Host 'puis lance ces 2 commandes dans ce dossier :' -ForegroundColor Cyan
Write-Host ''
Write-Host "   git remote add origin https://github.com/$GitHubUser/$Repo.git" -ForegroundColor White
Write-Host '   git push -u origin main' -ForegroundColor White
Write-Host ''
Write-Host '(GitHub demandera de te connecter dans le navigateur la 1re fois : Git Credential Manager.)' -ForegroundColor DarkGray
Write-Host 'L''Action "Build & push image maison" demarre toute seule apres le push (onglet Actions).' -ForegroundColor DarkGray
