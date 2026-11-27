@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 필요해요. 아래 명령을 실행한 뒤 터미널을 새로 열고 다시 실행해 주세요.
  echo   winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
node setup.mjs
pause
