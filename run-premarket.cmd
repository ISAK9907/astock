@echo off
chcp 65001 >nul
rem ============================================================================
rem  DSH pre-market update launcher (called by scheduled task, weekdays 09:26)
rem
rem  Collects overnight US close + Asian early session + A-share call auction.
rem  It writes premarket.json and appends to push-archive.json; the dashboard
rem  picks that up on the next daily rebuild.
rem
rem  WARNING - this file must stay pure ASCII. Under chcp 65001, cmd.exe slices
rem  UTF-8 multibyte lines at byte boundaries and tries to run the tail as a
rem  command. Seen here with a Chinese rem line:
rem    '...  is not recognized as an internal or external command
rem  It happened to be non-fatal, but a mis-slice can land on a real token and
rem  break the run. Chinese belongs in node output, never in this script.
rem
rem  Also: the scheduled task sets no WorkingDirectory, so the cd below is
rem  mandatory - without it the log redirect fails (no write access to System32)
rem  and node cannot even find premarket.mjs.
rem ============================================================================
cd /d "C:\Users\12452\Desktop\deepseek"
set NODE="C:\Program Files\nodejs\node.exe"
set LOG=premarket.log
rem Tell build-dashboard this is the morning build. The cloud gate needs to tell
rem them apart: otherwise a 09:26 premarket build would make the 15:50 cloud daily
rem run think "already updated today" and skip, so the close data would never land.
set BUILD_KIND=premarket

echo. >> %LOG%
echo ===== %date% %time% scheduled run ===== >> %LOG%

rem premarket.mjs writes premarket.json and appends to push-archive.json.
%NODE% premarket.mjs >> %LOG% 2>&1
set RC=%ERRORLEVEL%
if not %RC%==0 goto failed

rem Rebuild so the morning push shows up on the dashboard the same morning
rem (previously it only appeared after the 15:40 rebuild), then publish.
%NODE% build-dashboard.mjs >> %LOG% 2>&1
set RC=%ERRORLEVEL%
if not %RC%==0 goto failed

%NODE% deploy-pages.mjs >> %LOG% 2>&1
set RC=%ERRORLEVEL%
if not %RC%==0 goto failed

echo [%date% %time%] OK >> %LOG%
goto done

:failed
echo [%date% %time%] FAILED rc=%RC% >> %LOG%

:done
exit /b %RC%
