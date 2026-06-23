# OpenEnroll Platform Navigation Guide for AI Assistants

## Overview
This guide contains learned navigation patterns and common data loading issues discovered through extensive testing with Playwright. Use this to quickly navigate to different areas of the platform without the lengthy discovery process.

## Authentication & Login
- **URL**: `http://localhost:5173`
- **Test Accounts**:
  - System Admin: `sysadmin@open-enroll.com` / `testpass`
  - Tenant Admin: `tenant@open-enroll.com` / `testpass`
  - Agent: `agent@open-enroll.com` / `testpass`
  - Group Admin: `groupadmin@open-enroll.com` / `testpass`
  - Member: `member@open-enroll.com` / `testpass`

## Common Navigation Patterns

### 1. Group Details → Members Tab → Edit Member Modal
**Most Common Path for Member Management**

**Steps:**
1. Login as tenant admin
2. Navigate to Groups page: `page.click('text=Groups')`
3. Click "View" button on group row: `page.locator('tr').filter({ hasText: 'GroupName' }).locator('button:has-text("View")').click()`
4. Click Members tab: `page.locator('#group-tab-1').click()`
5. Click member menu button: `page.locator('[role="row"]:not([aria-rowindex="1"]) button:has(svg)').first().click()`
6. Click "Edit Member": `page.locator('[role="menuitem"]:has-text("Edit Member")').click()`

**Modal Structure:**
- Overlay: `.fixed.inset-0.bg-black.bg-opacity-50`
- Content: `.bg-white.rounded-lg.max-w-2xl`
- **CRITICAL**: Always scroll through modal content - fields may be below the fold

**Scrolling in Modals:**
```javascript
await modalContent.evaluate((element) => {
  element.scrollTop = element.scrollHeight;
});
```

### 2. DataGrid Navigation Patterns
**For any DataGrid component:**

**Row Selection:**
- Data rows: `[role="row"]:not([aria-rowindex="1"])`
- Header row: `[aria-rowindex="1"]`

**Action Buttons:**
- Menu buttons: `button:has(svg)` within rows
- Dropdown options: `[role="menuitem"]` or `.MuiMenuItem-root`
- Specific actions: `:has-text("ActionName")`

**Example - Click first member's edit button:**
```javascript
const firstRow = page.locator('[role="row"]:not([aria-rowindex="1"])').first();
const menuButton = firstRow.locator('button:has(svg)');
await menuButton.click();
await page.locator('[role="menuitem"]:has-text("Edit Member")').click();
```

### 3. Tab Navigation
**Common tab patterns:**
- Members tab: `#group-tab-1`
- Groups tab: `#group-tab-0`
- Other tabs: Look for `id="group-tab-{number}"` pattern

### 4. Modal Testing Protocol
**Always follow this sequence for modal testing:**

1. **Wait for modal to appear** - `await page.waitForTimeout(3000)`
2. **Verify modal structure** - Check overlay and content selectors
3. **Scroll through entire modal** - Don't assume fields are visible
4. **Test complete user journey** - Set → Save → Reopen → Verify
5. **Check for data persistence** - Verify values are actually saved

## Common Data Loading Issues

### 1. Missing Fields in API Responses
**Problem**: Frontend expects data that backend doesn't return
**Solution**: Check SQL queries in backend routes for missing SELECT fields

**Example - HireDate Issue:**
- Frontend expected `HireDate` field
- Backend SQL query was missing `FORMAT(m.HireDate, 'yyyy-MM-dd') as HireDate`
- Fixed by adding field to SELECT statement

### 2. Data Formatting Issues
**Problem**: Database stores dates as `2024-03-15T00:00:00.000Z` but frontend expects `YYYY-MM-DD`
**Solution**: Use `FORMAT(dateField, 'yyyy-MM-dd')` in SQL queries

### 3. Field Name Mismatches
**Problem**: Frontend looks for `name="hireDate"` but field has no name attribute
**Solution**: Add proper `name` attributes to form fields

### 4. Conditional Field Rendering
**Problem**: Fields only appear based on data conditions (e.g., `member.GroupId` exists)
**Solution**: Check conditional rendering logic in components

## Testing Best Practices

### 1. Always Use Playwright for Testing
- Don't rely on manual testing
- Use systematic approach with proper waits
- Test complete user journeys

### 2. Database Verification
- Use `./ai_scripts/db-query.sh` to verify data persistence
- Check actual database values after operations
- Verify data formatting matches expectations

### 3. Console Logging
- Enable console logging in Playwright tests
- Look for API call logs and data structure information
- Check for error messages or warnings

### 4. Field Discovery
**When fields aren't found:**
1. Get all input fields and inspect their attributes
2. Check for different naming patterns (camelCase, snake_case)
3. Look for conditional rendering based on data
4. Use multiple selector strategies

**Example field discovery:**
```javascript
const allInputs = await modalContent.locator('input').all();
for (let i = 0; i < allInputs.length; i++) {
  const name = await allInputs[i].getAttribute('name');
  const type = await allInputs[i].getAttribute('type');
  const value = await allInputs[i].inputValue();
  console.log(`Input ${i + 1}: name="${name}", type="${type}", value="${value}"`);
}
```

## Common Selectors

### DataGrid Components
- Rows: `[role="row"]:not([aria-rowindex="1"])`
- Cells: `[role="gridcell"]`
- Headers: `[role="columnheader"]`

### Modal Components
- Custom modals: `.fixed.inset-0.bg-black.bg-opacity-50`
- Material-UI modals: `[role="dialog"]` or `.MuiModal-root`
- Bootstrap modals: `.modal` or `.modal-dialog`

### Form Elements
- Input fields: `input[name="fieldName"]`
- Select dropdowns: `select[name="fieldName"]`
- Buttons: `button:has-text("ButtonText")`

## Debugging Checklist

When something isn't working:

1. **Check Navigation** - Are you on the right page/tab?
2. **Check Data Loading** - Is the API returning expected data?
3. **Check Field Visibility** - Are fields hidden or below the fold?
4. **Check Field Names** - Do fields have proper name attributes?
5. **Check Data Formatting** - Is data in the expected format?
6. **Check Database** - Is data actually being saved?
7. **Check Console Logs** - Are there any errors or warnings?

## Quick Reference Commands

### Playwright Test Setup
```javascript
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

// Enable console logging
page.on('console', msg => {
  console.log(`[${msg.type()}] ${msg.text()}`);
});
```

### Database Queries
```bash
# Check specific member data
./ai_scripts/db-query.sh "SELECT MemberId, HireDate FROM oe.Members WHERE MemberId = 'MEMBER_ID'"

# Check table schema
./ai_scripts/db-query.sh "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Members'"
```

## Notes
- Always test with real data, not mock data
- Use the "Topline Landscaping" group for testing (has members)
- Be patient with loading states - use proper waits
- Check both frontend and backend when debugging issues
- Document new navigation patterns as you discover them
