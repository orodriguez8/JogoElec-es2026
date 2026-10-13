@echo off
chcp 65001 >nul
title PSOE Strikes Back - servidor para el movil
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Para jugar desde el movil necesitas Node.js.
  echo   Descargalo gratis desde https://nodejs.org e instalalo.
  echo.
  pause
  exit /b
)
node servidor-movil.js
pause
