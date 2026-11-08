@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请使用项目已有的 Node.js 22.12 或更新版本。
  pause
  exit /b 1
)
echo 萌宠乱斗：请在浏览器打开 http://127.0.0.1:43926
echo 保留此窗口运行游戏，按 Ctrl+C 停止。不需要 FastAPI、Docker 或账号。仅供本机测试。
node "%~dp0server.mjs" 43926
if errorlevel 1 pause
endlocal
