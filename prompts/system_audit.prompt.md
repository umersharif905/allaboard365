# OpenEnroll System Audit Protocol

## Overview
This prompt defines the complete system audit process for OpenEnroll, including comprehensive testing, detailed reporting, and autonomous fixing phases. Use this when you want a complete system audit and want me to fix all issues until everything is perfect.

## Audit Scope

### User Portals
- **SysAdmin Portal** - System administration, tenant management, user management
- **TenantAdmin Portal** - Group management, agent management, billing, reports
- **Agent Portal** - Group management, member management, commissions, enrollment links
- **GroupAdmin Portal** - Group member management, group settings, group reports
- **Member Portal** - Enrollment wizard, dependent management, benefits viewing

### Features & Functionality
- **Group Onboarding System** - Group creation, onboarding links, completion flow
- **Enrollment System** - All enrollment types, product selection, pricing, acknowledgements
- **Commission System** - Commission calculations, rule management, reporting
- **User Management** - Authentication, authorization, role-based access
- **Data Management** - CRUD operations, data validation, persistence

### Technical Areas
- **API Consistency** - Endpoint responses, error handling, data formats
- **UI/UX Consistency** - Design patterns, component usage, responsive design
- **Performance** - Loading states, data fetching, optimization
- **Error Handling** - Graceful failures, user feedback, recovery
- **Security** - Authentication, authorization, data protection

## Development Rules

### Backend Development
- **🚨 CRITICAL: Follow @backend-system.md patterns** - This is MANDATORY for all backend-to-frontend communication
- **🚨 NEVER deviate from @backend-system.md** - It contains critical security, routing, and API patterns
- **🚨 ALWAYS reference @backend-system.md** - Essential instructions for all backend development
- **Use proper authentication/authorization** - Implement role-based access control
- **Follow database patterns** - Use existing schema and naming conventions
- **Implement proper error handling** - Return consistent error responses
- **Use proper logging** - Log all important operations and errors
- **Follow security best practices** - Validate inputs, sanitize data, prevent SQL injection

## Testing Strategy

### 🎯 What "Comprehensive Tests" Means
- **Comprehensive = Complete coverage of YOUR new features**
- **NOT comprehensive = Testing the entire codebase**
- **Focus on**: The specific features listed in TASK_EXECUTION_PLAN.md for this session
- **Test**: All user flows, edge cases, and error scenarios for YOUR features
- **Efficiency**: Test what you built, not what already exists
- **Reference**: Always check TASK_EXECUTION_PLAN.md to see what features were requested/built

### 🚨 CRITICAL: FULL FUNCTIONALITY TESTING (NOT JUST PAGE LOADING)
- **NEVER just test page loading** - Pages loading ≠ functionality working
- **NEVER just test component existence** - Components existing ≠ features working
- **ALWAYS test complete user workflows** - Login → Navigate → Interact → Submit → Verify Results
- **ALWAYS test form submissions** - Forms must actually submit and save data
- **ALWAYS verify data persistence** - Check database after operations
- **ALWAYS test success states** - Verify success messages and UI updates
- **ALWAYS test error handling** - Verify error states work correctly
- **ALWAYS test with real data** - Use actual user accounts and database
- **ALWAYS verify backend integration** - Check that frontend and backend work together

### Cypress End-to-End Tests
```typescript
// Example test structure I'll create
describe('Complete System Audit', () => {
  describe('User Authentication', () => {
    it('should handle login for all user types');
    it('should enforce proper authorization');
    it('should handle session management');
  });
  
  describe('Portal Functionality', () => {
    it('should test all SysAdmin functions');
    it('should test all TenantAdmin functions');
    it('should test all Agent functions');
    it('should test all GroupAdmin functions');
    it('should test all Member functions');
  });
  
  describe('Feature Completeness', () => {
    it('should test group onboarding flow');
    it('should test enrollment wizard');
    it('should test commission system');
    it('should test user management');
  });
  
  describe('Form Submission & Data Persistence', () => {
    it('should submit all forms successfully');
    it('should save data to database');
    it('should display success messages');
    it('should update UI after successful operations');
    it('should handle form validation errors');
    it('should handle server errors (500/400) gracefully');
  });
  
  describe('Edge Cases & Error Handling', () => {
    it('should handle expired links');
    it('should validate all form inputs');
    it('should handle network failures');
    it('should manage concurrent users');
  });
});
```

### Test Categories
1. **Functional Tests** - Core functionality works as expected
2. **Integration Tests** - Components work together correctly
3. **UI Tests** - User interface behaves correctly
4. **API Tests** - Backend endpoints respond correctly
5. **Security Tests** - Authentication and authorization work
6. **Performance Tests** - System responds within acceptable time
7. **Error Handling Tests** - Graceful failure and recovery
8. **Edge Case Tests** - Boundary conditions and unusual inputs
9. **Form Submission Tests** - Forms actually submit and work
10. **Data Persistence Tests** - Data is actually saved/created
11. **Success State Tests** - Success messages and UI updates work
12. **Backend Log Tests** - Check for 500/400 errors during testing

## Report Generation

### Executive Summary
- Total tests executed
- Pass/fail rates
- Critical issues count
- Minor issues count
- Overall system health score

### Critical Issues (Must Fix)
- Issues that break core functionality
- Security vulnerabilities
- Data integrity problems
- User experience blockers

### Minor Issues (Should Fix)
- UI/UX improvements
- Performance optimizations
- Code quality improvements
- Documentation updates

### Visual Documentation
- Screenshots of all issues
- Videos of failing tests
- Before/after comparisons
- UI consistency problems

### Technical Details
- Step-by-step reproduction steps
- Error messages and stack traces
- Network request/response logs
- Console error logs
- Performance metrics

## Autonomous Fixing Phase

### Phase 1: Critical Issues
1. **Identify** all critical issues from audit report
2. **Prioritize** by impact and severity
3. **Fix** each issue systematically
4. **Test** after each fix to verify resolution
5. **Document** changes made

### Phase 2: Minor Issues
1. **Address** UI/UX improvements
2. **Optimize** performance bottlenecks
3. **Improve** code quality
4. **Update** documentation
5. **Test** all changes

### Phase 3: Final Validation
1. **Run** complete test suite
2. **Verify** 100% pass rate
3. **Check** for regressions
4. **Validate** all user flows
5. **Generate** final completion report

### Quality Assurance
- **Continuous Testing** - Run tests after every change
- **Regression Prevention** - Ensure fixes don't break other features
- **Performance Monitoring** - Track system performance improvements
- **User Experience** - Verify all user flows work smoothly
- **Documentation** - Update all relevant documentation

## Usage Instructions

### To Request a System Audit:
```
"Run a complete system audit of OpenEnroll using the system_audit.prompt.md protocol. Test every portal, every feature, every edge case. Generate a comprehensive report and then fix all issues until everything is perfect."
```

### What I'll Do:
1. **Create comprehensive test suite** covering all areas
2. **Execute all tests** and capture results
3. **Generate detailed audit report** with findings
4. **Wait for your approval** of the report
5. **Autonomously fix all issues** until 100% pass rate
6. **Generate final completion report** showing all improvements

### Expected Timeline:
- **Audit Phase**: 2-4 hours (depending on system complexity)
- **Fixing Phase**: 4-8 hours (depending on number of issues)
- **Total**: 6-12 hours for complete system audit and fixes

## Success Criteria

### Audit Phase Success:
- ✅ All portals tested
- ✅ All features tested
- ✅ All edge cases tested
- ✅ Comprehensive report generated
- ✅ Clear action items identified

### Fixing Phase Success:
- ✅ All critical issues resolved
- ✅ All minor issues addressed
- ✅ 100% test pass rate achieved
- ✅ No regressions introduced
- ✅ System performance improved
- ✅ User experience enhanced

### Final Deliverables:
- **Complete test suite** for ongoing use
- **Fixed system** with all issues resolved
- **Documentation** of all changes made
- **Performance improvements** implemented
- **Quality assurance** processes established

## Important Guidelines

### Command Execution
- **Never run commands that will hang or get stuck** unless I know how to exit them
- **Use background processes** for long-running commands when appropriate
- **Test commands safely** before running them in production
- **Use non-interactive flags** for commands that might require user input

### Security & Authentication
- **Never bypass security measures** or authentication systems
- **Request permission** before making any changes to authentication/authorization
- **Maintain existing security patterns** and don't weaken security
- **Follow established security best practices** throughout the codebase

### Design & Styling
- **Follow existing design patterns** from the codebase
- **Use theme.css** for all styling - leverage existing CSS custom properties and utility classes
- **Maintain UI consistency** with established component patterns
- **Use Tailwind CSS classes** as defined in the theme system
- **Follow the established color palette** and design tokens

## Task Management & Reporting

### Multi-Task Execution
When given multiple audit tasks, I will:
1. **Research database schemas** - use `database-schema.sql` as the single source of truth for all database structure
2. **Research backend-system.md** - understand all critical patterns for backend-to-frontend communication
3. **Create a master task file** (`AUDIT_EXECUTION_PLAN.md`) at the project root level to track all tasks
2. **Prioritize tasks** by importance and dependencies
3. **Work through each task systematically** without interruption
4. **Update progress** after each task completion
5. **Generate individual reports** for each task
6. **Create final summary** with all results

### Master Task File Structure
```markdown
# OpenEnroll Audit Execution Plan

## Audit Task List
1. [ ] Task 1: [Description]
2. [ ] Task 2: [Description]
[... continue for all tasks]

## Progress Tracking
- Started: [Timestamp]
- Current Task: [Task Number]
- Completed: [Count]/Total
- Remaining: [Count]/Total

## Task Details
### Task 1: [Name]
- Status: [Not Started/In Progress/Completed]
- Tests Created: [List]
- Issues Found: [List]
- Fixes Applied: [List]
- Notes: [Any important notes]
[... continue for all tasks]

## Breaking Changes Warnings
### ⚠️ Potential Breaking Changes
- **Change 1**: [Description of change and potential impact]
- **Change 2**: [Description of change and potential impact]
- **Testing Required**: [Specific areas that need additional testing]

## Final Summary
- Total tasks completed: X/Total
- Total time spent: X hours
- Issues found: [Count]
- Issues fixed: [Count]
- Tests created: [Count]
- Breaking changes documented: [Count]
- Recommendations: [List]
```

### Audit Report Structure
At the end of each audit task, I will generate:

```markdown
# Audit Completion Report: [Audit Scope]

## Executive Summary
- Total tests executed: X
- Pass/fail rates: X% pass
- Critical issues found: X
- Minor issues found: X
- Overall system health score: X/10

## Critical Issues Found (Must Fix)
### Issue 1: [Title]
- **Description**: [What's wrong]
- **Impact**: [How it affects users/system]
- **Location**: [Where the issue is]
- **Steps to reproduce**: [How to see the issue]
- **Fix applied**: [What was done to fix it]
- **Test verification**: [How it was tested]

### Issue 2: [Title]
[... continue for all critical issues]

## Minor Issues Found (Should Fix)
### Issue 1: [Title]
- **Description**: [What could be improved]
- **Impact**: [Minor impact description]
- **Location**: [Where the issue is]
- **Improvement applied**: [What was done]
- **Test verification**: [How it was tested]

[... continue for all minor issues]

## Testing Results
### Test Coverage
- Total tests: X
- Passed: X (100%)
- Failed: 0
- Test execution time: X minutes

### Test Categories
- Functional tests: X tests
- Integration tests: X tests
- UI tests: X tests
- API tests: X tests
- Security tests: X tests
- Performance tests: X tests
- Error handling tests: X tests
- Edge case tests: X tests

## Fixes Applied
### Backend Fixes
- Files modified: [List]
- Database changes: [List]
- API improvements: [List]
- Security enhancements: [List]

### Frontend Fixes
- Components modified: [List]
- UI improvements: [List]
- Performance optimizations: [List]
- Error handling improvements: [List]

### Testing Improvements
- New tests created: [List]
- Test coverage improvements: [List]
- Test reliability improvements: [List]

## Confirmation Checklist
### System Health
- [ ] All critical issues resolved
- [ ] All minor issues addressed
- [ ] 100% test pass rate achieved
- [ ] No regressions introduced
- [ ] System performance improved
- [ ] User experience enhanced

### Technical Quality
- [ ] No console errors
- [ ] No linting errors
- [ ] No TypeScript errors
- [ ] All API endpoints working
- [ ] Database integrity maintained
- [ ] Security requirements met

### User Experience
- [ ] All portals working correctly
- [ ] All user roles functioning
- [ ] All features accessible
- [ ] Error handling improved
- [ ] Loading states working
- [ ] Responsive design maintained

### Testing
- [ ] All tests passing
- [ ] Test coverage adequate
- [ ] Edge cases tested
- [ ] Error scenarios tested
- [ ] Performance tested
- [ ] Security tested

## What to Look At for Confirmation
1. **Test all user portals** - [Specific portals and functions to test]
2. **Verify all user roles** - [Specific roles and permissions to test]
3. **Check all features** - [Specific features to test]
4. **Test error scenarios** - [Specific error cases to test]
5. **Verify performance** - [Specific performance metrics to check]
6. **Check responsive design** - [Specific breakpoints to test]
7. **Test security** - [Specific security scenarios to test]
8. **Verify data integrity** - [Specific data to check]
```

### Autonomous Execution Protocol
- **Work continuously** until all audit tasks are complete
- **Don't ask for confirmation** during audit and fixing phases
- **Only report when everything is done** and perfect
- **Provide comprehensive reports** for your review
- **Include confirmation checklists** for easy verification

## Test Account Credentials
When testing features, use these login credentials:

### Individual Role Accounts:
- **System Admin Portal**: `sysadmin@open-enroll.com` / `testpass`
- **Tenant Admin Portal**: `tenant@open-enroll.com` / `testpass`
- **Agent Portal**: `agent@open-enroll.com` / `testpass`
- **Group Admin Portal**: `groupadmin@open-enroll.com` / `testpass`
- **Member Portal**: `member@open-enroll.com` / `testpass`

### Multi-Role Account:
- **Multi-Role User**: `tenant@open-enroll.com` / `testpass`
  - **Roles**: TenantAdmin, Member, Agent
  - **Portal Switching**: Can switch between TenantAdmin, Member, and Agent portals using the portal dropdown in navigation
  - **Use for**: Testing role switching functionality and multi-role features

## Cypress Testing - Critical Testing Patterns
**CRITICAL**: Follow these essential testing patterns for reliable end-to-end testing.

### 🚨 CRITICAL: Proper Login Flow
**NEVER assume login state - always verify login completion before proceeding:**

```typescript
describe('Feature Test', () => {
  beforeEach(() => {
    // 1. Always start with explicit login
    cy.visit('/login');
    
    // 2. Wait for login form to be visible
    cy.get('#email', { timeout: 10000 }).should('be.visible').type('tenant@open-enroll.com');
    cy.get('#password', { timeout: 10000 }).should('be.visible').type('testpass');
    cy.get('button[type="submit"]', { timeout: 10000 }).should('be.visible').click();
    
    // 3. CRITICAL: Wait for successful redirect to dashboard
    cy.url().should('include', '/tenant-admin/dashboard', { timeout: 15000 });
    
    // 4. Use sidebar navigation instead of direct URL
    cy.get('nav', { timeout: 10000 }).should('be.visible').contains('User Management').click();
    
    // 5. Verify page loaded correctly
    cy.get('h1', { timeout: 10000 }).should('contain', 'User Management');
  });
});
```

### 🚨 CRITICAL: Modal Interaction Patterns
**When working with modals, always scope interactions properly:**

```typescript
it('should interact with modal correctly', () => {
  // 1. Open modal
  cy.get('button').contains('Add User').click();
  
  // 2. CRITICAL: Work within modal scope to avoid element conflicts
  cy.get('.fixed.inset-0').within(() => {
    // 3. Fill form fields within modal
    cy.get('input[type="text"]').first().type('John');
    cy.get('input[type="text"]').last().type('Doe');
    cy.get('input[type="email"]').type('john@example.com');
    
    // 4. Submit within modal
    cy.get('button').contains('Create User').click();
  });
  
  // 5. Wait for modal to close
  cy.get('h3').should('not.exist', { timeout: 10000 });
});
```

### 🚨 CRITICAL: Data Persistence Verification
**Always verify data is actually created and appears in UI:**

```typescript
it('should create data and verify it appears', () => {
  // 1. Get initial count
  cy.get('body').then(($body) => {
    const userCountMatch = $body.text().match(/Users \((\d+)\)/);
    const initialCount = userCountMatch ? parseInt(userCountMatch[1]) : 0;
    
    // 2. Create new item
    cy.get('button').contains('Add User').click();
    cy.get('.fixed.inset-0').within(() => {
      cy.get('input[type="text"]').first().type('Test');
      cy.get('input[type="text"]').last().type('User');
      cy.get('input[type="email"]').type('test@example.com');
      cy.get('button').contains('Create User').click();
    });
    
    // 3. Wait for modal to close
    cy.get('h3').should('not.exist', { timeout: 10000 });
    
    // 4. CRITICAL: Verify count increased
    cy.get('body', { timeout: 15000 }).should(($body) => {
      const newUserCountMatch = $body.text().match(/Users \((\d+)\)/);
      const newCount = newUserCountMatch ? parseInt(newUserCountMatch[1]) : 0;
      expect(newCount).to.be.greaterThan(initialCount);
    });
    
    // 5. CRITICAL: Verify item appears in table
    cy.get('table tbody').should('contain', 'Test User');
    cy.get('table tbody').should('contain', 'test@example.com');
  });
});
```

### 🚨 CRITICAL: Navigation Patterns
**Use sidebar navigation instead of direct URL navigation:**

```typescript
// ❌ WRONG: Direct URL navigation
cy.visit('/tenant-admin/users');

// ✅ CORRECT: Sidebar navigation after login
cy.get('nav').contains('User Management').click();
```

### 🚨 CRITICAL: Frontend State Management
**Avoid setTimeout delays - use proper async/await patterns:**

```typescript
// ❌ WRONG: setTimeout delays
setTimeout(async () => {
  await loadUsers();
}, 500);

// ✅ CORRECT: Immediate async execution
if (response.success) {
  setShowCreateModal(false);
  alert('User created successfully!');
  await loadUsers(); // Immediate execution
}
```

### Login Credentials (for manual entry):
- **Tenant Admin**: `tenant@open-enroll.com` / `testpass`
- **System Admin**: `sysadmin@open-enroll.com` / `testpass`
- **Agent**: `agent@open-enroll.com` / `testpass`
- **Group Admin**: `groupadmin@open-enroll.com` / `testpass`
- **Member**: `member@open-enroll.com` / `testpass`

## Shell Scripts for Audit & Testing

**CRITICAL**: Use these shell scripts for efficient auditing and testing:

### Server Management:
- **`./test-management.sh`** - Complete server and test management
  - `./test-management.sh start` - Start backend and frontend servers
  - `./test-management.sh stop` - Stop all servers
  - `./test-management.sh restart` - Restart servers
  - `./test-management.sh status` - Check server status
  - `./test-management.sh test [spec]` - Run all tests or specific test
  - `./test-management.sh test-login [spec]` - Run tests with login handling
  - `./test-management.sh clean` - Clean up logs and processes

### Incremental Testing:
- **`./incremental-test-runner.sh`** - Test one feature at a time
  - Tests features in priority order
  - Stops on first failure for immediate fixing
  - Provides detailed failure analysis
  - Prevents long test runs that delay feedback

### Database Operations (WORKING):
- **`./ai_scripts/db-schema.sh`** - Database schema extraction ✅ WORKING
  - `./ai_scripts/db-schema.sh` - Complete database schema
  - `./ai_scripts/db-schema.sh TableName` - Specific table schema (e.g., `./ai_scripts/db-schema.sh Products`)
- **`./ai_scripts/db-query.sh`** - Direct database queries ✅ WORKING
  - `./ai_scripts/db-query.sh "SELECT * FROM Users"` - Execute queries
  - `./ai_scripts/db-query.sh "SELECT TOP 3 ProductId, Name FROM oe.Products"` - Example query

**🚨 CRITICAL DATABASE CONNECTION NOTE:**
- **AI Scripts Location** - Database scripts are now in `ai_scripts/` directory with their own `.env` file
- **Shell scripts are fixed** - `./ai_scripts/db-schema.sh` and `./ai_scripts/db-query.sh` work from project root
- **Environment variables** - `.env` file is in `ai_scripts/` directory for AI script configuration
- **Node.js scripts** - Scripts automatically navigate to backend directory for MSSQL connections
- **Best practice** - Use the AI scripts from project root: `./ai_scripts/db-query.sh` and `./ai_scripts/db-schema.sh`

### Script Usage Guidelines:
- **Always use `./` prefix** (not `bash script.sh`)
- **Use incremental testing** for faster feedback loops
- **Stop on failures** to fix issues immediately
- **Coordinate with other AI instances** to avoid conflicts

### Account Management:
- **For new test accounts**: Ask user what credentials and roles are needed
- **For data modification**: Ask user for permission before modifying test data
- **For account creation**: Ask user for guidance on how to create new test accounts

### Database Access for Testing:
- **Direct database access**: I have read-only access to the database for real-time debugging
- **Server**: `pvt-sql-server.database.windows.net`
- **Database**: `open-enroll`
- **User**: `readonly_user`
- **Password**: `Read_Only_AI735!?@`
- **For data inspection**: I can run queries directly to investigate issues
- **For debugging**: I can check data changes in real-time during testing
- **For verification**: I can confirm data changes immediately after operations
- **For testing**: I can check test data setup and results instantly
- **For schema discovery**: I can query INFORMATION_SCHEMA for real-time table structures
- **Read-only permissions**: I can only SELECT data, cannot modify anything
- **Real-time feedback**: No more back-and-forth with SQL queries

## Notes
- This audit process is designed to be comprehensive and thorough
- I will work autonomously once you approve the audit report
- All fixes will be tested and verified before considering complete
- The goal is to achieve a perfect, bug-free system
- This process can be repeated as needed for ongoing quality assurance
- **I will not interrupt you until everything is complete and perfect**

## Database Access and Schema Requirements

**CRITICAL:** I have direct read-only database access for real-time schema discovery and data verification.

**Database Access:**
- **Server**: `pvt-sql-server.database.windows.net`
- **Database**: `open-enroll`
- **User**: `readonly_user`
- **Password**: `Read_Only_AI735!?@`
- **Connection**: Encrypted, read-only access

**Database Schema Script:**
- **Script**: `./ai_scripts/db-schema.sh` - Complete database schema extraction
- **Usage**: `./ai_scripts/db-schema.sh` (all tables) or `./ai_scripts/db-schema.sh TableName` (specific table)
- **Output**: Detailed schema with columns, data types, foreign keys, and stored procedures
- **Efficiency**: Use specific table name for faster, focused schema discovery

**Schema Discovery Process:**
- **Query INFORMATION_SCHEMA** for real-time column information
- **Discover relationships** through foreign key queries
- **Verify data types** and constraints dynamically
- **Test queries** with actual data before implementation
- **No assumptions** - always query the live schema
- **Include stored procedures, functions, and views** in schema research

**Example Usage (WORKING):**
```bash
# Get complete database schema
./ai_scripts/db-schema.sh

# Get specific table schema (faster)
./ai_scripts/db-schema.sh Users
./ai_scripts/db-schema.sh Groups
./ai_scripts/db-schema.sh Members
./ai_scripts/db-schema.sh Products

# Execute database queries
./ai_scripts/db-query.sh "SELECT TOP 3 ProductId, Name FROM oe.Products"
./ai_scripts/db-query.sh "SELECT UserId, Email, FirstName, LastName FROM oe.Users WHERE Status = 'Active'"
```

**Example Schema Query:**
```sql
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_NAME = 'TableName' AND TABLE_SCHEMA = 'oe'
ORDER BY ORDINAL_POSITION
```

**Database Change Requirements:**
- **Document all database changes** in the completion report
- **Provide SQL scripts** for any schema modifications
- **Test changes** with actual data when possible

## Backend System Compliance (CRITICAL)
- **🚨 MANDATORY: Follow backend-system.md** for ALL backend-to-frontend communication
- **🚨 NEVER create endpoints** without following backend-system.md patterns
- **🚨 ALWAYS use proper authentication/authorization** as specified in backend-system.md
- **🚨 ALWAYS follow route mounting strategies** as specified in backend-system.md
- **🚨 ALWAYS use proper API response formats** as specified in backend-system.md
- **🚨 ALWAYS implement proper error handling** as specified in backend-system.md
- **🚨 ALWAYS use proper database patterns** as specified in backend-system.md
- **🚨 ALWAYS follow security patterns** as specified in backend-system.md

## Breaking Changes Warning
- **If any fixes might break existing features**, I will document these in the final completion report
- **WARNING notes** will be included in the master task file for any potentially breaking changes
- **Impact assessment** will be provided for any modifications that could affect other parts of the system
- **Testing recommendations** will be included for areas that might need additional verification

## Critical Testing Requirements (MUST FOLLOW)

### 🚨 CRITICAL: LOG EVALUATION & ERROR DETECTION
- **ALWAYS evaluate backend logs** during testing to catch errors immediately
- **ALWAYS check for JSON parsing errors** in backend responses
- **ALWAYS verify API response structure** matches frontend expectations
- **ALWAYS test with real data** to catch data type mismatches
- **ALWAYS check for undefined/null values** in query parameters
- **ALWAYS validate data persistence** by checking database after operations
- **ALWAYS use structured log evaluation** to detect issues automatically

### Form Testing Requirements
- **🚨 NEVER just test page loading** - Always test the actual functionality
- **🚨 ALWAYS test form submission** - Verify forms actually submit and work
- **🚨 ALWAYS verify data persistence** - Check that data is actually saved/created
- **🚨 ALWAYS test success states** - Verify success messages and UI updates
- **🚨 ALWAYS test error handling** - Verify error states are handled gracefully
- **🚨 ALWAYS check backend logs** - Look for 500/400 errors during testing

### User Creation Testing Requirements
- **🚨 ALWAYS test complete user creation flow** - Login → Navigate → Click "Add User" → Fill Form → Submit → Verify User Appears
- **🚨 ALWAYS verify new user appears in list** - Don't just check for success message
- **🚨 ALWAYS test with real data** - Use actual test accounts and verify in database
- **🚨 ALWAYS check for server errors** - Look for 500/400 errors in logs
- **🚨 ALWAYS test form validation** - Verify required fields and error messages

### Data Persistence Testing Requirements
- **🚨 ALWAYS verify data is saved** - Check database after operations
- **🚨 ALWAYS test CRUD operations** - Create, Read, Update, Delete
- **🚨 ALWAYS verify UI updates** - Check that lists/views update after changes
- **🚨 ALWAYS test with multiple users** - Verify data isolation and permissions

### Error Testing Requirements
- **🚨 ALWAYS test server errors** - 500, 400, 404, 403 errors
- **🚨 ALWAYS test network failures** - Timeout, connection issues
- **🚨 ALWAYS test validation errors** - Invalid inputs, required fields
- **🚨 ALWAYS test authorization errors** - Permission denied scenarios

### Self-Operation Protection Testing
- **🚨 ALWAYS test self-deletion prevention** - Users cannot delete their own accounts
- **🚨 ALWAYS test self-modification restrictions** - Users cannot modify their own critical settings
- **🚨 ALWAYS test role-based self-protection** - Multi-role users cannot remove their own access
- **🚨 ALWAYS verify proper error messages** - Clear feedback when self-operations are attempted
- **🚨 ALWAYS follow backend-system.md patterns** - Use established self-protection patterns

### Role-Based Operations Testing
- **🚨 ALWAYS test multi-role user handling** - Users with multiple roles are handled correctly
- **🚨 ALWAYS test role removal logic** - Only specific roles are removed, not entire users
- **🚨 ALWAYS test single-role user deletion** - Users with only one role are deleted completely
- **🚨 ALWAYS verify role updates persist** - Role changes are saved and reflected in UI
- **🚨 ALWAYS follow backend-system.md patterns** - Use established role-based operation patterns
