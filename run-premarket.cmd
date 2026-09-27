@echo off
chcp 65001 >nul
rem DSH 盘前更新启动器（由计划任务在交易日 09:26 调用）
cd /d "C:\Users\12452\Desktop\deepseek"
set NODE="C:\Program Files\nodejs\node.exe"
echo. >> "premarket.log"
echo ===== %date% %time% ===== >> "premarket.log"
%NODE% premarket.mjs >> "premarket.log" 2>&1
exit /b %ERRORLEVEL%
