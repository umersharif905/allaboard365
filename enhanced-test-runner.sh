#!/bin/bash

# OpenEnroll Enhanced Test Runner with Detailed Logging
# Captures all logs, errors, and debugging information

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
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

echo -e "${BLUE}🧪 OpenEnroll Enhanced Test Runner${NC}"
echo -e "${BLUE}===================================${NC}"
echo -e "${CYAN}Enhanced logging and debugging enabled${NC}"

# Function to run a single test with enhanced logging
run_single_test() {
    local test_file=$1
    local log_file="test-logs/$(basename "$test_file" .cy.ts)-$(date +%Y%m%d-%H%M%S).log"
    
    echo -e "\n${YELLOW}🔍 Testing: $test_file${NC}"
    echo -e "${BLUE}----------------------------------------${NC}"
    echo -e "${PURPLE}📝 Log file: $log_file${NC}"
    
    # Create logs directory if it doesn't exist
    mkdir -p test-logs
    
    # Run the specific test with enhanced logging
    cd frontend
    
    echo -e "${CYAN}🚀 Starting test execution...${NC}"
    
    # Run Cypress with detailed output
    npx cypress run \
        --spec "$test_file" \
        --browser chrome \
        --headless \
        --reporter spec \
        --reporter-options "toConsole=true,includeTestResults=true" \
        2>&1 | tee "../$log_file"
    
    local exit_code=${PIPESTATUS[0]}
    cd ..
    
    if [ $exit_code -eq 0 ]; then
        echo -e "${GREEN}✅ $test_file - PASSED${NC}"
        echo -e "${GREEN}📄 Full log: $log_file${NC}"
        return 0
    else
        echo -e "${RED}❌ $test_file - FAILED${NC}"
        echo -e "${RED}📄 Full log: $log_file${NC}"
        
        # Show last 20 lines of the log for quick analysis
        echo -e "\n${YELLOW}📋 Last 20 lines of log:${NC}"
        echo -e "${BLUE}----------------------------------------${NC}"
        tail -20 "$log_file"
        echo -e "${BLUE}----------------------------------------${NC}"
        
        return 1
    fi
}

# Function to analyze failure with detailed information
analyze_failure() {
    local test_file=$1
    local log_file="test-logs/$(basename "$test_file" .cy.ts)-*.log"
    
    echo -e "\n${RED}🔍 DETAILED FAILURE ANALYSIS: $test_file${NC}"
    echo -e "${BLUE}===========================================${NC}"
    
    # Find the most recent log file
    local latest_log=$(ls -t test-logs/$(basename "$test_file" .cy.ts)-*.log 2>/dev/null | head -1)
    
    if [ -f "$latest_log" ]; then
        echo -e "${PURPLE}📄 Analyzing log: $latest_log${NC}"
        
        # Extract key information from the log
        echo -e "\n${YELLOW}🔍 Error Summary:${NC}"
        grep -i "error\|fail\|exception" "$latest_log" | tail -10
        
        echo -e "\n${YELLOW}🌐 Network Issues:${NC}"
        grep -i "network\|request\|response" "$latest_log" | tail -5
        
        echo -e "\n${YELLOW}🎯 Test Steps:${NC}"
        grep -i "should\|expect\|assert" "$latest_log" | tail -10
        
        echo -e "\n${YELLOW}📱 Console Logs:${NC}"
        grep -i "\[APP LOG\]\|\[APP ERROR\]\|\[APP WARN\]" "$latest_log" | tail -10
    fi
    
    echo -e "\n${YELLOW}🛠️ Common Issues to Check:${NC}"
    echo "1. Missing data-testid attributes in components"
    echo "2. Database schema mismatches"
    echo "3. API endpoint issues (check network logs above)"
    echo "4. Authentication/authorization problems"
    echo "5. Component not rendering properly"
    echo "6. Console errors in application (check console logs above)"
    
    echo -e "\n${YELLOW}📋 Next Steps:${NC}"
    echo "1. Review the detailed log file: $latest_log"
    echo "2. Check the error summary above"
    echo "3. Verify network requests are working"
    echo "4. Check for console errors in the application"
    echo "5. Fix the issues identified"
    echo "6. Re-run this test"
}

# Function to show test summary
show_test_summary() {
    local passed=$1
    local failed=$2
    local total=$((passed + failed))
    
    echo -e "\n${BLUE}📊 TEST SUMMARY${NC}"
    echo -e "${BLUE}===============${NC}"
    echo -e "${GREEN}✅ Passed: $passed${NC}"
    echo -e "${RED}❌ Failed: $failed${NC}"
    echo -e "${BLUE}📈 Total: $total${NC}"
    
    if [ $failed -gt 0 ]; then
        echo -e "\n${YELLOW}📁 Log files are available in: test-logs/${NC}"
        echo -e "${YELLOW}💡 Check the detailed logs for failure analysis${NC}"
    fi
}

# Main execution
echo -e "${GREEN}Starting enhanced testing with detailed logging...${NC}"

passed=0
failed=0

for test in "${TESTS[@]}"; do
    if run_single_test "$test"; then
        ((passed++))
        echo -e "${GREEN}✅ $test completed successfully${NC}"
    else
        ((failed++))
        analyze_failure "$test"
        echo -e "\n${RED}🛑 STOPPING: Fix the issues above before continuing${NC}"
        echo -e "${YELLOW}💡 Tip: Check the detailed log file for complete error information${NC}"
        show_test_summary $passed $failed
        exit 1
    fi
done

show_test_summary $passed $failed
echo -e "\n${GREEN}🎉 ALL TESTS PASSED!${NC}"
echo -e "${BLUE}All features are working correctly.${NC}"
echo -e "${PURPLE}📁 All logs saved in: test-logs/${NC}"


