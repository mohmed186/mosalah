@echo off
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js غير مثبت. قم بتثبيت Node.js 22 أو أحدث ثم أعد المحاولة.
  pause
  exit /b 1
)
echo Starting Nest Marketplace...
echo Open http://localhost:3000 in your browser.
node server.js
pause
