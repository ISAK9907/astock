@echo off
chcp 65001 >nul
rem ============================================================================
rem  DSH post-close daily update launcher (called by scheduled task, weekdays 15:40)
rem
rem  Retry added: all 11 steps depend on external data sources (eastmoney, tencent,
rem  ths, sina, baostock) and transient timeouts are common. The scheduled task
rem  fires only once a day, so without a retry a single hiccup wastes the whole day
rem  (the 15:50 cloud fallback can also cover it, but later and only if cloud works).
rem
rem  WARNING - this file must stay pure ASCII, and must NOT use ( ) blocks.
rem  Under chcp 65001, cmd.exe mis-parses UTF-8 multibyte text combined with
rem  parenthesised blocks: it slices a line at a byte boundary and tries to run the
rem  tail as a command (seen: "'0' is not recognized" / "The syntax of the command
rem  is incorrect" / "'...' is not recognized"). Chinese text is only safe inside
rem  node output, never in this script. Control flow uses if ... goto, never blocks.
rem ============================================================================
cd /d "C:\Users\12452\Desktop\deepseek"
set NODE="C:\Program Files\nodejs\node.exe"
set LOG=daily-update.log

echo. >> %LOG%
echo ===== %date% %time% scheduled run ===== >> %LOG%

set RC=1
set /a ATTEMPT=0

:retry
set /a ATTEMPT+=1
%NODE% daily-update.mjs >> %LOG% 2>&1
set RC=%ERRORLEVEL%

if %RC%==0 goto ok
rem RC=3 means the single-instance lock refused us: another daily run is in progress.
rem That is not a failure and retrying would not help.
if %RC%==3 goto busy
if %ATTEMPT% GEQ 2 goto giveup

echo [%date% %time%] attempt %ATTEMPT% FAILED rc=%RC%, retrying in 10 min >> %LOG%
rem ping is used as a sleep: the timeout command fails in a task with no console
ping -n 601 127.0.0.1 >nul
goto retry

:ok
echo [%date% %time%] attempt %ATTEMPT% OK >> %LOG%
goto done

:busy
echo [%date% %time%] rc=3 another daily run in progress, not retrying >> %LOG%
goto done

:giveup
echo [%date% %time%] gave up after %ATTEMPT% attempts rc=%RC% (cloud fallback at 15:50) >> %LOG%

:done
exit /b %RC%
