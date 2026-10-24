# Fait pointer les raccourcis "Maison" (Bureau, menu Demarrer) vers le dashboard qui tourne sur l'iHost.
# Usage : powershell -ExecutionPolicy Bypass -File shortcuts-ihost.ps1 [-Url http://192.168.1.91:8090]
param([string]$Url = 'http://192.168.1.91:8090')

$ico = Join-Path $PSScriptRoot 'icon\Maison.ico'
$edge = @("$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$sh = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $lnk = Join-Path $dir 'Maison.lnk'
    $s = $sh.CreateShortcut($lnk)
    if ($edge) { $s.TargetPath = $edge; $s.Arguments = "--app=$Url" } else { $s.TargetPath = $Url; $s.Arguments = '' }
    $s.IconLocation = "$ico,0"
    $s.Description = "Dashboard Maison (sur l'iHost)"
    $s.Save()
    Write-Host "OK : $lnk -> $Url"
}
Write-Host "Pour l'epingler : clic droit sur la fenetre Maison -> Epingler a la barre des taches."
