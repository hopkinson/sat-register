@echo off
chcp 65001 >nul
cd /d "%~dp0"
title SAT 考位智能调度中枢
echo ================================================
echo          ⚡ SAT 考位智能调度中枢 启动中...
echo ================================================
echo.
echo 正在启动本地服务...
node start-local.js
pause
