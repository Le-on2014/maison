@echo off
rem Installe le dashboard Maison sur ce PC (service invisible). Demande l'autorisation administrateur une fois.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-maison.ps1"
