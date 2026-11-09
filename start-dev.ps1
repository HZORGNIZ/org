# MyOrgNiz 一键启动脚本（开发环境）
# 用法：powershell -ExecutionPolicy Bypass -File start-dev.ps1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-Port([int]$port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

Write-Host "======== MyOrgNiz 开发环境启动 ========" -ForegroundColor Green

# 1. PostgreSQL (5432)
if (-not (Test-Port 5432)) {
  Write-Host "[1/4] 启动 PostgreSQL ..." -ForegroundColor Cyan
  & "$root\.local\pgsql\bin\pg_ctl.exe" -D "$root\.local\pgdata" -l "$root\.local\pg.log" start
  Start-Sleep -Seconds 2
} else { Write-Host "[1/4] PostgreSQL 已在运行 (5432)" -ForegroundColor DarkGray }

# 2. Redis (6379)
if (-not (Test-Port 6379)) {
  Write-Host "[2/4] 启动 Redis ..." -ForegroundColor Cyan
  Start-Process -FilePath "$root\.local\redis5\redis-server.exe" -WorkingDirectory "$root\.local\redis5" -WindowStyle Hidden
  Start-Sleep -Seconds 1
} else { Write-Host "[2/4] Redis 已在运行 (6379)" -ForegroundColor DarkGray }

# 3. API (3000)
if (-not (Test-Port 3000)) {
  Write-Host "[3/4] 启动 API ..." -ForegroundColor Cyan
  $node = (Get-Command node).Source
  Start-Process -FilePath $node -ArgumentList "dist/main.js" -WorkingDirectory "$root\apps\api" -WindowStyle Hidden
  Start-Sleep -Seconds 3
} else { Write-Host "[3/4] API 已在运行 (3000)" -ForegroundColor DarkGray }

# 4. 前端 (5173)
if (Test-Port 5173) {
  Write-Host "[4/4] 前端已在运行 (http://localhost:5173)" -ForegroundColor DarkGray
  Write-Host "`n所有服务已就绪，浏览器访问 http://localhost:5173 即可" -ForegroundColor Green
  exit 0
}
Write-Host "[4/4] 启动前端 (Vite dev server)，按 Ctrl+C 停止本窗口 ..." -ForegroundColor Cyan
Set-Location "$root"
pnpm --filter web dev
