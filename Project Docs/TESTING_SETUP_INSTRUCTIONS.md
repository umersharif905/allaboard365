# TESTING FRAMEWORK SETUP INSTRUCTIONS
# Fix dependency conflicts and get testing working

## IMMEDIATE FIXES NEEDED

### 1. Clean Dependencies and Reinstall
```bash
# Remove existing node_modules and package-lock.json
rm -rf node_modules package-lock.json

# Clear npm cache
npm cache clean --force

# Install with legacy peer deps to resolve conflicts
npm install --legacy-peer-deps
```

### 2. Install Missing Dependencies
```bash
# Install compatible vitest versions
npm install --save-dev vitest@^1.6.1 @vitest/ui@^1.6.1 @vitest/coverage-v8@^1.6.1 --legacy-peer-deps

# Install testing library packages
npm install --save-dev @testing-library/jest-dom@^6.1.0 @testing-library/react@^14.0.0 @testing-library/user-event@^14.5.0 --legacy-peer-deps

# Install Cypress
npm install --save-dev cypress@^13.17.0 --legacy-peer-deps
```

### 3. Run Safe Tests
```bash
# Run the safe test suite first
powershell ./run-safe-tests.ps1

# If that works, try basic unit tests
npm run test:unit

# Then try coverage (may need dependency fix)
npm run test:coverage
```

## COMMON ISSUES AND SOLUTIONS

### Issue 1: Vitest Coverage Dependency Conflict
**Problem:** `@vitest/coverage-v8` version mismatch
**Solution:** 
```bash
npm install --save-dev @vitest/coverage-v8@1.6.1 --legacy-peer-deps
```

### Issue 2: TypeScript Compilation Errors
**Problem:** TypeScript can't compile the project
**Solutions:**
1. Check for missing type declarations
2. Verify tsconfig.json includes test files
3. Install missing @types packages

### Issue 3: Cypress Can't Find Elements
**Problem:** E2E tests fail because elements don't exist
**Solutions:**
1. Ensure frontend is running: `npm run dev`
2. Check if login page uses different selectors
3. Use the safer E2E tests: `npm run test:e2e`

### Issue 4: Frontend Not Running
**Problem:** E2E tests fail because localhost:5173 not accessible
**Solution:**
```bash
# Start frontend in separate terminal
npm run dev

# Then run E2E tests in another terminal
npm run test:e2e:open
```

## TESTING WORKFLOW

### Development Testing (Recommended)
```bash
# 1. Start with safe tests
powershell ./run-safe-tests.ps1

# 2. Run unit tests
npm run test:unit

# 3. Start frontend for E2E testing
npm run dev

# 4. In separate terminal, run E2E tests
npm run test:e2e:open
```

### Production Testing
```bash
# 1. Install dependencies
npm install --legacy-peer-deps

# 2. Build the project
npm run build

# 3. Run comprehensive tests
npm run test:coverage

# 4. Run E2E tests against production build
npm run preview
npm run test:e2e
```

## TROUBLESHOOTING

### If Dependencies Still Conflict:
1. Delete `node_modules` and `package-lock.json`
2. Update Node.js to latest LTS version
3. Run `npm install --legacy-peer-deps --force`

### If TypeScript Errors Persist:
1. Check `tsconfig.json` includes test files
2. Install missing @types packages
3. Use `npx tsc --noEmit` to check compilation

### If Tests Still Fail:
1. Verify frontend code has proper test-id attributes
2. Check console for actual error messages
3. Use Cypress interactive mode to debug selectors

## NEXT STEPS

1. **Fix Dependencies First** - Run the installation commands above
2. **Test Basic Functionality** - Use `run-safe-tests.ps1`
3. **Start Frontend** - Run `npm run dev` 
4. **Test E2E Interactively** - Use `npm run test:e2e:open`
5. **Add Test IDs** - Add proper `data-testid` attributes to frontend components

The testing framework is now configured to be more resilient and will work once dependencies are properly installed.
