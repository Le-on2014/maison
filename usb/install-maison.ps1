# Installe le dashboard "Maison" sur CE PC, en service invisible :
#   - copie l'application + Node portable + la configuration dans C:\ProgramData\Maison
#   - tache planifiee "Maison" : demarre avec Windows (compte SYSTEM, avant toute ouverture de session),
#     AUCUNE fenetre, redemarre toute seule si elle plante
#   - regle de pare-feu pour que les telephones du reseau puissent ouvrir http://<ce-pc>:8090
#   - (option) empeche la mise en veille quand le PC est branche, sinon le site s'arrete avec le PC
# Usage : double-clic sur Installer.cmd (demande l'elevation une fois). Desinstallation : Desinstaller.cmd.
param(
    [string]$Pin = '',
    [switch]$NoSleepChange,     # ne touche pas aux reglages de veille
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:ProgramData 'Maison'
$taskName = 'Maison'

# ---- elevation (une seule fois) ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"")
    if ($Pin) { $args += @('-Pin', $Pin) }
    if ($NoSleepChange) { $args += '-NoSleepChange' }
    if ($Uninstall) { $args += '-Uninstall' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $args -Wait
    exit
}

function Say($t) { Write-Host "  $t" }
function Title($t) { Write-Host ""; Write-Host "== $t ==" -ForegroundColor Cyan }

# ---- desinstallation ----
if ($Uninstall) {
    Title "Desinstallation"
    cmd /c "schtasks /End /TN $taskName >nul 2>&1"
    cmd /c "schtasks /Delete /TN $taskName /F >nul 2>&1"
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dest\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-NetFirewallRule -DisplayName 'Maison*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Say "Tache, pare-feu et dossier $dest supprimes."
    Write-Host ""; Read-Host "Termine. Appuie sur Entree"
    exit
}

Title "Installation du dashboard Maison"
if (-not (Test-Path "$here\node\node.exe")) { throw "node\node.exe introuvable sur la cle (relance prepare-usb.ps1 sur le PC source)." }
if (-not (Test-Path "$here\app\dashboard\server.js")) { throw "app\dashboard\server.js introuvable sur la cle." }
if (-not $Pin) { $Pin = (Get-Content "$here\pin.txt" -ErrorAction SilentlyContinue | Select-Object -First 1) }
if ($Pin -notmatch '^\d{4,6}$') { throw "Code PIN absent ou invalide (pin.txt sur la cle, ou -Pin 123456)." }

# ---- arret d'une version precedente ----
cmd /c "schtasks /End /TN $taskName >nul 2>&1"
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dest\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1

# ---- copie ----
Title "Copie dans $dest"
New-Item -ItemType Directory -Force -Path $dest, "$dest\logs", "$dest\data" | Out-Null
robocopy "$here\app" "$dest\app" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy "$here\node" "$dest\node" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
# donnees : on ne remplace PAS un fichier deja present (cookie Amazon rafraichi, jetons de tele appris...)
Get-ChildItem "$here\data" -Filter *.json | ForEach-Object {
    if (-not (Test-Path "$dest\data\$($_.Name)")) { Copy-Item $_.FullName "$dest\data\$($_.Name)" }
}
Say "application, Node portable et configuration copies."

# ---- lanceur (variables d'environnement) ----
$pinFile = "$dest\pin.txt"
Set-Content -Path $pinFile -Value $Pin -Encoding ASCII
$run = @"
@echo off
rem Lanceur du dashboard Maison (execute par la tache planifiee, compte SYSTEM, invisible)
cd /d "%~dp0app\dashboard"
set MAISON_DATA=%~dp0data
set MAISON_BIND=0.0.0.0
set TZ=Europe/Paris
set /p MAISON_PIN=<"%~dp0pin.txt"
set NODE_ENV=production
"%~dp0node\node.exe" --no-deprecation server.js >> "%~dp0logs\maison.log" 2>&1
"@
Set-Content -Path "$dest\run.cmd" -Value $run -Encoding ASCII

# rotation simple du journal (> 5 Mo -> on repart de zero)
$log = "$dest\logs\maison.log"
if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Remove-Item $log -Force }

# ---- pare-feu ----
Title "Pare-feu"
Get-NetFirewallRule -DisplayName 'Maison*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Maison (dashboard)' -Direction Inbound -Program "$dest\node\node.exe" -Action Allow -Profile Private,Domain,Public | Out-Null
New-NetFirewallRule -DisplayName 'Maison (ports)' -Direction Inbound -Protocol TCP -LocalPort 8090,8091,3001 -Action Allow -Profile Private,Domain,Public | Out-Null
Say "ports 8090 (site), 8091 (texte tele), 3001 (reconnexion Amazon) ouverts sur le reseau local."
# le reseau Wi-Fi doit etre "prive" sinon Windows bloque quand meme la decouverte ; on force pour les profils connectes
Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' } | ForEach-Object {
    try { Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private; Say "reseau '$($_.Name)' passe en Prive." } catch {}
}

# ---- tache planifiee : SYSTEM, au demarrage, invisible, relance auto, sans limite de duree ----
Title "Tache planifiee '$taskName'"
cmd /c "schtasks /Delete /TN $taskName /F >nul 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$dest\run.cmd`"" -WorkingDirectory $dest
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Dashboard Maison (Hue / Alexa / teles). Invisible, demarre avec Windows." -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Say "creee et demarree (compte SYSTEM : aucune fenetre, quel que soit l'utilisateur connecte)."

# ---- veille ----
if (-not $NoSleepChange) {
    Title "Veille"
    powercfg /change standby-timeout-ac 0 | Out-Null
    powercfg /change hibernate-timeout-ac 0 | Out-Null
    Say "plus de mise en veille quand le PC est branche (l'ecran s'eteint toujours normalement)."
}

# ---- verification ----
Title "Verification"
$ok = $false
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
    Start-Sleep 2
    try { $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8090/api/login-required' -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ok = $true } } catch {}
}
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } | Select-Object -First 1).IPAddress
$name = $env:COMPUTERNAME.ToLower()
if ($ok) {
    Write-Host ""
    Write-Host "  OK : le dashboard tourne, invisible." -ForegroundColor Green
    Write-Host "  Depuis un telephone / tablette du Wi-Fi :" -ForegroundColor Green
    Write-Host "      http://$ip`:8090        (ou http://$name.local:8090)" -ForegroundColor Yellow
    Write-Host "  Code demande une fois par appareil : $Pin"
    Set-Content -Path "$here\ADRESSE-PARIS.txt" -Value "Dashboard Maison (PC $env:COMPUTERNAME) :`r`nhttp://$ip`:8090`r`nhttp://$name.local:8090`r`nCode : $Pin`r`n" -ErrorAction SilentlyContinue
} else {
    Write-Host "  Le serveur ne repond pas encore. Journal : $log" -ForegroundColor Red
    if (Test-Path $log) { Get-Content $log -Tail 20 }
}
Write-Host ""
Read-Host "Appuie sur Entree pour fermer"
