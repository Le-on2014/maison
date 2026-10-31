# Fabrique sur une cle USB (ou un dossier) tout ce qu'il faut pour installer le dashboard "Maison" sur un autre PC
# Windows, en service invisible (voir usb\install-maison.ps1).
# Usage : .\prepare-usb.ps1 -Dest E:\Maison-USB [-Pin 160710]
# Contenu produit : Installer.cmd, Desinstaller.cmd, install-maison.ps1, pin.txt, LISEZMOI.txt,
#                   app\ (code + dependances), node\node.exe (Node portable), data\ (configuration : cles Hue, cookie Amazon, jetons teles)
# ATTENTION : data\ contient des secrets -> garder la cle pour soi.
param(
    [string]$Dest = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Maison-USB'),
    [string]$Pin = '160710',
    [string]$NodeMajor = '22'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if ($Pin -notmatch '^\d{4,6}$') { throw 'Le code PIN doit faire 4 a 6 chiffres.' }

Write-Host "== Dossier cible : $Dest" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Dest, "$Dest\app\alexa", "$Dest\app\dashboard", "$Dest\app\icon", "$Dest\node", "$Dest\data" | Out-Null

# ---- application (pas de secrets, pas de journaux, pas de donnees d'execution) ----
Write-Host "== Copie de l'application"
Copy-Item "$root\alexa\alexa-common.js", "$root\alexa\package.json", "$root\alexa\package-lock.json" "$Dest\app\alexa\" -Force
robocopy "$root\alexa\node_modules" "$Dest\app\alexa\node_modules" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
$skip = @('hue-config.json', 'alexa-cookie.json', 'tv-tokens.json', 'deauville-config.json', 'access.json', 'history.json', 'timers.json')
Get-ChildItem "$Dest\app\dashboard" -File | Remove-Item -Force
Get-ChildItem "$root\dashboard" -File | Where-Object { $_.Name -notin $skip -and $_.Extension -notin '.log', '.tmp' } | Copy-Item -Destination "$Dest\app\dashboard\" -Force
robocopy "$root\icon" "$Dest\app\icon" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null

# ---- configuration (secrets) ----
Write-Host "== Configuration"
$files = @{
    'hue-config.json'        = "$root\hue-config.json"
    'alexa-cookie.json'      = "$root\alexa\alexa-cookie.json"
    'tv-tokens.json'         = "$root\dashboard\tv-tokens.json"
    'deauville-config.json'  = "$root\dashboard\deauville-config.json"
}
foreach ($k in $files.Keys) {
    if (Test-Path $files[$k]) { Copy-Item $files[$k] "$Dest\data\$k" -Force; Write-Host "   $k" }
    else { Write-Host "   $k : absent (ignore)" -ForegroundColor Yellow }
}
Set-Content "$Dest\pin.txt" -Value $Pin -Encoding ASCII

# ---- Node portable (node.exe seul, ~80 Mo) ----
Write-Host "== Node portable v$NodeMajor"
$nodeExe = "$Dest\node\node.exe"
if (-not (Test-Path $nodeExe)) {
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -TimeoutSec 30
    $ver = ($index | Where-Object { $_.version -like "v$NodeMajor.*" } | Select-Object -First 1).version
    if (-not $ver) { throw "Aucune version Node v$NodeMajor trouvee sur nodejs.org" }
    $zip = Join-Path $env:TEMP "node-$ver-win-x64.zip"
    Write-Host "   telechargement de $ver..."
    Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip -TimeoutSec 600
    $tmp = Join-Path $env:TEMP "node-$ver-extract"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip -DestinationPath $tmp
    Copy-Item (Get-ChildItem $tmp -Recurse -Filter node.exe | Select-Object -First 1).FullName $nodeExe
    Remove-Item $tmp -Recurse -Force; Remove-Item $zip -Force
    Write-Host "   node.exe $ver copie"
} else { Write-Host "   deja present : " + (& $nodeExe -v) }

# ---- scripts d'installation ----
Copy-Item "$root\usb\install-maison.ps1", "$root\usb\Installer.cmd", "$root\usb\Desinstaller.cmd" $Dest -Force
@"
DASHBOARD MAISON - installation sur un autre PC Windows (service invisible)
==========================================================================
1. Brancher la cle sur le PC, ouvrir ce dossier.
2. Double-clic sur Installer.cmd -> accepter la demande "administrateur" (une seule fois).
   Une fenetre s'affiche pendant l'installation (environ 30 s) puis se ferme : c'est la seule fois.
3. A la fin, l'adresse a utiliser depuis les telephones est affichee et ecrite dans ADRESSE-PARIS.txt.
   Code d'acces (demande une fois par appareil) : $Pin

Ce qui est installe : C:\ProgramData\Maison (application + Node portable + configuration),
une tache planifiee "Maison" (demarre avec Windows, compte SYSTEM : aucune fenetre, meme si personne
n'est connecte), une regle de pare-feu (ports 8090/8091/3001 en local), et la mise en veille est
desactivee quand le PC est branche (sinon le site s'arrete avec lui). L'ecran s'eteint normalement.

Pour tout enlever : Desinstaller.cmd.
Journal : C:\ProgramData\Maison\logs\maison.log
"@ | Set-Content "$Dest\LISEZMOI.txt" -Encoding UTF8

$size = [math]::Round((Get-ChildItem $Dest -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host ""
Write-Host "OK : $Dest pret ($size Mo). Copier ce dossier sur la cle USB, puis sur l'autre PC : Installer.cmd" -ForegroundColor Green

exit 0
