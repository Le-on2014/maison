# Lance le menu Hue. Double-clic sur Hue.cmd, ou dans PowerShell : .\Hue.ps1
Import-Module (Join-Path $PSScriptRoot 'HueControl.psm1') -Force
Show-HueMenu
