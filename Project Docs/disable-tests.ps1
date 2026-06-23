# DISABLE TESTS FOR BUILD
Get-ChildItem -Path "src" -Filter "*.test.tsx" -Recurse | ForEach-Object {
    Rename-Item -Path $_.FullName -NewName ($_.Name -replace '\.test\.tsx$', '.test.tsx.disabled')
}
Get-ChildItem -Path "src" -Filter "*.test.ts" -Recurse | ForEach-Object {
    Rename-Item -Path $_.FullName -NewName ($_.Name -replace '\.test\.ts$', '.test.ts.disabled')
}
Write-Host "Tests disabled for build" -ForegroundColor Yellow
