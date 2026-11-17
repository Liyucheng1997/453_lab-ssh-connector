@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo 没有找到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo 首次运行，正在安装依赖……
  call npm install --omit=dev || (pause & exit /b 1)
)
start "" http://127.0.0.1:8822
node server/index.js
pause
