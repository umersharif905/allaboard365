Write-Host "Testing backend connection..." -ForegroundColor Yellow
Write-Host ""

try {
    # Test direct backend URL
    $response = Invoke-WebRequest -Uri "http://localhost:3001/api/admin/dashboard/test" -Method GET -ErrorAction Stop
    Write-Host "✅ Backend is running and responding!" -ForegroundColor Green
    Write-Host "Response: $($response.Content)" -ForegroundColor Gray
} catch {
    Write-Host "❌ Backend is NOT running or routes are not configured!" -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please make sure:" -ForegroundColor Yellow
    Write-Host "1. Backend is running (npm run dev in backend folder)" -ForegroundColor White
    Write-Host "2. Dashboard routes are loaded" -ForegroundColor White
}
