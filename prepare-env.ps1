# Affiche (dans la console UNIQUEMENT, rien n'est ecrit sur disque) les variables d'environnement a coller
# dans l'interface Docker de l'iHost, a partir des fichiers secrets locaux de HueControl.
#
#   .\prepare-env.ps1              -> toutes les variables
#   .\prepare-env.ps1 -Pin 123456  -> impose le code PIN (sinon un code a 6 chiffres est tire au hasard)
#   .\prepare-env.ps1 -Only ALEXA_COOKIE
#
# Ne colle jamais ces valeurs ailleurs que dans l'iHost (ce sont tes secrets Hue / Amazon / teles).
[CmdletBinding()]
param(
    [ValidatePattern('^\d{4,6}$')] [string] $Pin,
    [string] $Only,
    [string] $IHostIp = '192.168.1.91'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Read-JsonText([string] $path) {
    # Lit un JSON (avec ou sans BOM) et le renvoie compacte sur une ligne
    $raw = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
    $raw = $raw.TrimStart([char]0xFEFF)
    $obj = $raw | ConvertFrom-Json
    return ($obj | ConvertTo-Json -Compress -Depth 50)
}

function To-Base64Gzip([string] $text) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $ms = New-Object IO.MemoryStream
    $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress)
    $gz.Write($bytes, 0, $bytes.Length)
    $gz.Close()
    return [Convert]::ToBase64String($ms.ToArray())
}

$vars = New-Object System.Collections.Specialized.OrderedDictionary
$missing = @()

# --- HUE_CONFIG : JSON compact d'une ligne ---
$p = Join-Path $root 'hue-config.json'
if (Test-Path $p) { $vars['HUE_CONFIG'] = Read-JsonText $p } else { $missing += 'hue-config.json' }

# --- ALEXA_COOKIE : base64 du JSON gzippe (le fichier est gros, ~8 Ko -> ~3 Ko) ---
$p = Join-Path $root 'alexa\alexa-cookie.json'
if (Test-Path $p) { $vars['ALEXA_COOKIE'] = To-Base64Gzip (Read-JsonText $p) } else { $missing += 'alexa\alexa-cookie.json' }

# --- TV_TOKENS ---
$p = Join-Path $root 'dashboard\tv-tokens.json'
if (Test-Path $p) { $vars['TV_TOKENS'] = Read-JsonText $p } else { $vars['TV_TOKENS'] = '{}' }

# --- DEAUVILLE_CONFIG (cle PSK Sony) ---
$p = Join-Path $root 'dashboard\deauville-config.json'
if (Test-Path $p) { $vars['DEAUVILLE_CONFIG'] = Read-JsonText $p } else { $vars['DEAUVILLE_CONFIG'] = '{"sonyPsk":""}' }

# --- Reglages serveur ---
if (-not $Pin) { $Pin = -join (1..6 | ForEach-Object { Get-Random -Minimum 0 -Maximum 10 }) }
$vars['MAISON_PIN'] = $Pin
$vars['MAISON_LAN_IP'] = $IHostIp
$vars['ALEXA_PROXY_IP'] = $IHostIp
$vars['TZ'] = 'Europe/Paris'

# --- Affichage ---
Write-Host ''
Write-Host 'Variables d''environnement a creer dans l''iHost (Docker -> Ajouter -> Variables d''environnement).' -ForegroundColor Cyan
Write-Host 'Pour chaque ligne : NOM = valeur (copie la valeur telle quelle, sans guillemets autour).' -ForegroundColor Cyan
Write-Host ''
foreach ($k in $vars.Keys) {
    if ($Only -and $k -ne $Only) { continue }
    Write-Host ('=' * 78) -ForegroundColor DarkGray
    Write-Host "$k" -ForegroundColor Yellow
    Write-Host ('-' * 78) -ForegroundColor DarkGray
    Write-Output $vars[$k]
}
Write-Host ('=' * 78) -ForegroundColor DarkGray
if ($missing.Count) {
    Write-Host ''
    Write-Host ("Fichiers introuvables (variable non produite) : " + ($missing -join ', ')) -ForegroundColor Red
}
Write-Host ''
Write-Host "Code PIN du dashboard : $Pin  (variable MAISON_PIN ; note-le, il sera demande sur les telephones)" -ForegroundColor Green
Write-Host 'Astuce : .\prepare-env.ps1 -Only ALEXA_COOKIE | Set-Clipboard   copie une seule valeur dans le presse-papiers.' -ForegroundColor DarkGray
