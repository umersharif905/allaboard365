import * as XLSX from 'xlsx';
import { GroupedEnrollment, MemberEnrollment, MemberEnrollmentService } from '../services/member/member-enrollments.service';
import { Member } from '../types/member.types';
import { formatCurrency, parseCalendarDate } from './helpers';

interface ExportData {
  agentName: string;
  period: string;
  entityType?: string; // 'Agent', 'Agency', 'Vendor', 'Tenant'
  summary: {
    totalRevenue: number;
    totalCommission: number;
    paymentCount: number;
  };
  payments: any[]; // Detailed payment list
  groups?: any[];  // Group breakdown
  individuals?: any[]; // Individual breakdown
  products?: any[]; // Product breakdown
}

interface ExportAllData {
  period: string;
  summary: any[];
  payments: any[];
}

export const generateAllExport = (data: ExportAllData) => {
  const wb = XLSX.utils.book_new();

  // 1. Summary Sheet
  const summaryRows = data.summary.map(s => ({
    'Recipient Name': s.recipientName,
    'Type': s.recipientType,
    'Payment Count': s.count,
    'Total Revenue': s.totalRevenue,
    'Total Commission': s.totalCommission
  }));
  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 25 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

  // 2. All Payments Sheet
  const paymentRows = data.payments.map(p => ({
    'Date': new Date(p.paymentDate).toLocaleDateString(),
    'Recipient': p.recipientName,
    'Recipient Type': p.recipientType,
    'Name': p.name || p.memberName || p.groupName || 'Unknown',
    'Type': p.type || (p.groupName ? 'Group' : 'Individual'),
    'Payment Amount': p.paymentAmount,
    'Commission Amount': p.commissionAmount
  }));
  const wsPayments = XLSX.utils.json_to_sheet(paymentRows);
  wsPayments['!cols'] = [
    { wch: 12 }, { wch: 25 }, { wch: 12 }, 
    { wch: 30 }, { wch: 12 },
    { wch: 15 }, { wch: 18 }
  ];
  XLSX.utils.book_append_sheet(wb, wsPayments, "All Payments");

  const fileName = `Full_Commission_Report_${new Date().toISOString().split('T')[0]}.xlsx`;
  XLSX.writeFile(wb, fileName);
};

/**
 * Generate a multi-tab Excel statement for an Agent/Agency
 */
export const generateAgentStatement = (data: ExportData) => {
  const wb = XLSX.utils.book_new();
  const entityType = data.entityType || 'Agent';
  const entityLabel = entityType === 'Agency' ? 'Agency' : entityType === 'Vendor' ? 'Vendor' : entityType === 'Tenant' ? 'Tenant' : 'Agent';
  const payoutLabel = entityType === 'Agency' ? 'Agency Payout' : entityType === 'Vendor' ? 'Vendor Payout' : entityType === 'Tenant' ? 'Tenant Payout' : 'Agent Commission';

  // 1. Overview Sheet
  const overviewData = [
    [`${entityLabel} Statement`],
    [`${entityLabel} Name`, data.agentName],
    ['Period', data.period],
    ['Generated', new Date().toLocaleDateString()],
    [''],
    ['Summary'],
    ['Total Revenue Generated', formatCurrency(data.summary.totalRevenue)],
    [`Total ${payoutLabel}`, formatCurrency(data.summary.totalCommission)],
    ['Total Payments', data.summary.paymentCount],
  ];
  
  const wsOverview = XLSX.utils.aoa_to_sheet(overviewData);
  wsOverview['!cols'] = [{ wch: 25 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(wb, wsOverview, "Overview");

  // 2. Payments Sheet
  const paymentRows = data.payments.map(p => ({
    'Date': new Date(p.paymentDate).toLocaleDateString(),
    'Name': p.name || p.memberName || p.groupName || 'Unknown',
    'Type': p.type || (p.groupName ? 'Group' : 'Individual'),
    'Payment Amount': p.paymentAmount,
    'Commission Amount': p.commissionAmount
  }));
  
  const wsPayments = XLSX.utils.json_to_sheet(paymentRows);
  wsPayments['!cols'] = [
    { wch: 12 }, // Date
    { wch: 30 }, // Name
    { wch: 12 }, // Type
    { wch: 15 }, // Payment Amount
    { wch: 18 }  // Commission Amount
  ];
  XLSX.utils.book_append_sheet(wb, wsPayments, "Payments");

  // 3. Groups Breakdown
  if (data.groups && data.groups.length > 0) {
      // Get all unique product names across all groups
      const allProductNames = new Set<string>();
      data.groups.forEach(g => {
        if (g.productBreakdown && typeof g.productBreakdown === 'object') {
          Object.keys(g.productBreakdown).forEach(productName => {
            allProductNames.add(productName);
          });
        }
      });
      
      // Build rows with separate columns for each product
      const groupRows = data.groups.map(g => {
        const row: any = {
          'Group Name': g.groupName,
          'Households': g.householdCount,
          'Total Premium': formatCurrency(g.totalPremium),
          'Total Commission': formatCurrency(g.totalCommission)
        };
        
        // Add a column for each product
        allProductNames.forEach(productName => {
          if (g.productBreakdown && typeof g.productBreakdown === 'object') {
            row[productName] = g.productBreakdown[productName] || '';
          } else {
            row[productName] = '';
          }
        });
        
        return row;
      });
      
      const wsGroups = XLSX.utils.json_to_sheet(groupRows);
      // Set column widths: base columns + product columns
      const baseCols = [
        { wch: 30 }, // Group Name
        { wch: 12 }, // Households
        { wch: 15 }, // Total Premium
        { wch: 18 }  // Total Commission
      ];
      const productCols = Array.from(allProductNames).map(() => ({ wch: 40 }));
      wsGroups['!cols'] = [...baseCols, ...productCols];
      XLSX.utils.book_append_sheet(wb, wsGroups, "Groups");
  }

  // 4. Individuals Breakdown
  if (data.individuals && data.individuals.length > 0) {
    const individualRows = data.individuals.map(i => ({
        'Member Name': i.memberName,
        'Tier': i.tier || 'N/A',
        'Total Premium': formatCurrency(i.totalPremium),
        [payoutLabel]: formatCurrency(i.totalCommission),
        'Product/Tier Breakdown': i.productBreakdown || ''
    }));
    const wsIndividuals = XLSX.utils.json_to_sheet(individualRows);
    wsIndividuals['!cols'] = [
      { wch: 30 }, // Member Name
      { wch: 10 }, // Tier
      { wch: 15 }, // Total Premium
      { wch: 18 }, // Agent Commission
      { wch: 50 }  // Product/Tier Breakdown
    ];
    XLSX.utils.book_append_sheet(wb, wsIndividuals, "Individuals");
  }

  // 5. Products Breakdown
  if (data.products && data.products.length > 0) {
    const productRows = data.products.map(p => ({
        'Product': p.productName,
        'Tier': p.tier || 'Standard',
        'Sign-ups': p.count,
        'Total Revenue': formatCurrency(p.totalPremium),
        [payoutLabel]: formatCurrency(p.totalCommission)
    }));
    const wsProducts = XLSX.utils.json_to_sheet(productRows);
    wsProducts['!cols'] = [
      { wch: 30 }, // Product
      { wch: 20 }, // Tier (wider for full tier names)
      { wch: 12 }, // Sign-ups
      { wch: 15 }, // Total Revenue
      { wch: 18 }  // Agent Commission
    ];
    XLSX.utils.book_append_sheet(wb, wsProducts, "Products");
  }

  // Generate File
  const fileName = `Statement_${data.agentName.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;
  XLSX.writeFile(wb, fileName);
};

/**
 * Generate a multi-sheet Excel export for member details
 */
export interface MemberDetailsExportData {
  member: Member;
  householdMembers: Member[];
  enrollments: MemberEnrollment[];
}

/**
 * Format calendar date for display (handles UTC timezone properly)
 */
const formatCalendarDate = (dateString: string | null | undefined): string => {
  if (!dateString) return '';
  const date = parseCalendarDate(dateString);
  if (!date) return '';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });
};

/**
 * Format address fields into single formatted string
 * Example: "16112 scott rd, midlothian, va 23112"
 */
const formatAddress = (address?: string, city?: string, state?: string, zip?: string): string => {
  const parts: string[] = [];
  if (address) parts.push(address.toLowerCase());
  if (city) parts.push(city.toLowerCase());
  if (state) parts.push(state.toLowerCase());
  if (zip) parts.push(zip);
  
  if (parts.length === 0) return '';
  return parts.join(', ');
};

/**
 * Check if email should be hidden
 */
const shouldHideEmail = (email?: string): boolean => {
  if (!email) return true;
  return email.toLowerCase().includes('@noemail.com');
};

/**
 * Check if product has configuration fields (like Unshared Amount)
 */
const hasConfigurationFields = (product: any): boolean => {
  if (!product) return false;
  
  try {
    const requiredFields = product.requiredDataFields || product.RequiredDataFields;
    if (!requiredFields) return false;
    
    const fields = typeof requiredFields === 'string' 
      ? JSON.parse(requiredFields) 
      : requiredFields;
    
    if (!Array.isArray(fields) || fields.length === 0) return false;
    
    // Check if any field name includes "Unshared Amount" or similar configuration terms
    return fields.some((field: any) => {
      const fieldName = field.fieldName || field.FieldName || '';
      return fieldName.toLowerCase().includes('unshared amount') || 
             fieldName.toLowerCase().includes('configuration') ||
             fieldName.toLowerCase().includes('deductible');
    });
  } catch (e) {
    return false;
  }
};

/**
 * Extract configuration value from enrollment details
 * Only returns a value if the product actually has configuration fields
 */
const extractConfigValue = (enrollment: MemberEnrollment | any): string => {
  // First check if the product has configuration fields
  const product = enrollment.product || enrollment.Product;
  if (!hasConfigurationFields(product)) {
    return ''; // Empty string if product doesn't have config fields
  }
  
  try {
    if (enrollment.enrollmentDetails || enrollment.EnrollmentDetails) {
      const enrollmentDetails = enrollment.enrollmentDetails || enrollment.EnrollmentDetails;
      const details = typeof enrollmentDetails === 'string'
        ? JSON.parse(enrollmentDetails)
        : enrollmentDetails;
      
      // Check for "configuration" field (contains unshared amount and other config values)
      if (details.configuration && details.configuration !== 'Default') {
        return details.configuration;
      }
      
      // Look for other configValue variations
      if (details.configValue && details.configValue !== 'Default') return details.configValue;
      if (details.ConfigValue && details.ConfigValue !== 'Default') return details.ConfigValue;
      if (details.configValues && details.configValues.ConfigValue1) return details.configValues.ConfigValue1;
    }
    
    // Fallback to ConfigValue fields
    if (enrollment.configValue1 && enrollment.configValue1 !== 'Default') return enrollment.configValue1;
    if ((enrollment as any).ConfigValue1 && (enrollment as any).ConfigValue1 !== 'Default') {
      return (enrollment as any).ConfigValue1;
    }
    
    return ''; // Return empty if no valid configuration found
  } catch (e) {
    return '';
  }
};

export const generateMemberDetailsExport = (data: MemberDetailsExportData) => {
  const wb = XLSX.utils.book_new();
  const { member, householdMembers, enrollments } = data;
  
  // Debug: Log member object to see agent info
  console.log('🔍 Export generateMemberDetailsExport - Member object:', {
    MemberId: member.MemberId,
    AgentName: member.AgentName,
    AgentEmail: member.AgentEmail,
    GroupAgentName: member.GroupAgentName,
    GroupAgentEmail: member.GroupAgentEmail,
    AgentId: member.AgentId,
    'Raw AgentName': (member as any).AgentName,
    'Raw AgentEmail': (member as any).AgentEmail
  });
  
  // Filter out Contribution, ProcessingFee, and SystemFee enrollments before grouping
  const productEnrollments = enrollments.filter((e: any) => {
    const enrollmentType = e.enrollmentType || e.EnrollmentType;
    if (enrollmentType === 'Contribution' || enrollmentType === 'PaymentProcessingFee' || 
        enrollmentType === 'ProcessingFee' || enrollmentType === 'SystemFee') {
      return false;
    }
    return true;
  });
  
  // Group enrollments by bundle
  const groupedEnrollments = MemberEnrollmentService.groupEnrollmentsByBundle(productEnrollments);
  
  // Sheet 1: Member Info (Primary Member + Dependents)
  const memberRows: any[] = [];
  
  // Primary member row
  // Handle both PascalCase and camelCase property access
  const agentName = (member as any).AgentName || member.AgentName || (member as any).GroupAgentName || member.GroupAgentName || '';
  const agentEmail = (member as any).AgentEmail || member.AgentEmail || (member as any).GroupAgentEmail || member.GroupAgentEmail || '';
  
  console.log('🔍 Agent info extracted:', { agentName, agentEmail });
  
  const primaryMemberRow = {
    'Group Name': member.GroupName || '',
    'Household Member ID': member.HouseholdMemberID || 'N/A',
    'First Name': member.FirstName || '',
    'Last Name': member.LastName || '',
    'Email': shouldHideEmail(member.Email) ? '' : (member.Email || ''),
    'Phone Number': member.PhoneNumber || '',
    'Date of Birth': formatCalendarDate(member.DateOfBirth),
    'Gender': member.Gender || '',
    'Address': formatAddress(member.Address, member.City, member.State, member.Zip),
    'Status': member.Status || '',
    'Relationship Type': member.RelationshipDescription || (member.RelationshipType === 'P' ? 'Primary' : member.RelationshipType === 'S' ? 'Spouse' : member.RelationshipType === 'C' ? 'Child' : ''),
    'Tier': member.Tier || '',
    'Tobacco Use': member.TobaccoUse || '',
    'Employee ID': member.EmployeeId || '',
    'Job Position': member.JobPosition || '',
    'Work Location': member.WorkLocation || '',
    'Hire Date': formatCalendarDate(member.HireDate),
    'Agent Name': agentName,
    'Agent Email': agentEmail,
    'Agent Phone': '' // Agent phone not available in member object
  };
  
  console.log('🔍 Primary member row with agent info:', primaryMemberRow);
  memberRows.push(primaryMemberRow);
  
  // Add dependents below primary member (exclude the primary member itself)
  if (householdMembers && Array.isArray(householdMembers)) {
    householdMembers.forEach(dependent => {
      // Skip if this is the primary member (same MemberId)
      if (dependent.MemberId === member.MemberId) {
        return;
      }
      
      const dependentRow = {
        'Group Name': '', // Empty for dependents since they're in the same group
        'Household Member ID': dependent.HouseholdMemberID || 'N/A',
        'First Name': dependent.FirstName || '',
        'Last Name': dependent.LastName || '',
        'Email': shouldHideEmail(dependent.Email) ? '' : (dependent.Email || ''),
        'Phone Number': dependent.PhoneNumber || '',
        'Date of Birth': formatCalendarDate(dependent.DateOfBirth),
        'Gender': dependent.Gender || '',
        'Address': formatAddress(dependent.Address, dependent.City, dependent.State, dependent.Zip),
        'Status': dependent.Status || '',
        'Relationship Type': dependent.RelationshipDescription || (dependent.RelationshipType === 'P' ? 'Primary' : dependent.RelationshipType === 'S' ? 'Spouse' : dependent.RelationshipType === 'C' ? 'Child' : ''),
        'Tier': dependent.Tier || '',
        'Tobacco Use': dependent.TobaccoUse || '',
        'Employee ID': dependent.EmployeeId || '',
        'Job Position': dependent.JobPosition || '',
        'Work Location': dependent.WorkLocation || '',
        'Hire Date': formatCalendarDate(dependent.HireDate),
        'Agent Name': '', // Dependents use same agent as primary member
        'Agent Email': '', // Dependents use same agent as primary member
        'Agent Phone': '' // Dependents use same agent as primary member
      };
      memberRows.push(dependentRow);
    });
  }
  
  const wsMemberInfo = XLSX.utils.json_to_sheet(memberRows);
  wsMemberInfo['!cols'] = [
    { wch: 30 }, // Group Name
    { wch: 25 }, // Household Member ID
    { wch: 15 }, // First Name
    { wch: 15 }, // Last Name
    { wch: 30 }, // Email
    { wch: 15 }, // Phone Number
    { wch: 12 }, // Date of Birth
    { wch: 10 }, // Gender
    { wch: 50 }, // Address (combined)
    { wch: 12 }, // Status
    { wch: 20 }, // Relationship Type
    { wch: 10 }, // Tier
    { wch: 12 }, // Tobacco Use
    { wch: 15 }, // Employee ID
    { wch: 20 }, // Job Position
    { wch: 25 }, // Work Location
    { wch: 12 }, // Hire Date
    { wch: 30 }, // Agent Name
    { wch: 30 }, // Agent Email
    { wch: 15 }  // Agent Phone
  ];
  XLSX.utils.book_append_sheet(wb, wsMemberInfo, 'Member Info');
  
  // Sheet 2: Plans
  const planRows: any[] = [];
  
  groupedEnrollments.forEach((groupedEnrollment: GroupedEnrollment) => {
    if (groupedEnrollment.type === 'bundle') {
      // For bundles, only show individual products (not the bundle enrollment row)
      // Fix product names for component enrollments
      if (groupedEnrollment.componentEnrollments && groupedEnrollment.componentEnrollments.length > 0) {
        groupedEnrollment.componentEnrollments.forEach((component: MemberEnrollment) => {
          // Get product name from component product or fallback
          const productName = component.product?.name || 'Unknown Product';
          // Only get the configuration value (Unshared Amount), not all config values
          const unsharedAmount = extractConfigValue(component);
          
          const productRow: any = {
            'Product Name': productName,
            'Bundle Name': groupedEnrollment.bundleName || groupedEnrollment.bundleProduct?.name || '',
            'Status': component.status || '',
            'Effective Date': formatCalendarDate(component.effectiveDate),
            'Termination Date': formatCalendarDate(component.terminationDate),
            'Monthly Premium': formatCurrency(component.premiumAmount || 0),
            'Unshared Amount': unsharedAmount,
            'Employer Contribution': component.employerContributionAmount 
              ? formatCurrency(component.employerContributionAmount) 
              : ''
          };
          
          planRows.push(productRow);
        });
      }
    } else {
      // Individual product enrollment
      const enrollment = groupedEnrollment.primaryEnrollment;
      if (!enrollment) return;
      
      // Only get the configuration value (Unshared Amount), not all config values
      const unsharedAmount = extractConfigValue(enrollment);
      
      const row: any = {
        'Product Name': enrollment.product?.name || 'Unknown Product',
        'Bundle Name': '', // Empty for individual products
        'Status': enrollment.status || '',
        'Effective Date': formatCalendarDate(enrollment.effectiveDate),
        'Termination Date': formatCalendarDate(enrollment.terminationDate),
        'Monthly Premium': formatCurrency(enrollment.premiumAmount || 0),
        'Unshared Amount': unsharedAmount,
        'Employer Contribution': enrollment.employerContributionAmount 
          ? formatCurrency(enrollment.employerContributionAmount) 
          : ''
      };
      
      planRows.push(row);
    }
  });
  
  const wsPlans = XLSX.utils.json_to_sheet(planRows);
  wsPlans['!cols'] = [
    { wch: 35 }, // Product Name
    { wch: 35 }, // Bundle Name
    { wch: 12 }, // Status
    { wch: 12 }, // Effective Date
    { wch: 12 }, // Termination Date
    { wch: 15 }, // Monthly Premium
    { wch: 15 }, // Unshared Amount
    { wch: 20 }  // Employer Contribution
  ];
  XLSX.utils.book_append_sheet(wb, wsPlans, 'Plans');
  
  // Generate file name
  const fileName = `MemberDetails_${member.FirstName}_${member.LastName}_${new Date().toISOString().split('T')[0]}.xlsx`.replace(/[^a-zA-Z0-9._-]/g, '_');
  XLSX.writeFile(wb, fileName);
};

