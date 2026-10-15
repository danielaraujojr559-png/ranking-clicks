@echo off
title Servidor de Ranking - Por que Voce Nao Para de Clicar um Pouco
cd /d "%~dp0"
echo ============================================================
echo  Iniciando Servidor de Ranking (Node.js + SQLite)
echo ============================================================
echo.
node server.js
if errorlevel 1 (
    echo.
    echo [ERRO] Falha ao iniciar. Verifique se o Node.js esta instalado.
    pause
)
