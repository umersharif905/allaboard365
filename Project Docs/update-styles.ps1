# Script to update all components with new style classes
param(
    [string]$ComponentPath = "src"
)

Write-Host "🎨 Updating component styles..." -ForegroundColor Cyan

# Style replacements
$replacements = @{
    # Colors
    'bg-blue-500' = 'bg-oe-primary'
    'bg-blue-600' = 'bg-oe-primary'
    'bg-blue-700' = 'bg-oe-dark'
    'bg-blue-50' = 'bg-oe-light'
    'bg-blue-100' = 'bg-oe-light'
    'text-blue-500' = 'text-oe-primary'
    'text-blue-600' = 'text-oe-primary'
    'text-blue-700' = 'text-oe-dark'
    'border-blue-500' = 'border-oe-primary'
    'hover:bg-blue-600' = 'hover:bg-oe-dark'
    'hover:bg-blue-700' = 'hover:bg-oe-dark'
    'focus:ring-blue-500' = 'focus:ring-oe-primary'
    
    # Buttons
    'className=".*?bg-blue-500.*?text-white.*?"' = 'className="btn-primary"'
    'className=".*?bg-white.*?text-blue-500.*?border.*?"' = 'className="btn-secondary"'
    'className=".*?bg-red-500.*?text-white.*?"' = 'className="btn-danger"'
    
    # Inputs
    'className=".*?border.*?rounded.*?px-3.*?py-2.*?"' = 'className="form-input"'
    
    # Cards
    'className=".*?bg-white.*?rounded.*?shadow.*?"' = 'className="card"'
}

# Get all component files
$files = Get-ChildItem -Path $ComponentPath -Include "*.tsx", "*.jsx" -Recurse

foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw
    $originalContent = $content
    
    foreach ($pattern in $replacements.GetEnumerator()) {
        if ($pattern.Key -match 'className=') {
            # Regex replacement for className patterns
            $content = $content -replace $pattern.Key, $pattern.Value
        } else {
            # Simple string replacement
            $content = $content -replace $pattern.Key, $pattern.Value
        }
    }
    
    if ($content -ne $originalContent) {
        Set-Content -Path $file.FullName -Value $content -Encoding UTF8
        Write-Host "  ✅ Updated: $($file.Name)" -ForegroundColor Green
    }
}

Write-Host "✅ Style updates complete!" -ForegroundColor Green
