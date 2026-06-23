#!/bin/bash

# OpenEnroll Incremental Test Runner
# Tests one feature at a time, fixes issues, then moves to next

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test files in order of priority
TESTS=(
    "cypress/e2e/step3-configuration-fields.cy.ts"
    "cypress/e2e/group-onboarding-wizard.cy.ts"
    "cypress/e2e/vendor-documents.cy.ts"
    "cypress/e2e/asa-signing.cy.ts"
    "cypress/e2e/tenant-user-management.cy.ts"
    "cypress/e2e/group-admin-user-management.cy.ts"
    "cypress/e2e/agent-dashboard.cy.ts"
)

echo -e "${BLUE}🧪 OpenEnroll Incremental Test Runner${NC}"
echo -e "${BLUE}=====================================${NC}"

# Function to run a single test
run_single_test() {
    local test_file=$1
    echo -e "\n${YELLOW}🔍 Testing: $test_file${NC}"
    echo -e "${BLUE}----------------------------------------${NC}"
    
    # Run the specific test
    cd frontend
    npx cypress run --spec "$test_file" --browser chrome --headless
    
    local exit_code=$?
    cd ..
    
    if [ $exit_code -eq 0 ]; then
        echo -e "${GREEN}✅ $test_file - PASSED${NC}"
        return 0
    else
        echo -e "${RED}❌ $test_file - FAILED${NC}"
        echo -e "${YELLOW}📋 Check the output above for error details${NC}"
        return 1
    fi
}

# Function to show failure analysis
analyze_failure() {
    local test_file=$1
    echo -e "\n${RED}🔍 FAILURE ANALYSIS: $test_file${NC}"
    echo -e "${BLUE}=====================================${NC}"
    
    echo -e "${YELLOW}Common issues to check:${NC}"
    echo "1. Missing data-testid attributes in components"
    echo "2. Database schema mismatches"
    echo "3. API endpoint issues"
    echo "4. Authentication/authorization problems"
    echo "5. Component not rendering properly"
    
    echo -e "\n${YELLOW}Next steps:${NC}"
    echo "1. Review the test output above"
    echo "2. Check component implementation"
    echo "3. Verify database schema"
    echo "4. Fix the issues"
    echo "5. Re-run this test"
}

# Main execution
echo -e "${GREEN}Starting incremental testing...${NC}"

for test in "${TESTS[@]}"; do
    if run_single_test "$test"; then
        echo -e "${GREEN}✅ $test completed successfully${NC}"
    else
        analyze_failure "$test"
        echo -e "\n${RED}🛑 STOPPING: Fix the issues above before continuing${NC}"
        echo -e "${YELLOW}💡 Tip: Run './incremental-test-runner.sh' again after fixing issues${NC}"
        exit 1
    fi
done

echo -e "\n${GREEN}🎉 ALL TESTS PASSED!${NC}"
echo -e "${BLUE}All features are working correctly.${NC}"


