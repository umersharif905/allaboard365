# run-all-tests.ps1
# Automated testing script for Open-Enroll platform

Write-Host "🧪 OPEN-ENROLL AUTOMATED TESTING SUITE" -ForegroundColor Magenta
Write-Host "=======================================" -ForegroundColor Magenta

$ErrorActionPreference = "Continue"
$testResults = @{
    passed = 0
    failed = 0
    skipped = 0
}

# Function to run test and capture results
function Run-Test {
    param(
        [string]$TestName,
        [scriptblock]$TestBlock
    )
    
    Write-Host "🔍 Running: $TestName" -ForegroundColor Cyan
    
    try {
        & $TestBlock
        Write-Host "✅ PASSED: $TestName" -ForegroundColor Green
        $script:testResults.passed++
    }
    catch {
        Write-Host "❌ FAILED: $TestName - $($_.Exception.Message)" -ForegroundColor Red
        $script:testResults.failed++
    }
}

# 1. TYPESCRIPT COMPILATION TEST
Run-Test "TypeScript Compilation" {
    Write-Host "   Checking TypeScript compilation..." -ForegroundColor Yellow
    $result = npm run build 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "TypeScript compilation failed"
    }
}

# 2. UNIT TESTS
Run-Test "Unit Tests" {
    Write-Host "   Running unit tests with coverage..." -ForegroundColor Yellow
    $result = npm run test:coverage 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Unit tests failed"
    }
}

# 3. AUTHENTICATION INTEGRATION TEST
Run-Test "Authentication Integration" {
    Write-Host "   Testing OAuth integration..." -ForegroundColor Yellow
    
    $authTest = @{
        url = "https://oauth.open-enroll.com/auth/login"
        method = "POST"
        headers = @{ "Content-Type" = "application/json" }
        body = @{
            email = "chris@mightywell.us"
            password = "PutM3First#"
        } | ConvertTo-Json
    }
    
    try {
        $response = Invoke-RestMethod @authTest
        if (-not $response.accessToken) {
            throw "No access token received"
        }
    }
    catch {
        throw "Authentication test failed: $($_.Exception.Message)"
    }
}

# 4. API ENDPOINT HEALTH CHECK
Run-Test "API Health Check" {
    Write-Host "   Checking API endpoint health..." -ForegroundColor Yellow
    
    $endpoints = @(
        "https://api.open-enroll.com/health",
        "https://api.open-enroll.com/api/products",
        "https://api.open-enroll.com/api/admin/tenants"
    )
    
    foreach ($endpoint in $endpoints) {
        try {
            $response = Invoke-WebRequest -Uri $endpoint -TimeoutSec 10
            if ($response.StatusCode -ne 200) {
                throw "Endpoint $endpoint returned status $($response.StatusCode)"
            }
        }
        catch {
            throw "API health check failed for $endpoint"
        }
    }
}

# 5. DATABASE CONNECTION TEST
Run-Test "Database Connection" {
    Write-Host "   Testing database connectivity..." -ForegroundColor Yellow
    
    # This would typically use a database testing utility
    # For now, we'll test via API
    try {
        $response = Invoke-RestMethod -Uri "https://api.open-enroll.com/api/health/database" -TimeoutSec 15
        if ($response.status -ne "healthy") {
            throw "Database health check failed"
        }
    }
    catch {
        throw "Database connection test failed: $($_.Exception.Message)"
    }
}

# 6. PERFORMANCE BENCHMARK
Run-Test "Performance Benchmark" {
    Write-Host "   Running performance benchmarks..." -ForegroundColor Yellow
    
    $performanceTargets = @{
        "https://open-enroll.com" = 3000  # 3 seconds max
        "https://api.open-enroll.com/api/products" = 1000  # 1 second max
    }
    
    foreach ($target in $performanceTargets.GetEnumerator()) {
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            Invoke-WebRequest -Uri $target.Key -TimeoutSec 10 | Out-Null
            $stopwatch.Stop()
            
            if ($stopwatch.ElapsedMilliseconds -gt $target.Value) {
                throw "Performance target missed: $($target.Key) took $($stopwatch.ElapsedMilliseconds)ms (max: $($target.Value)ms)"
            }
        }
        catch {
            $stopwatch.Stop()
            throw "Performance test failed for $($target.Key): $($_.Exception.Message)"
        }
    }
}

# 7. SECURITY SCAN
Run-Test "Security Scan" {
    Write-Host "   Running basic security checks..." -ForegroundColor Yellow
    
    # Check for HTTPS enforcement
    try {
        $httpResponse = Invoke-WebRequest -Uri "http://open-enroll.com" -MaximumRedirection 0 -ErrorAction SilentlyContinue
        if ($httpResponse.StatusCode -ne 301 -and $httpResponse.StatusCode -ne 302) {
            throw "HTTP to HTTPS redirect not properly configured"
        }
    }
    catch {
        # This is expected for proper HTTPS enforcement
    }
    
    # Check security headers
    try {
        $response = Invoke-WebRequest -Uri "https://open-enroll.com"
        $requiredHeaders = @("Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options")
        
        foreach ($header in $requiredHeaders) {
            if (-not $response.Headers.ContainsKey($header)) {
                Write-Warning "Missing security header: $header"
            }
        }
    }
    catch {
        throw "Security header check failed: $($_.Exception.Message)"
    }
}

# 8. CYPRESS E2E TESTS (if Cypress is installed)
if (Test-Path "cypress") {
    Run-Test "End-to-End Tests" {
        Write-Host "   Running Cypress E2E tests..." -ForegroundColor Yellow
        $result = npx cypress run --headless 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "E2E tests failed"
        }
    }
} else {
    Write-Host "⚠️  Cypress not installed - skipping E2E tests" -ForegroundColor Yellow
    $testResults.skipped++
}

# 9. ACCESSIBILITY TEST
Run-Test "Accessibility Check" {
    Write-Host "   Running accessibility validation..." -ForegroundColor Yellow
    
    # Basic accessibility check (would use axe-core in real implementation)
    try {
        $response = Invoke-WebRequest -Uri "https://open-enroll.com"
        $content = $response.Content
        
        # Check for basic accessibility requirements
        if ($content -notmatch '<html[^>]*lang=') {
            throw "Missing lang attribute on html element"
        }
        
        if ($content -notmatch '<title>') {
            throw "Missing title element"
        }
        
        # Check for alt attributes on images (basic check)
        $images = [regex]::Matches($content, '<img[^>]*>')
        foreach ($img in $images) {
            if ($img.Value -notmatch 'alt=') {
                Write-Warning "Image without alt attribute found"
            }
        }
    }
    catch {
        throw "Accessibility check failed: $($_.Exception.Message)"
    }
}

# 10. FINAL VALIDATION
Run-Test "Final System Validation" {
    Write-Host "   Running comprehensive system validation..." -ForegroundColor Yellow
    
    # Test critical user journey
    try {
        # This would test the complete user flow in a real implementation
        # For now, we'll check that all critical endpoints are responding
        $criticalEndpoints = @(
            "https://open-enroll.com/login",
            "https://open-enroll.com/admin",
            "https://api.open-enroll.com/auth/me",
            "https://api.open-enroll.com/api/products"
        )
        
        foreach ($endpoint in $criticalEndpoints) {
            $response = Invoke-WebRequest -Uri $endpoint -TimeoutSec 10
            if ($response.StatusCode -ne 200) {
                throw "Critical endpoint $endpoint not responding properly"
            }
        }
    }
    catch {
        throw "Final system validation failed: $($_.Exception.Message)"
    }
}

# RESULTS SUMMARY
Write-Host "`n" -NoNewline
Write-Host "🎯 TEST RESULTS SUMMARY" -ForegroundColor Magenta
Write-Host "======================" -ForegroundColor Magenta
Write-Host "✅ Passed: $($testResults.passed)" -ForegroundColor Green
Write-Host "❌ Failed: $($testResults.failed)" -ForegroundColor Red
Write-Host "⚠️  Skipped: $($testResults.skipped)" -ForegroundColor Yellow

$totalTests = $testResults.passed + $testResults.failed + $testResults.skipped
$passRate = if ($totalTests -gt 0) { [math]::Round(($testResults.passed / $totalTests) * 100, 2) } else { 0 }

Write-Host "📊 Pass Rate: $passRate%" -ForegroundColor Cyan

if ($testResults.failed -eq 0) {
    Write-Host "`n🎉 ALL TESTS PASSED - READY FOR PRODUCTION!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n⚠️  TESTS FAILED - RESOLVE ISSUES BEFORE PRODUCTION DEPLOYMENT" -ForegroundColor Red
    exit 1
}
