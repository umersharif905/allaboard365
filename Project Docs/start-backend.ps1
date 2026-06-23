# start-backend.ps1
# Script to start the backend server

Write-Host "🚀 Starting Open-Enroll Backend..." -ForegroundColor Cyan

$backendPath = "D:\developer\pvt\open-enroll\backend"
Set-Location $backendPath

# Check if .env exists
if (-not (Test-Path ".env")) {
    Write-Host "❌ .env file not found! Run setup scripts first." -ForegroundColor Red
    exit 1
}

# Display current configuration
Write-Host "`n📋 Current Configuration:" -ForegroundColor Yellow
$env = Get-Content ".env" | Where-Object { $_ -match "^(PORT|NODE_ENV|DB_SERVER|DB_NAME)=" }
$env | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }

Write-Host "`n🏃 Starting server..." -ForegroundColor Green
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

# Start with nodemon if available, otherwise use node
if (Test-Path "node_modules/.bin/nodemon.cmd") {
    & npm run dev
} else {
    & npm start
}
