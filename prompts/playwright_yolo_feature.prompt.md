# OpenEnroll Feature Development with Playwright MCP

## Overview
This prompt defines the complete feature development process for OpenEnroll using Playwright MCP for testing. Use this when you want me to build a new feature from scratch and test it until it's completely functional.

## Development Rules

### 🚨 CRITICAL: Reference Guides
- **@platform-navigation-guide.md** - Complete navigation patterns and common selectors
- **@common-data-loading-issues.md** - Common data loading problems and debugging solutions
- **@backend-system.md** - Backend development patterns and security requirements

### Backend Development
- **🚨 CRITICAL: Follow @backend-system.md patterns** - This is MANDATORY for all backend-to-frontend communication
- **🚨 NEVER deviate from @backend-system.md** - It contains critical security, routing, and API patterns
- **Use proper authentication/authorization** - Implement role-based access control
- **Follow database patterns** - Use existing schema and naming conventions
- **Implement proper error handling** - Return consistent error responses
- **Use proper logging** - Log all important operations and errors

### Frontend Development
- **Follow UI consistency rules** - Use Tailwind CSS, Lucide React icons, native HTML elements
- **Use React Query for data fetching** - Implement proper hook-based data fetching
- **Follow component patterns** - Use established component structure and naming
- **Implement proper TypeScript** - Use proper interfaces and type safety
- **Follow responsive design** - Ensure mobile-first, progressive enhancement
- **🚨 CRITICAL: Separate public and authenticated routes** - Public routes must be outside AuthProvider

### API Integration
- **Use apiService** - All API calls through the centralized service
- **Implement proper error handling** - Handle all error states gracefully
- **Use proper loading states** - Show loading indicators during API calls
- **Implement proper caching** - Use React Query for intelligent caching
- **🚨 CRITICAL: Handle public endpoints correctly** - Check auth requirement before getting tokens

## Feature Development Process

### Phase 1: Planning & Design
1. **Analyze requirements** - Understand what needs to be built
2. **Design data flow** - Plan how data moves through the system
3. **Design user experience** - Plan the user interface and interactions
4. **Plan API endpoints** - Design backend endpoints needed
5. **Plan database changes** - Design any schema changes needed

### Phase 2: Backend Development
1. **Create database schema** - Add any new tables or columns needed
2. **Create API endpoints** - Implement all backend endpoints
3. **Implement business logic** - Add all necessary business rules
4. **Add authentication/authorization** - Implement proper access control
5. **Add error handling** - Implement comprehensive error handling

### Phase 3: Frontend Development
1. **Create TypeScript interfaces** - Define all data types
2. **Create service layer** - Implement API service methods
3. **Create React Query hooks** - Implement data fetching hooks
4. **Create components** - Build all UI components
5. **Implement routing** - Add any new routes needed

### Phase 4: Testing with Playwright MCP
**🚨 CRITICAL: Use Playwright MCP for ALL testing - NO Cypress tests needed**

1. **Test public routes** - Verify public routes (enrollment links) work without authentication
2. **Test authenticated routes** - Verify protected routes require proper authentication
3. **Test user flows** - Use Playwright to complete full user journeys
4. **Test error scenarios** - Use Playwright to test error handling
5. **Test edge cases** - Use Playwright to test boundary conditions

**🚨 CRITICAL: Use Reference Guides for Testing**
- **@platform-navigation-guide.md** - Use for navigation patterns and common selectors
- **@common-data-loading-issues.md** - Reference when debugging data loading problems
- Follow the systematic debugging process outlined in the guides

### Phase 5: Quality Assurance with Playwright MCP
1. **Login and test manually** - Use Playwright to login with test accounts
2. **Test complete user flows** - Use Playwright to verify end-to-end functionality
3. **Verify data persistence** - Use Playwright to check that data is saved
4. **Test form submissions** - Use Playwright to verify forms work
5. **Test success states** - Use Playwright to verify success messages
6. **Test error handling** - Use Playwright to verify error states
7. **Take screenshots/videos** - Use Playwright to document functionality

## Playwright MCP Testing Protocol

### 🚨 CRITICAL: Always Use Playwright MCP for Testing

**Instead of writing Cypress tests, use Playwright MCP commands like:**

- **"Navigate to the login page and test the login flow"**
- **"Fill out the enrollment form and verify it submits successfully"**
- **"Create a new user and verify they appear in the user list"**
- **"Test the agent dashboard by logging in as an agent"**
- **"Verify data persistence by checking the database after operations"**

### 🚨 CRITICAL: Multiple Playwright Instances Support

**When Playwright MCP shows "Not connected" error due to another AI chat using Playwright:**

**✅ SOLUTION: Use Direct Playwright Scripts Instead of MCP**

**Why this happens:**
- Playwright MCP typically runs as a single browser instance
- Multiple MCP connections to the same Playwright service cause conflicts
- Each MCP instance expects exclusive access to the browser

**✅ WORKING SOLUTION:**
1. **Create direct Playwright test scripts** in `playwright/tests/` directory
2. **Use `chromium.launch()`** instead of MCP commands
3. **Each script gets its own independent browser instance**
4. **Multiple instances can run simultaneously without conflicts**

**Example Implementation:**
```javascript
// playwright/tests/feature-test.js
import { chromium } from 'playwright';

async function testFeature() {
  const browser = await chromium.launch({ 
    headless: false,
    slowMo: 1000
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    await page.goto('http://localhost:5173');
    // Test your feature here
  } finally {
    await browser.close();
  }
}

testFeature();
```

**Running the test:**
```bash
node playwright/tests/feature-test.js
```

**Benefits of this approach:**
- ✅ **Multiple instances work independently**
- ✅ **No MCP connection conflicts**
- ✅ **Full Playwright functionality available**
- ✅ **Can run alongside other AI chats using Playwright**
- ✅ **More reliable than MCP when conflicts occur**

**🚨 CRITICAL: File Organization for Testing**
- **Test files**: Save all `.js` test files in `playwright/tests/`
- **Screenshots**: Save all `.png` screenshots in `playwright/screenshots/`
- **Debug files**: Save all debug scripts in `playwright/debug/`
- **Reports**: Save all test reports in `playwright/reports/`
- **Never create files in project root** - Always use the organized directory structure

### 🚨 CRITICAL: Dynamic Route Discovery & Navigation Strategy

**🚨 ALWAYS use database-driven navigation for testing specific entities:**

1. **🔍 DATABASE-FIRST APPROACH FOR ENTITY TESTING**
   ```bash
   # Find specific entities to test
   ./ai_scripts/db-query.sh "SELECT TOP 5 GroupId, GroupName FROM oe.Groups WHERE Status = 'Active'"
   ./ai_scripts/db-query.sh "SELECT TOP 5 MemberId, FirstName, LastName FROM oe.Members WHERE Status = 'Active'"
   ./ai_scripts/db-query.sh "SELECT TOP 5 UserId, Email FROM oe.Users WHERE Status = 'Active'"
   ```

2. **🔍 ANALYZE @App.tsx FOR ROUTE PATTERNS**
   ```javascript
   // Look for patterns like:
   // <Route path="groups/:groupId" element={<GroupDetails />} />
   // <Route path="members/:memberId" element={<MemberDetails />} />
   // <Route path="agents/:agentId" element={<AgentDetails />} />
   ```

3. **🔍 DIRECT NAVIGATION TO SPECIFIC ENTITIES**
   ```javascript
   // Navigate directly using discovered IDs
   await page.goto(`http://localhost:5173/agent/groups/${groupId}`);
   await page.goto(`http://localhost:5173/tenant-admin/members/${memberId}`);
   await page.goto(`http://localhost:5173/admin/agents/${agentId}`);
   ```

4. **🔍 SEQUENTIAL NAVIGATION VS DIRECT ROUTES**
   
   **✅ USE DIRECT ROUTES FOR:**
   - Entity detail pages (groups, members, users, agents)
   - Specific record views that have stable IDs
   - Deep linking to specific functionality
   - Testing specific entity states or data
   
   **✅ USE SEQUENTIAL NAVIGATION FOR:**
   - Forms and multi-step workflows
   - Dashboard-to-detail flows
   - Authentication-dependent flows
   - When direct routes don't exist or aren't accessible

5. **🔍 NAVIGATION STRATEGY DECISION TREE**
   ```javascript
   // Ask these questions:
   // 1. Do I need to test a specific entity (group, member, user)?
   //    → YES: Use database query + direct route
   //    → NO: Continue to question 2
   
   // 2. Is this a multi-step workflow or form?
   //    → YES: Use sequential navigation
   //    → NO: Continue to question 3
   
   // 3. Does @App.tsx show a direct route to this functionality?
   //    → YES: Use direct route
   //    → NO: Use sequential navigation
   ```

6. **🔍 DATABASE-DRIVEN TESTING WORKFLOW**
   ```bash
   # Step 1: Find testable entities
   ./ai_scripts/db-query.sh "SELECT GroupId, GroupName, Status FROM oe.Groups WHERE Status = 'Active'"
   
   # Step 2: Extract specific ID for testing
   # Example result: GroupId = "71C4804C-C46F-4A52-BC17-C06038E8DF96"
   
   # Step 3: Navigate directly in Playwright
   await page.goto('http://localhost:5173/agent/groups/71C4804C-C46F-4A52-BC17-C06038E8DF96');
   ```

7. **🔍 WHEN TO ASK FOR CLARIFICATION**
   - **Ask if unsure** about navigation strategy
   - **Ask for specific entity** if user mentions testing "a specific group/user"
   - **Ask for workflow context** if the testing goal isn't clear
   - **Default to sequential** if direct route strategy is unclear

8. **🔍 REAL-WORLD EXAMPLE: Group Onboarding Testing**
   ```bash
   # Step 1: Find a specific group to test
   ./ai_scripts/db-query.sh "SELECT TOP 3 GroupId, GroupName, Status FROM oe.Groups WHERE Status = 'Active'"
   
   # Result: GroupId = "71C4804C-C46F-4A52-BC17-C06038E8DF96"
   ```
   
   ```javascript
   // Step 2: Analyze @App.tsx route patterns
   // Found: <Route path="groups/:groupId" element={<GroupDetails />} />
   
   // Step 3: Navigate directly to group details
   await page.goto('http://localhost:5173/agent/groups/71C4804C-C46F-4A52-BC17-C06038E8DF96');
   
   // Step 4: Click Onboarding tab (sequential navigation within the page)
   await page.click('th:has-text("Onboarding")');
   ```

9. **🔍 NAVIGATION STRATEGY EXAMPLES**
   
   **✅ DIRECT ROUTE EXAMPLES:**
   ```javascript
   // Testing specific group onboarding functionality
   await page.goto('http://localhost:5173/agent/groups/71C4804C-C46F-4A52-BC17-C06038E8DF96');
   
   // Testing specific member details
   await page.goto('http://localhost:5173/tenant-admin/members/12345');
   
   // Testing specific agent profile
   await page.goto('http://localhost:5173/admin/agents/67890');
   ```
   
   **✅ SEQUENTIAL NAVIGATION EXAMPLES:**
   ```javascript
   // Multi-step enrollment workflow
   await page.goto('http://localhost:5173/enroll/abc123');
   await page.click('button:has-text("Continue")');
   await page.click('button:has-text("Next Step")');
   
   // Dashboard to details workflow
   await page.goto('http://localhost:5173/agent/dashboard');
   await page.click('button:has-text("View Groups")');
   await page.click('button:has-text("View")');
   ```

### 🚨 CRITICAL: UI Element Identification Protocol

**Before attempting any navigation or interaction:**

1. **Take inventory of ALL available UI elements** - buttons, links, tabs, dropdowns, etc.
2. **Look for obvious navigation elements first** - buttons labeled "View", "Edit", "Details", "Add", etc.
3. **Don't overcomplicate simple tasks** - use existing UI elements before creating complex workarounds
4. **Evaluate ALL layout possibilities** - check for DataGrids, tables, lists, cards, modals, etc.
5. **Use proper selectors** - DataGrids use `[role="row"]`, tables use `tbody tr`, cards use different selectors
6. **Be patient with loading states** - wait for data to load before looking for elements
7. **Check console logs** - they often reveal data loading and rendering issues

### 🚨 CRITICAL: Modal Identification and Interaction Protocol

**Before attempting to interact with any modal, ALWAYS follow this systematic approach:**

1. **🔍 MODAL DETECTION STRATEGIES**
   ```javascript
   // Primary modal detection patterns (try in order)
   const modalSelectors = [
     '.fixed.inset-0.bg-black.bg-opacity-50',  // Custom modals (most common)
     '[role="dialog"]',                        // ARIA dialog modals
     '.MuiModal-root',                         // Material-UI modals
     '.modal',                                 // Bootstrap modals
     '.modal-dialog',                          // Bootstrap modal dialogs
     '.fixed.inset-0',                         // Generic fixed overlay
     '.absolute.inset-0',                      // Absolute positioned overlays
     '.z-50, .z-40, .z-30'                    // High z-index elements
   ];
   
   // Find the first visible modal
   let modal = null;
   for (const selector of modalSelectors) {
     modal = page.locator(selector).first();
     if (await modal.isVisible()) {
       console.log(`✅ Found modal with selector: ${selector}`);
       break;
     }
   }
   ```

2. **🔍 MODAL CONTENT AREA IDENTIFICATION**
   ```javascript
   // Once modal is found, identify the content area
   const modalContentSelectors = [
     '.fixed.inset-0.bg-black.bg-opacity-50 .bg-white',  // Custom modal content
     '[role="dialog"] .bg-white',                        // ARIA dialog content
     '.MuiModal-root .MuiDialog-paper',                  // Material-UI content
     '.modal .modal-content',                            // Bootstrap content
     '.modal-dialog .modal-content',                     // Bootstrap dialog content
     '.fixed.inset-0 .bg-white',                         // Generic white content
     '.absolute.inset-0 .bg-white',                      // Absolute positioned content
     '.z-50 .bg-white, .z-40 .bg-white'                  // High z-index content
   ];
   
   let modalContent = null;
   for (const selector of modalContentSelectors) {
     modalContent = page.locator(selector).first();
     if (await modalContent.isVisible()) {
       console.log(`✅ Found modal content with selector: ${selector}`);
       break;
     }
   }
   ```

3. **🔍 MODAL SCROLLABILITY ASSESSMENT**
   ```javascript
   // Check if modal content is scrollable
   if (modalContent) {
     const scrollHeight = await modalContent.evaluate(el => el.scrollHeight);
     const clientHeight = await modalContent.evaluate(el => el.clientHeight);
     console.log(`📊 Modal scroll height: ${scrollHeight}, client height: ${clientHeight}`);
     
     if (scrollHeight > clientHeight) {
       console.log('✅ Modal is scrollable - content extends beyond viewport');
       // Scroll through entire modal to find all content
       await modalContent.evaluate((element) => {
         element.scrollTop = element.scrollHeight;
       });
       await page.waitForTimeout(1000);
       await modalContent.evaluate((element) => {
         element.scrollTop = 0;
       });
     } else {
       console.log('ℹ️ Modal content fits within viewport - no scrolling needed');
     }
   }
   ```

4. **🔍 MODAL INTERACTION ELEMENT DISCOVERY**
   ```javascript
   // Find all interactive elements within the modal
   const interactiveElements = [
     'button', 'input', 'select', 'textarea', 'a', '[role="button"]', '[role="tab"]', '[role="menuitem"]'
   ];
   
   for (const elementType of interactiveElements) {
     const elements = await modalContent.locator(elementType).all();
     console.log(`📊 Found ${elements.length} ${elementType} elements in modal`);
     
     for (let i = 0; i < Math.min(elements.length, 10); i++) {
       const text = await elements[i].textContent();
       const type = await elements[i].getAttribute('type');
       const role = await elements[i].getAttribute('role');
       console.log(`  ${elementType} ${i + 1}: "${text}" (type=${type}, role=${role})`);
     }
   }
   ```

5. **🔍 MODAL TAB AND NAVIGATION DISCOVERY**
   ```javascript
   // Look for tabs, navigation, or section headers
   const tabSelectors = [
     'th', 'button', '[role="tab"]', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
   ];
   
   for (const selector of tabSelectors) {
     const elements = await modalContent.locator(selector).all();
     console.log(`📊 Found ${elements.length} ${selector} elements in modal`);
     
     for (let i = 0; i < Math.min(elements.length, 20); i++) {
       const text = await elements[i].textContent();
       if (text && text.trim().length > 0) {
         console.log(`  ${selector} ${i + 1}: "${text.trim()}"`);
       }
     }
   }
   ```

6. **🔍 MODAL CLICK INTERCEPTION SOLUTIONS**
   ```javascript
   // When clicks are intercepted by modal overlays, try these solutions in order:
   
   // Solution 1: Force click
   try {
     await element.click({ force: true });
     console.log('✅ Force click successful');
   } catch (e1) {
     console.log('❌ Force click failed, trying dispatchEvent...');
     
     // Solution 2: Dispatch click event
     try {
       await element.dispatchEvent('click');
       console.log('✅ DispatchEvent click successful');
     } catch (e2) {
       console.log('❌ DispatchEvent click failed, trying evaluate...');
       
       // Solution 3: Evaluate click
       try {
         await element.evaluate(el => el.click());
         console.log('✅ Evaluate click successful');
       } catch (e3) {
         console.log('❌ All click methods failed');
         throw new Error('Could not click element in modal');
       }
     }
   }
   ```

7. **🔍 MODAL CLOSING STRATEGIES**
   ```javascript
   // Try multiple methods to close modal
   const closeSelectors = [
     'button:has-text("Close")',
     'button:has-text("Cancel")',
     'button:has-text("×")',
     'button[aria-label*="Close"]',
     '.close-button',
     '[data-testid*="close"]',
     '.modal-close'
   ];
   
   let closed = false;
   for (const selector of closeSelectors) {
     const closeButton = page.locator(selector);
     if (await closeButton.isVisible()) {
       await closeButton.click();
       console.log(`✅ Modal closed with selector: ${selector}`);
       closed = true;
       break;
     }
   }
   
   if (!closed) {
     // Try pressing Escape key
     await page.keyboard.press('Escape');
     console.log('✅ Modal closed with Escape key');
   }
   ```

8. **🔍 MODAL TESTING CHECKLIST**
   - ✅ Modal is detected and content area identified
   - ✅ Modal scrollability assessed and scrolled through if needed
   - ✅ All interactive elements discovered and logged
   - ✅ Tabs/navigation elements found and logged
   - ✅ Click interception issues resolved with appropriate method
   - ✅ Modal can be closed successfully
   - ✅ Screenshots taken at each major step
   - ✅ Console logs monitored for errors

**🚨 CRITICAL: Always follow this protocol before attempting any modal interaction!**

### 🚨 CRITICAL: Modal and Form Testing Protocol

**When testing modals, forms, or any scrollable content:**

1. **ALWAYS scroll through the entire modal/form** - Don't assume all fields are visible initially
2. **Check for scrollable content** - Look for scroll indicators, overflow, or content that extends beyond viewport
3. **Test the complete user journey** - Open modal → Scroll to find field → Set value → Save → Reopen → Verify persistence
4. **Don't make assumptions about field visibility** - A field might be hidden due to data conditions OR simply be below the fold
5. **Use proper scrolling techniques** - Use `page.evaluate()` to scroll within specific containers (modals, forms)
6. **Verify field presence before testing functionality** - Always confirm the field exists before attempting to interact with it
7. **Test data persistence thoroughly** - Set a value, save, reopen, and verify the value is still there

### 🚨 CRITICAL: Modal Types and Scrolling Strategies

**Different modal types require different approaches:**

1. **Custom Modals (like MemberEdit)** - Use `.fixed.inset-0.bg-black.bg-opacity-50` for overlay, `.bg-white.rounded-lg` for content
2. **Material-UI Modals** - Use `[role="dialog"]` or `.MuiModal-root` selectors
3. **Bootstrap Modals** - Use `.modal` or `.modal-dialog` selectors
4. **Always check for scrollable containers** - Look for `overflow-y-auto`, `max-h-[90vh]`, or similar classes

**Scrolling within modals:**
```javascript
// Scroll within modal content area
await modalContent.evaluate((element) => {
  element.scrollTop = element.scrollHeight;
});

// Or scroll to bottom
await modalContent.evaluate((element) => {
  element.scrollTo(0, element.scrollHeight);
});
```

### 🚨 CRITICAL: Field Name and Selector Discovery

**When fields aren't found by expected names:**

1. **Check all input fields first** - Get all inputs and inspect their attributes
2. **Look for different naming patterns** - Fields might use camelCase, snake_case, or different names
3. **Check for conditional rendering** - Fields might only appear based on data conditions
4. **Inspect field attributes** - Look at `name`, `id`, `data-testid`, `aria-label` attributes
5. **Use multiple selector strategies** - Try by type, by label text, by position, by attributes

**Field discovery pattern:**
```javascript
// Get all input fields and inspect them
const allInputs = await modalContent.locator('input').all();
for (let i = 0; i < allInputs.length; i++) {
  const name = await allInputs[i].getAttribute('name');
  const type = await allInputs[i].getAttribute('type');
  const id = await allInputs[i].getAttribute('id');
  const value = await allInputs[i].inputValue();
  console.log(`Input ${i + 1}: name="${name}", type="${type}", id="${id}", value="${value}"`);
}
```

### 🚨 CRITICAL: Data Persistence Testing Protocol

**When testing save/update functionality:**

1. **Set a test value** - Use a specific, identifiable value for testing
2. **Save the changes** - Click save/submit and wait for completion
3. **Reopen the form/modal** - Navigate back to the same form
4. **Verify the value persisted** - Check that the saved value is still there
5. **Test with different values** - Try multiple test values to ensure consistency
6. **Check for navigation issues** - Ensure the form doesn't close prematurely or navigate away unexpectedly
7. **Verify backend API calls** - Check that the correct API endpoints are being called with the right data

### 🚨 CRITICAL: Playwright MCP Troubleshooting

**When MCP shows "Not connected" or "error" messages:**

1. **✅ IMMEDIATE SOLUTION: Switch to Direct Playwright Scripts**
   - Create `playwright/tests/feature-name-test.js`
   - Use `import { chromium } from 'playwright'`
   - Use `chromium.launch()` instead of MCP commands
   - Run with `node playwright/tests/feature-name-test.js`

2. **✅ ALTERNATIVE: Manual API Testing**
   - Use curl/HTTP requests to test backend endpoints
   - Create simple HTML test pages for frontend testing
   - Use browser developer tools to check console errors

3. **✅ FALLBACK: Hybrid Approach**
   - Test API endpoints with curl to get working links
   - Create test HTML page to verify frontend functionality
   - Provide working links for manual testing

**Never get stuck on MCP connection issues - always have a backup plan!**

### 🚨 CRITICAL: Form Debugging Protocol

**When testing forms, ALWAYS follow this systematic debugging process:**

1. **🔍 SYSTEMATICALLY INSPECT ALL FORM FIELDS FIRST**
   ```javascript
   // Get all form fields and inspect them
   const allInputs = await page.locator('input, select, textarea').all();
   console.log(`Found ${allInputs.length} form fields:`);
   for (let i = 0; i < allInputs.length; i++) {
     const field = allInputs[i];
     const type = await field.getAttribute('type');
     const name = await field.getAttribute('name');
     const placeholder = await field.getAttribute('placeholder');
     const required = await field.getAttribute('required');
     const value = await field.inputValue();
     console.log(`  Field ${i + 1}: type=${type}, name=${name}, placeholder=${placeholder}, required=${required}, value="${value}"`);
   }
   ```

2. **🔍 CHECK FORM VALIDATION STATE**
   ```javascript
   // Check for validation errors
   const validationErrors = await page.locator('.error, .invalid, [aria-invalid="true"]').all();
   if (validationErrors.length > 0) {
     console.log('❌ Form validation errors found:');
     for (let error of validationErrors) {
       console.log(`  - ${await error.textContent()}`);
     }
   }
   ```

3. **🔍 VERIFY FORM SUBMISSION READINESS**
   ```javascript
   // Check if submit button is enabled
   const submitButton = page.locator('button[type="submit"], button:has-text("Send")');
   const isEnabled = await submitButton.isEnabled();
   console.log(`Submit button enabled: ${isEnabled}`);
   
   // Check if all required fields are filled
   const requiredFields = await page.locator('input[required], select[required], textarea[required]').all();
   for (let field of requiredFields) {
     const value = await field.inputValue();
     const isEmpty = !value || value.trim() === '';
     console.log(`Required field ${await field.getAttribute('name')}: ${isEmpty ? 'EMPTY' : 'FILLED'}`);
   }
   ```

4. **🔍 MONITOR NETWORK REQUESTS SYSTEMATICALLY**
   ```javascript
   // Track all requests and responses
   const requests = [];
   const responses = [];
   
   page.on('request', request => {
     if (request.url().includes('your-endpoint')) {
       console.log('📤 REQUEST:', request.method(), request.url());
       if (request.postData()) {
         console.log('📤 Body:', request.postData());
       }
       requests.push(request);
     }
   });
   
   page.on('response', response => {
     if (response.url().includes('your-endpoint')) {
       console.log('📥 RESPONSE:', response.status(), response.url());
       if (response.status() >= 400) {
         console.log('❌ ERROR RESPONSE - Status:', response.status());
       }
       responses.push(response);
     }
   });
   ```

**🚨 CRITICAL DEBUGGING SEQUENCE:**
1. **First**: Check if all form fields are being filled correctly
2. **Second**: Check if form validation is preventing submission  
3. **Third**: Check if the form submission is actually working (POST request made)
4. **Fourth**: Check if the backend is processing the request correctly (response status)

**❌ NEVER jump to step 4 (backend error) without properly verifying steps 1-3!**

### 🚨 CRITICAL: Common Testing Mistakes to Avoid

**Based on real testing failures, NEVER make these assumptions:**

1. **❌ DON'T assume fields are visible immediately** - Always scroll through modals/forms completely
2. **❌ DON'T assume a field is hidden due to data conditions** - It might just be below the fold
3. **❌ DON'T conclude a feature is broken** - Without testing the complete user journey (set → save → reopen → verify)
4. **❌ DON'T make assumptions about UI layout** - Always explore all possible UI elements and layouts
5. **❌ DON'T stop testing after finding one issue** - Continue the full test to identify the root cause
6. **❌ DON'T assume data persistence works** - Always verify by reopening the form/modal
7. **❌ DON'T assume navigation works as expected** - Test that forms don't close prematurely or navigate away
8. **❌ DON'T get stuck on MCP connection issues** - Always switch to direct Playwright scripts when MCP fails
9. **❌ DON'T assume form submission is broken** - Without systematically checking all form fields, validation, and network requests first
10. **❌ DON'T assume buttons are disabled** - ALWAYS attempt to click before concluding they're disabled
11. **❌ DON'T assume UI state without verification** - Always verify actual UI state before making conclusions

**✅ DO these things instead:**

1. **✅ ALWAYS scroll through entire modals/forms** - Use `page.evaluate()` to scroll within containers
2. **✅ ALWAYS test the complete user journey** - Set value → Save → Reopen → Verify persistence
3. **✅ ALWAYS verify field presence before testing functionality** - Don't assume fields are hidden
4. **✅ ALWAYS check for multiple UI layout possibilities** - DataGrids, tables, cards, modals, etc.
5. **✅ ALWAYS test data persistence thoroughly** - Verify values are actually saved and retrieved
6. **✅ ALWAYS ask for clarification when uncertain** - Don't make assumptions about UI behavior
7. **✅ ALWAYS be systematic in testing** - Follow a consistent testing protocol every time
8. **✅ ALWAYS attempt to click buttons before concluding they're disabled** - Test actual functionality
9. **✅ ALWAYS verify UI state through action, not assumption** - Click, type, interact before concluding state

### 🚨 CRITICAL: UI State Verification Protocol

**ALWAYS follow this protocol when encountering UI elements that appear non-functional:**

1. **🔍 VISUAL INSPECTION FIRST**
   ```javascript
   // Check if button appears disabled visually
   const button = page.locator('button:has-text("Continue to Password Setup")');
   const isVisible = await button.isVisible();
   const isEnabled = await button.isEnabled();
   console.log(`Button visible: ${isVisible}, enabled: ${isEnabled}`);
   ```

2. **🔍 ATTEMPT INTERACTION BEFORE CONCLUSION**
   ```javascript
   // ALWAYS try to click before concluding it's disabled
   try {
     await button.click();
     console.log('✅ Button was clickable - not disabled');
   } catch (error) {
     console.log('❌ Button click failed:', error.message);
   }
   ```

3. **🔍 CHECK FOR DISABLED ATTRIBUTES**
   ```javascript
   // Check for disabled attribute
   const disabled = await button.getAttribute('disabled');
   const ariaDisabled = await button.getAttribute('aria-disabled');
   console.log(`Disabled attribute: ${disabled}, aria-disabled: ${ariaDisabled}`);
   ```

4. **🔍 VERIFY ACTUAL UI STATE**
   ```javascript
   // Check computed styles if needed
   const computedStyle = await button.evaluate(el => {
     return window.getComputedStyle(el);
   });
   console.log('Button opacity:', computedStyle.opacity);
   console.log('Button cursor:', computedStyle.cursor);
   ```

**🚨 CRITICAL RULE: NEVER conclude a button is disabled without attempting to click it first!**

### 🚨 CRITICAL: Real-World Testing Example - HireDate Field

**This is a real example of how NOT to test and how to test correctly:**

**❌ WRONG APPROACH (What I did wrong):**
1. Opened edit modal
2. Checked if HireDate field was immediately visible
3. When not visible, assumed it was hidden due to missing GroupId
4. Concluded the feature was working as designed
5. **MISSED THE ACTUAL BUG** - The field was there but required scrolling

**✅ CORRECT APPROACH (What I should have done):**
1. Opened edit modal
2. **Scrolled through the entire modal** to find all fields
3. Found the HireDate field (it was below the fold)
4. Set a test value and saved
5. **Reopened the modal and scrolled again** to verify persistence
6. **Discovered the real bug** - The value wasn't persisting

**Key Lesson:** Always test the complete user journey, including scrolling through all content areas.

### 🚨 CRITICAL: Real-World Testing Example - Button Clicking Mistake

**This is a real example of how NOT to test buttons and how to test correctly:**

**❌ WRONG APPROACH (What I did wrong):**
1. Saw a button that appeared to be disabled
2. Assumed it was disabled without attempting to click
3. Concluded the feature was broken
4. **MISSED THE ACTUAL ISSUE** - The button was clickable, I just didn't try

**✅ CORRECT APPROACH (What I should have done):**
1. Saw a button that appeared to be disabled
2. **Attempted to click the button first** before making any conclusions
3. Discovered the button was actually clickable
4. **Continued with the actual testing** instead of getting stuck on false assumptions

**Key Lesson:** Always attempt to interact with UI elements before concluding they're non-functional. "It's not disabled, you just didn't click it" is a critical reminder to test actual functionality, not just visual appearance.

### Test Account Credentials
When testing with Playwright MCP, use these login credentials:

- **System Admin Portal**: `sysadmin@open-enroll.com` / `testpass`
- **Tenant Admin Portal**: `tenant@open-enroll.com` / `testpass`
- **Agent Portal**: `agent@open-enroll.com` / `testpass`
- **Group Admin Portal**: `groupadmin@open-enroll.com` / `testpass`
- **Member Portal**: `member@open-enroll.com` / `testpass`

**🚨 CRITICAL: If you don't know which login to test with, ASK THE USER!**
- Different features may require different user roles
- Some features only work for specific user types (Agent, TenantAdmin, SysAdmin)
- Always clarify the testing requirements before starting
- Don't assume which account to use - ask for guidance

### Playwright MCP Testing Examples

```markdown
## Example Testing Commands:

1. **"Navigate to http://localhost:5173 and test the login flow"**
2. **"Login as tenant@open-enroll.com and navigate to the user management page"**
3. **"Fill out the user creation form and verify the user is created"**
4. **"Test the enrollment wizard by completing a full enrollment"**
5. **"Verify the agent dashboard loads all member data correctly"**
6. **"Test error handling by submitting invalid form data"**
7. **"Take a screenshot of the completed feature for documentation"**
```

## Completion Criteria

### Functional Requirements
- ✅ All specified functionality implemented
- ✅ All user stories completed
- ✅ All acceptance criteria met
- ✅ All edge cases handled
- ✅ All error scenarios covered

### Technical Requirements
- ✅ All Playwright MCP tests completed and passing
- ✅ Manual testing completed with real data using Playwright MCP
- ✅ No console errors
- ✅ No linting errors
- ✅ No TypeScript errors
- ✅ Proper error handling implemented
- ✅ Performance requirements met
- ✅ Public routes work without authentication
- ✅ Authenticated routes require proper authentication

### Quality Requirements
- ✅ Code follows established patterns
- ✅ UI follows design system
- ✅ Documentation updated
- ✅ Security requirements met
- ✅ Accessibility requirements met
- ✅ Performance optimized
- ✅ Real-world functionality verified with Playwright MCP

### Playwright MCP Documentation
- ✅ **Screenshots/videos generated** showing functionality working
- ✅ **Complete user flows tested** and documented
- ✅ **Error scenarios tested** and verified
- ✅ **Data persistence verified** through UI interactions

## Usage Instructions

### To Request a New Feature:
```
"Build a new feature for OpenEnroll using the playwright_yolo_feature.prompt.md protocol. The feature should [describe feature requirements]. Follow all development rules, test with Playwright MCP, and ensure everything works perfectly before considering complete."

Reference guides:
- @platform-navigation-guide.md for navigation patterns
- @common-data-loading-issues.md for debugging data problems
- @backend-system.md for backend development patterns
```

### What I'll Do:
1. **Analyze requirements** and plan the feature
2. **Develop backend** components (database, API, business logic)
3. **Develop frontend** components (UI, services, hooks)
4. **Test with Playwright MCP** - Navigate, interact, and verify functionality
5. **Login and manually verify** functionality works as expected
6. **Test complete user flows** using Playwright MCP
7. **Verify data persistence** through UI interactions
8. **Take screenshots/videos** for documentation
9. **Optimize performance** and user experience
10. **Update documentation** and provide completion report

### Playwright MCP Testing Workflow:
1. **Start servers** - Ensure backend and frontend are running
2. **Navigate to application** - Use Playwright to go to localhost:5173
3. **Test login flow** - Use Playwright to login with test accounts
4. **Test feature functionality** - Use Playwright to interact with new features
5. **Verify data persistence** - Use Playwright to check that data is saved
6. **Test error handling** - Use Playwright to test error scenarios
7. **Take documentation screenshots** - Use Playwright to capture functionality
8. **Verify complete user flows** - Use Playwright to test end-to-end workflows

**🚨 CRITICAL: File Organization**
- **All test files** go in `playwright/tests/` directory
- **All screenshots** go in `playwright/screenshots/` directory  
- **All debug files** go in `playwright/debug/` directory
- **All reports** go in `playwright/reports/` directory
- **Never clutter project root** with test files or screenshots

## Database Access and Schema Requirements

**CRITICAL:** I have direct read-only database access for real-time schema discovery and data verification.

**Database Access:**
- **Server**: `pvt-sql-server.database.windows.net`
- **Database**: `open-enroll`
- **User**: `readonly_user`
- **Password**: `Read_Only_AI735!?@`

**Database Schema Script:**
- **Script**: `./ai_scripts/db-schema.sh` - Complete database schema extraction
- **Usage**: `./ai_scripts/db-schema.sh` (all tables) or `./ai_scripts/db-schema.sh TableName` (specific table)

## Shell Scripts for Development & Testing

**CRITICAL**: Use these shell scripts for efficient development and testing:

### Server Management:
- **`./test-management.sh status`** - Check server status
- **🚨 CRITICAL: NEVER restart servers without explicit permission** - Always ask user before using start/stop/restart commands
- **🚨 If backend needs restart, ask user first** - "The backend needs to be restarted to apply changes. May I restart it?"

### Database Operations:
- **`./ai_scripts/db-schema.sh`** - Database schema extraction
- **`./ai_scripts/db-query.sh`** - Direct database queries

## Breaking Changes Warning
- **If any changes might break existing features**, I will document these in the final completion report
- **WARNING notes** will be included for any potentially breaking changes
- **Impact assessment** will be provided for any modifications that could affect other parts of the system

## Success Criteria

### Development Success:
- ✅ All requirements implemented
- ✅ All Playwright MCP tests passing
- ✅ No errors or warnings
- ✅ Proper error handling
- ✅ Performance optimized
- ✅ Documentation updated

### Testing Success:
- ✅ 100% Playwright MCP test coverage
- ✅ All user flows tested with Playwright MCP
- ✅ All edge cases tested with Playwright MCP
- ✅ All error scenarios tested with Playwright MCP
- ✅ Performance requirements met
- ✅ Security requirements met

### Final Deliverables:
- **Complete feature** with all functionality
- **Playwright MCP test documentation** with screenshots/videos
- **Updated documentation** for the feature
- **Performance optimizations** implemented
- **Quality assurance** completed with Playwright MCP

## Important Guidelines

### Command Execution
- **Never run commands that will hang or get stuck** unless I know how to exit them
- **Use background processes** for long-running commands when appropriate
- **Test commands safely** before running them in production
- **🚨 CRITICAL: NEVER restart servers without permission** - Always ask user before using start/stop/restart commands

### Database Query Validation (CRITICAL)
- **🚨 ALWAYS use `db-query.sh` to validate database queries** before implementing them in code
- **🚨 Test queries with actual data** using `./ai_scripts/db-query.sh "SELECT * FROM table"`
- **🚨 Verify query results match expected data** before writing API endpoints

### Backend Testing & Debugging Protocol (CRITICAL)

**🚨 NEVER use curl for testing authenticated endpoints - Use Playwright instead**

**Why curl fails:**
- Most API endpoints require authentication tokens
- curl requests don't have session cookies or JWT tokens
- Authentication headers are complex to set up manually
- You'll get 401/403 errors instead of seeing the actual functionality

**✅ CORRECT Backend Testing Approach:**

1. **Use Playwright APIRequestContext for direct API testing**
   ```javascript
   // Create direct API test using Playwright's APIRequestContext
   const { chromium } = require('playwright');
   
   async function testAPI() {
     const browser = await chromium.launch({ headless: false });
     const context = await browser.newContext();
     const page = await context.newPage();
     
     // Test API endpoint directly
     const response = await page.request.get(
       'http://localhost:3001/api/your-endpoint',
       {
         params: { param1: 'value1' }
       }
     );
     
     console.log('Response status:', response.status());
     const data = await response.json();
     console.log('Response data:', data);
     
     await browser.close();
   }
   ```

2. **Use Playwright to test API endpoints through the frontend**
   - Frontend automatically handles authentication
   - Frontend makes proper API calls with correct headers
   - Playwright can capture network requests and responses
   - You can see actual error messages in the UI

3. **Forward backend errors to frontend for Playwright visibility**
   ```javascript
   // Backend - Include detailed error info in responses
   catch (error) {
     console.error('❌ Error:', error);
     res.status(500).json({
       success: false,
       message: 'Server error while processing request',
       error: {
         message: error.message,
         code: error.code || 'UNKNOWN_ERROR',
         stack: error.stack,
         details: 'Check backend logs for full details'
       }
     });
   }
   ```

   **🚨 CRITICAL: This pattern allows Playwright to see backend errors through frontend responses**
   - Backend errors are forwarded to frontend as JSON responses
   - Playwright can capture these error responses in network logs
   - No need to access backend logs directly - errors appear in frontend
   - Essential for debugging backend issues through Playwright testing

4. **Use @db-query.sh for direct database testing**
   ```bash
   # Test queries directly against the database
   ./ai_scripts/db-query.sh "SELECT * FROM oe.Members WHERE Status = 'Active'"
   ./ai_scripts/db-query.sh "SELECT * FROM oe.EnrollmentLinks WHERE LinkToken = 'test123'"
   ```

5. **Playwright can capture backend errors through frontend**
   ```javascript
   // In Playwright test - capture network responses
   page.on('response', response => {
     if (!response.ok()) {
       console.log(`❌ Failed API call: ${response.url()} - ${response.status()}`);
       response.text().then(body => {
         console.log('Response body:', body);
       });
     }
   });
   ```

6. **For backend logs, use terminal monitoring**
   ```bash
   # Monitor backend logs in real-time
   tail -f backend/backend.log
   # Or check specific log files
   cat backend/backend.log | grep "ERROR\|WARN"
   ```

**🚨 CRITICAL: Backend Logs vs. Backend Errors**

- **Backend Errors (API responses):** ✅ **Can be captured by Playwright** - Use APIRequestContext or frontend testing
- **Backend Logs (console.log, console.error):** ❌ **Cannot be captured by Playwright** - Use terminal monitoring or log files
- **Database Queries:** ✅ **Can be tested directly** - Use `@db-query.sh` for validation

**🚨 CRITICAL: Backend Error Debugging Workflow**

1. **First**: Use `@db-query.sh` to test SQL queries directly
2. **Second**: Use Playwright APIRequestContext to test API endpoints directly
3. **Third**: Use Playwright to test the full frontend flow
4. **Fourth**: Check Playwright console logs for API errors
5. **Fifth**: Modify backend to include detailed error info in responses
6. **Sixth**: Use Playwright to see the detailed error messages

**🚨 CRITICAL: New Playwright APIRequestContext Approach**

**Benefits of APIRequestContext:**
- ✅ **Direct API testing** without frontend complexity
- ✅ **No authentication setup needed** for public endpoints
- ✅ **Faster testing** than full browser automation
- ✅ **Better error isolation** - can test specific endpoints
- ✅ **Works with multiple instances** - no MCP conflicts

**When to use APIRequestContext vs. Frontend Testing:**
- **Use APIRequestContext for:** Direct API endpoint testing, debugging specific endpoints, testing public endpoints
- **Use Frontend Testing for:** Full user workflows, authentication-dependent features, UI integration testing

**Example APIRequestContext Test:**
```javascript
// playwright/tests/api-test.js
const { chromium } = require('playwright');

async function testPricingAPI() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    // Test API endpoint directly
    const response = await page.request.get(
      'http://localhost:3001/api/enrollment-links/test123/product-pricing-v2',
      {
        params: {
          memberAge: '26',
          tobaccoUse: 'No',
          memberTier: 'EE'
        }
      }
    );
    
    console.log('Response status:', response.status());
    
    if (response.ok()) {
      const data = await response.json();
      console.log('Response data:', JSON.stringify(data, null, 2));
    } else {
      console.log('Error response:', await response.text());
    }
    
  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await browser.close();
  }
}

testPricingAPI();
```

**❌ NEVER do this:**
- Use curl to test authenticated endpoints
- Assume backend errors without seeing them in Playwright
- Debug backend issues without using the database query script

**✅ ALWAYS do this:**
- Use Playwright to test through the frontend
- Use `@db-query.sh` to validate database queries
- Forward backend errors to frontend for visibility
- Test the complete user flow, not just individual endpoints

### 🚨 CRITICAL: Backend Error Message Analysis Protocol

**When you see backend errors in Playwright, ALWAYS analyze the FULL error message:**

1. **🔍 CAPTURE COMPLETE ERROR CONTEXT**
   ```javascript
   // In Playwright test - capture detailed error responses
   page.on('response', response => {
     if (!response.ok()) {
       console.log(`❌ Failed API call: ${response.url()} - ${response.status()}`);
       response.text().then(body => {
         console.log('❌ Full error response:', body);
         try {
           const errorData = JSON.parse(body);
           console.log('❌ Parsed error data:', errorData);
           if (errorData.error) {
             console.log('❌ Error details:', errorData.error);
             console.log('❌ Error stack:', errorData.error.stack);
           }
         } catch (e) {
           console.log('❌ Raw error body:', body);
         }
       });
     }
   });
   ```

2. **🔍 ANALYZE ERROR PATTERNS SYSTEMATICALLY**
   - **Line numbers**: Look for "lineNumber: X" in error messages
   - **Query context**: Identify which SQL query is failing
   - **Database connection**: Check if it's a connection vs query issue
   - **Syntax errors**: Look for "SyntaxError" or "Unexpected identifier"
   - **Route registration**: Check if routes are loading properly

3. **🔍 VERIFY BACKEND ROUTE LOADING**
   ```bash
   # Check if backend routes are loading properly
   node -c backend/routes/your-route-file.js
   # Look for syntax errors that prevent route registration
   ```

4. **🔍 TEST DATABASE QUERIES DIRECTLY**
   ```bash
   # Test the exact query that's failing
   ./ai_scripts/db-query.sh "SELECT m.MemberId, u.FirstName FROM oe.Members m INNER JOIN oe.Users u ON m.UserId = u.UserId"
   ```

5. **🔍 CHECK FOR DUPLICATE CODE**
   - Look for duplicate function declarations
   - Check for duplicate variable names
   - Verify proper function closing braces
   - Ensure no syntax errors prevent route loading

**🚨 CRITICAL: Error Analysis Checklist**

When you see a backend error, ask these questions:

1. **Is this a database query error?** → Use `@db-query.sh` to test the query
2. **Is this a syntax error?** → Check `node -c` on the backend file
3. **Is this a route loading error?** → Check if routes are registered properly
4. **Is this a duplicate code error?** → Look for duplicate declarations
5. **Is this a connection error?** → Check database connection details

**❌ NEVER assume the error type without analyzing the full context!**

**✅ ALWAYS follow this systematic approach:**
1. Capture the complete error message in Playwright
2. Analyze the error pattern (syntax, query, connection, etc.)
3. Test the specific failing component directly
4. Fix the root cause, not just the symptom
5. Verify the fix works through Playwright testing

### Security & Authentication
- **Never bypass security measures** or authentication systems
- **Request permission** before making any changes to authentication/authorization
- **Maintain existing security patterns** and don't weaken security

### Design & Styling
- **Follow existing design patterns** from the codebase
- **Use Tailwind CSS classes** as defined in the theme system
- **Maintain UI consistency** with established component patterns

## Notes
- This development process is designed to be thorough and complete
- I will work autonomously until the feature is perfect
- All code will follow established patterns and best practices
- The goal is to deliver a production-ready feature
- **Playwright MCP replaces all manual testing and Cypress test writing**

