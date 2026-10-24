@echo off
title Dashboard Maison
cd /d "%~dp0dashboard"
start "" http://localhost:8090
node --no-deprecation server.js
