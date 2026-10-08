# 重新注册两个计划任务（DSH_DailyUpdate / DSH_Premarket）
#
# 为什么要这个脚本：
#   现有任务里的 DSH_Premarket 是 **UseUnifiedSchedulingEngine = false**（旧调度引擎），
#   而正常的 DSH_DailyUpdate 是 true。旧引擎会忽略 StartWhenAvailable（「错过就尽快补跑」），
#   实测 DSH_Premarket 自 2026-09-24 注册以来**一次都没触发过**，导致盘前更新停了 14 天
#   而且毫无提示。直接用 schtasks 命令行建任务无法设置这些字段，所以这里用 XML 注册。
#
# 用法（不需要管理员——任务以你自己的身份、有限权限运行）：
#   PowerShell 里：  .\install-tasks.ps1            # 注册/覆盖两个任务
#                    .\install-tasks.ps1 -DryRun    # 只打印 XML，不动系统
#                    .\install-tasks.ps1 -Show      # 打印当前已注册任务的摘要
#
# ⚠️ 不要用任务计划程序 GUI 里「使用最高权限运行」：看板脚本全在用户目录下读写，
#    不需要提权，提权反而会让 node 的 %USERPROFILE% 指向别处。

param(
  [switch]$DryRun,
  [switch]$Show
)

$ErrorActionPreference = 'Stop'
$Dir = 'C:\Users\12452\Desktop\deepseek'
$User = "$env:COMPUTERNAME\$env:USERNAME"

if ($Show) {
  Write-Host "已注册任务的摘要：" -ForegroundColor Cyan
  foreach ($n in 'DSH_DailyUpdate', 'DSH_Premarket') {
    $p = Join-Path $env:SystemRoot "System32\Tasks\$n"
    if (-not (Test-Path $p)) { Write-Host "  $n : 不存在"; continue }
    $x = Get-Content $p -Raw
    $eng = [regex]::Match($x, '<UseUnifiedSchedulingEngine>(.*?)</UseUnifiedSchedulingEngine>').Groups[1].Value
    $swa = [regex]::Match($x, '<StartWhenAvailable>(.*?)</StartWhenAvailable>').Groups[1].Value
    $sb  = [regex]::Match($x, '<StartBoundary>(.*?)</StartBoundary>').Groups[1].Value
    $en  = [regex]::Match($x, '<Enabled>(.*?)</Enabled>').Groups[1].Value
    Write-Host "  $n : 触发=$sb 启用=$en 统一引擎=$eng 错过补跑=$swa  文件=$p"
  }
  return
}

# 生成任务 XML。用 UTF-16 是 Windows 任务计划程序的要求（schtasks 导出的就是 UTF-16）。
function New-TaskXml([string]$desc, [string]$cmd, [string]$time) {
  @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>$desc</Description>
    <Author>$User</Author>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$(Get-Date -Format 'yyyy-MM-dd')T${time}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <DaysOfWeek>
          <Monday /><Tuesday /><Wednesday /><Thursday /><Friday />
        </DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$User</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$cmd</Command>
      <WorkingDirectory>$Dir</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

$jobs = @(
  @{ Name = 'DSH_DailyUpdate'; Time = '15:40'; Desc = 'DSH 盘后日更：抓行情 -> 重算统计 -> 生成看板 -> 发布' ; Cmd = "$Dir\run-daily.cmd" },
  @{ Name = 'DSH_Premarket';   Time = '09:26'; Desc = 'DSH 盘前更新：隔夜美股 + 亚洲早盘 + 集合竞价 -> 重建发布'; Cmd = "$Dir\run-premarket.cmd" }
)

foreach ($j in $jobs) {
  $xml = New-TaskXml $j.Desc $j.Cmd $j.Time
  if ($DryRun) {
    Write-Host "----- $($j.Name)（$($j.Time)）-----" -ForegroundColor Cyan
    Write-Host $xml
    continue
  }
  try {
    Register-ScheduledTask -TaskName $j.Name -Xml $xml -Force | Out-Null
    Write-Host "✓ 已注册 $($j.Name)  工作日 $($j.Time)  →  $($j.Cmd)" -ForegroundColor Green
  } catch {
    Write-Host "✗ $($j.Name) 注册失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  如果是权限问题：用「以管理员身份运行」打开 PowerShell 再跑一次（任务本身仍以你的身份运行）。" -ForegroundColor Yellow
  }
}

if (-not $DryRun) {
  Write-Host ""
  Write-Host "完成。检查： .\install-tasks.ps1 -Show" -ForegroundColor Cyan
  Write-Host "手动试跑：  Start-ScheduledTask -TaskName DSH_Premarket" -ForegroundColor Cyan
}
