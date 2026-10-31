@echo off
rem Retire completement le dashboard Maison de ce PC (tache, pare-feu, dossier C:\ProgramData\Maison).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-maison.ps1" -Uninstall
