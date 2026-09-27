@echo off
chcp 65001 >nul
rem DSH 盘后日更启动器（由计划任务调用）
cd /d "C:\Users\12452\Desktop\deepseek"
set NODE="C:\Program Files\nodejs\node.exe"
echo. >> "daily-update.log"
echo ===== %date% %time% ===== >> "daily-update.log"
%NODE% daily-update.mjs >> "daily-update.log" 2>&1
exit /b %ERRORLEVEL%
