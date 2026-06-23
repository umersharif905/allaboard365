# RE-ENABLE TESTS AFTER BUILD
Get-ChildItem -Path "src" -Filter "*.test.tsx.disabled" -Recurse | ForEach-Object {
    Rename-Item -Path $_.FullName -NewName ($_.Name -replace '\.test\.tsx\.disabled$', '.test.tsx')
}
Get-ChildItem -Path "src" -Filter "*.test.ts.disabled" -Recurse | ForEach-Object {
    Rename-Item -Path $_.FullName -NewName ($_.Name -replace '\.test\.ts\.disabled$', '.test.ts')
}
Write-Host "Tests re-enabled" -ForegroundColor Green
