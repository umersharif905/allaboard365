import { Check,
    Copy,
    Edit,
    Info,
    Layers,
    Plus,
    Save,
    Settings,
    Shield, Target,
    Trash2,
    TrendingUp,
    UserCheck,
    X
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/apiServices';
import { Group } from '../../services/groups.service';
import { useGroupDetails } from '../../hooks/useGroupDetails';
import { 
  convertMonthlyToPayPeriod, 
  convertPayPeriodToMonthly, 
  getPayPeriodLabel, 
  getContributionAmountLabel,
  getShortPeriodLabel,
  formatContributionDisplay,
  type PayrollPeriod 
} from '../../utils/payrollPeriodConverter';
import { DEFAULT_JOB_POSITIONS } from '../../constants/jobPositions';

// Enhanced ContributionRule interface matching the requirements from paste-2.txt
interface ContributionRule {
  contributionId: string;
  groupId: string;
  productId?: string;
  productName?: string;
  name: string;
  description?: string;
  contributionType: 'flat_rate' | 'percentage' | 'tier_based' | 'tenure_based' | 'age_based' | 'role_based' | 'override' | 'minimum_threshold';
  contributionDirection?: 'Employer' | 'MaxEmployee'; // NEW: Direction of contribution
  
  // Basic amounts
  flatRateAmount?: number;
  percentageAmount?: number;
  
  // Tier-based contributions (matching JSON structure)
  tierContributions?: {
    employee_only?: number;
    employee_spouse?: number;
    employee_children?: number;
    family?: number;
  };
  
  // Role-based contributions
  roleContributions?: Array<{
    role: string;
    contributionAmount: number;
    contributionType: 'flat' | 'percentage';
  }>;
  
  // Tenure-based contributions (using years like JSON spec)
  tenureRules?: Array<{
    minYears: number;
    maxYears?: number;
    contributionAmount: number;
    contributionType: 'flat' | 'percentage';
  }>;
  
  // Age-based contributions
  ageRules?: Array<{
    minAge: number;
    maxAge?: number;
    contributionAmount: number;
    contributionType: 'flat' | 'percentage';
  }>;
  
  // Job position filter (optional - applies to all if empty/null)
  jobPositions?: string[];
  
  // Division-based contributions
  divisionRules?: Array<{
    division: string;
    contributionAmount: number;
    contributionType: 'flat' | 'percentage';
  }>;
  
  // Override settings
  overrideType?: 'full_premium' | 'fixed_amount' | 'percentage_override';
  overrideAmount?: number;
  
  // Minimum threshold
  minimumAmount?: number;
  
  // Rule settings matching JSON spec
  priority: number;
  stacking: boolean;
  appliesTo?: {
    employmentClass?: string[];
    coverageTier?: string[];
    planType?: string[];
  };
  
  effectiveDate: string;
  endDate?: string;
  status: 'Active' | 'Inactive' | 'Pending';
  createdDate: string;
}


interface Product {
  ProductId: string;
  Name: string;
  ProductType: string;
}

interface GroupsContributionsProps {
  isOpen: boolean;
  onClose: () => void;
  selectedGroup: Group | null;
  products: Product[];
}

const GroupsContributions: React.FC<GroupsContributionsProps> = ({
  isOpen,
  onClose,
  selectedGroup,
  products
}) => {
  // Get group details to access PayrollPeriod setting
  const { data: groupData } = useGroupDetails(selectedGroup?.GroupId);
  const payrollPeriod: PayrollPeriod = (groupData as any)?.PayrollPeriod || 'Monthly';

  // Debug logging
  console.log('🔍 GroupsContributions - products prop:', products);
  console.log('🔍 GroupsContributions - products length:', products?.length || 0);
  // Standard API envelope returned by makeApiCall (via apiService).
  interface ApiResponse { success?: boolean; data?: any; message?: string; [key: string]: any; }

  // Enhanced API call function with better error handling - now using apiService
  const makeApiCall = async (endpoint: string, options: { method?: string; body?: any } = {}) => {
    try {
      console.log(`🌐 GroupsContributions API call to: ${endpoint}`);

      let result: ApiResponse;
      const method = options.method?.toUpperCase() || 'GET';
      
      switch (method) {
        case 'GET':
          result = await apiService.get<ApiResponse>(endpoint);
          break;
        case 'POST':
          result = await apiService.post<ApiResponse>(endpoint, options.body);
          break;
        case 'PUT':
          result = await apiService.put<ApiResponse>(endpoint, options.body);
          break;
        case 'DELETE':
          result = await apiService.delete<ApiResponse>(endpoint);
          break;
        case 'PATCH':
          result = await apiService.patch<ApiResponse>(endpoint, options.body);
          break;
        default:
          throw new Error(`Unsupported HTTP method: ${method}`);
      }
      
      console.log(`✅ API Success for ${endpoint}:`, result);
      return result;

    } catch (error: any) {
      console.error(`❌ API Call failed for ${endpoint}:`, error);
      throw error;
    }
  };

  // Helper function to get the first day of current month as default
  const getFirstOfCurrentMonth = () => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  };

  // Helper function to convert any date to first of that month
  const getFirstOfMonth = (dateString: string) => {
    if (!dateString) return getFirstOfCurrentMonth();
    const date = new Date(dateString);
    return new Date(date.getFullYear(), date.getMonth(), 1).toISOString().split('T')[0];
  };

  // Helper function to validate and format date input
  const handleDateChange = (dateString: string) => {
    const originalDate = new Date(dateString);
    const firstOfMonth = getFirstOfMonth(dateString);
    
    // Show notification if date was changed
    if (originalDate.getDate() !== 1) {
      const monthName = originalDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      console.log(`📅 Date automatically adjusted to first of ${monthName}`);
      // You could add a toast notification here if you have a toast system
    }
    
    return firstOfMonth;
  };

  const [contributionRules, setContributionRules] = useState<ContributionRule[]>([]);
  const [newContribution, setNewContribution] = useState<Partial<ContributionRule>>({
    contributionType: 'flat_rate',
    contributionDirection: 'Employer', // Default to Employer Contribution
    effectiveDate: getFirstOfCurrentMonth(),
    status: 'Active',
    priority: 1,
    stacking: true,
    name: '',
    description: ''
  });
  const [activeTab, setActiveTab] = useState<'rules' | 'calculator'>('rules');
  const [editingRule, setEditingRule] = useState<ContributionRule | null>(null);

  // Helper function to generate a proper UUID
  const generateUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  };

  // Sample employee data for testing (production would come from props or API)
  const sampleEmployee = {
    employeeId: "EMP001",
    firstName: "Jane",
    lastName: "Doe",
    employmentClass: "full_time",
    role: "manager",
    division: "engineering",
    startDate: "2020-01-15",
    coverageTier: "employee_spouse"
  };

  const samplePlan = {
    planId: "PLAN001",
    name: "Premium Medical Plan",
    monthlyPremium: 650,
    planType: "medical"
  };

  useEffect(() => {
    if (selectedGroup && isOpen) {
      fetchContributionRules(selectedGroup.GroupId);
    }
  }, [selectedGroup, isOpen]);

  const fetchContributionRules = async (groupId: string) => {
    try {
      const result = await makeApiCall(`/api/groups/${groupId}/contributions`) as any;
      
      if (result.success) {
        console.log('Raw API response:', result.data); // Debug log
        
        // Map backend PascalCase to frontend camelCase and filter invalid rules
        const mappedRules = result.data.map((rule: any) => ({
          contributionId: rule.ContributionId,
          groupId: rule.GroupId,
          productId: rule.ProductId,
          productName: rule.ProductName,
          name: rule.Name,
          description: rule.Description,
          contributionType: rule.ContributionType,
          contributionDirection: rule.ContributionDirection || 'Employer', // Default to 'Employer' for backward compatibility
          flatRateAmount: rule.FlatRateAmount,
          percentageAmount: rule.PercentageAmount,
          tierContributions: rule.tierContributions, // Already parsed by backend
          roleContributions: rule.roleContributions, // Already parsed by backend
          tenureRules: rule.tenureRules, // Already parsed by backend
          ageRules: rule.ageRules, // Already parsed by backend
          // Ensure jobPositions is an array (handle null/undefined/string from backend)
          jobPositions: (() => {
            if (rule.jobPositions === null || rule.jobPositions === undefined) {
              return [];
            }
            if (Array.isArray(rule.jobPositions)) {
              return rule.jobPositions;
            }
            // If it's a string, try to parse it
            if (typeof rule.jobPositions === 'string') {
              try {
                const parsed = JSON.parse(rule.jobPositions);
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            }
            return [];
          })(),
          divisionRules: rule.divisionRules, // Already parsed by backend
          overrideType: rule.OverrideType,
          overrideAmount: rule.OverrideAmount,
          minimumAmount: rule.MinimumAmount,
          priority: rule.Priority,
          stacking: rule.Stacking,
          appliesTo: rule.appliesTo, // Already parsed by backend
          effectiveDate: rule.EffectiveDate ? new Date(rule.EffectiveDate).toISOString().split('T')[0] : '',
          endDate: rule.EndDate ? new Date(rule.EndDate).toISOString().split('T')[0] : undefined,
          status: rule.Status,
          createdDate: rule.CreatedDate
        }));

        // Filter out any invalid rules and inactive rules
        const validRules = mappedRules.filter((rule: any) => 
          rule && 
          rule.contributionId && 
          rule.name && 
          rule.contributionType &&
          rule.status !== 'Inactive' && // Don't show deleted/inactive rules
          ['flat_rate', 'percentage', 'tier_based', 'age_based', 'tenure_based'].includes(rule.contributionType)
        );
        
        console.log('Mapped and filtered rules:', validRules); // Debug log
        setContributionRules(validRules);
      } else {
        console.error('Failed to fetch contribution rules:', result.message);
        setContributionRules([]);
      }
    } catch (error) {
      console.error('Error fetching contribution rules:', error);
      setContributionRules([]);
    }
  };

  // Calculate years of service
  const getYearsOfService = (startDate: string) => {
    const start = new Date(startDate);
    const now = new Date();
    return Math.floor((now.getTime() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  };

  // Coverage tier key mapping
  const getCoverageTierKey = (tier: string) => {
    const mapping: Record<string, string> = {
      'employee_only': 'employee_only',
      'employee_spouse': 'employee_spouse', 
      'employee_children': 'employee_children',
      'family': 'family'
    };
    return mapping[tier] || 'employee_only';
  };

  // Check if rule applies to employee/plan (matches JSON spec logic)
  const ruleApplies = (rule: ContributionRule, employee: any, plan: any) => {
    if (rule.productId && rule.productId !== plan.planId) return false;
    if (rule.appliesTo?.employmentClass && !rule.appliesTo.employmentClass.includes(employee.employmentClass)) return false;
    if (rule.appliesTo?.planType && !rule.appliesTo.planType.includes(plan.planType)) return false;
    return true;
  };

  // Enhanced contribution calculation engine with debug logging
  const calculateEmployerContribution = (employee: any, plan: any) => {
    console.log('🧮 Starting contribution calculation');
    console.log('Available rules for calculation:', contributionRules);
    
    const sortedRules = [...contributionRules]
      .filter(rule => rule.status === 'Active' && rule.contributionType) // Only active rules
      .sort((a, b) => a.priority - b.priority);
    
    console.log('Filtered and sorted rules:', sortedRules);
    
    let contribution = 0;
    let appliedRules: string[] = [];

    for (const rule of sortedRules) {
      console.log(`Processing rule: ${rule.name} (${rule.contributionType})`);
      
      if (!ruleApplies(rule, employee, plan)) {
        console.log(`Rule ${rule.name} does not apply`);
        continue;
      }

      console.log(`Rule ${rule.name} applies, processing...`);

      switch (rule.contributionType) {
        case "flat_rate":
          if (rule.flatRateAmount) {
            contribution += rule.flatRateAmount;
            appliedRules.push(`${rule.name}: +${rule.flatRateAmount}`);
            console.log(`Applied flat rate: ${rule.flatRateAmount}`);
          }
          break;

        case "percentage":
          if (rule.percentageAmount) {
            const premium = plan.monthlyPremium;
            const pct = rule.percentageAmount;
            const pctAmount = premium * (pct / 100);
            contribution += pctAmount;
            appliedRules.push(`${rule.name}: +${pctAmount.toFixed(2)} (${pct}%)`);
            console.log(`Applied percentage: ${pct}% = ${pctAmount}`);
          }
          break;

        case "tier_based":
          if (rule.tierContributions) {
            const tierKey = getCoverageTierKey(employee.coverageTier);
            const tierAmount = rule.tierContributions[tierKey as keyof typeof rule.tierContributions] || 0;
            contribution += tierAmount;
            appliedRules.push(`${rule.name}: +${tierAmount} (${tierKey})`);
            console.log(`Applied tier based: ${tierKey} = ${tierAmount}`);
          }
          break;

        case "tenure_based":
          if (rule.tenureRules) {
            const years = getYearsOfService(employee.startDate);
            const applicableTenure = rule.tenureRules
              .filter(t => years >= t.minYears && (!t.maxYears || years <= t.maxYears))
              .sort((a, b) => b.minYears - a.minYears)[0];
            
            if (applicableTenure) {
              if (applicableTenure.contributionType === 'flat') {
                contribution += applicableTenure.contributionAmount;
                appliedRules.push(`${rule.name}: +${applicableTenure.contributionAmount} (${years} years)`);
                console.log(`Applied tenure flat: ${applicableTenure.contributionAmount}`);
              } else {
                const pctAmount = plan.monthlyPremium * (applicableTenure.contributionAmount / 100);
                contribution += pctAmount;
                appliedRules.push(`${rule.name}: +${pctAmount.toFixed(2)} (${applicableTenure.contributionAmount}%, ${years} years)`);
                console.log(`Applied tenure percentage: ${applicableTenure.contributionAmount}% = ${pctAmount}`);
              }
            }
          }
          break;

        case "role_based":
          if (rule.roleContributions) {
            const roleRule = rule.roleContributions.find(r => r.role === employee.role);
            if (roleRule) {
              if (roleRule.contributionType === 'flat') {
                contribution += roleRule.contributionAmount;
                appliedRules.push(`${rule.name}: +${roleRule.contributionAmount} (${employee.role})`);
                console.log(`Applied role flat: ${roleRule.contributionAmount}`);
              } else {
                const pctAmount = plan.monthlyPremium * (roleRule.contributionAmount / 100);
                contribution += pctAmount;
                appliedRules.push(`${rule.name}: +${pctAmount.toFixed(2)} (${roleRule.contributionAmount}%, ${employee.role})`);
                console.log(`Applied role percentage: ${roleRule.contributionAmount}% = ${pctAmount}`);
              }
            }
          }
          break;

        case "override":
          if (rule.overrideType === "full_premium") {
            console.log(`Applied override: Full premium ${plan.monthlyPremium}`);
            return { 
              totalContribution: plan.monthlyPremium, 
              appliedRules: [`${rule.name}: Full premium coverage (${plan.monthlyPremium})`] 
            };
          }
          break;

        case "minimum_threshold":
          if (rule.minimumAmount && contribution < rule.minimumAmount) {
            const adjustment = rule.minimumAmount - contribution;
            contribution = rule.minimumAmount;
            appliedRules.push(`${rule.name}: +${adjustment.toFixed(2)} (minimum threshold)`);
            console.log(`Applied minimum threshold: ${rule.minimumAmount}`);
          }
          break;
      }

      if (!rule.stacking) {
        console.log(`Rule ${rule.name} prevents stacking, stopping calculation`);
        break;
      }
    }

    const result = { 
      totalContribution: Math.round(contribution * 100) / 100, 
      appliedRules 
    };
    
    console.log('🎯 Final calculation result:', result);
    return result;
  };

  const addContributionRule = async () => {
    if (!newContribution.name || !newContribution.contributionType || !selectedGroup) {
      alert('Please fill in required fields');
      return;
    }

    // Convert pay period amounts back to monthly for storage
    const dataToSave = { ...newContribution };
    
    // Ensure productId is properly formatted (empty string or undefined becomes null for all-products rules)
    if (!dataToSave.productId || dataToSave.productId === '') {
      // Empty productId means this is an all-products rule
      dataToSave.productId = null;
      dataToSave.productName = undefined;
    }
    
    if (dataToSave.flatRateAmount !== undefined) {
      dataToSave.flatRateAmount = convertPayPeriodToMonthly(dataToSave.flatRateAmount, payrollPeriod);
    }
    if (dataToSave.tierContributions) {
      const converted = { ...dataToSave.tierContributions };
      if (converted.employee_only !== undefined) {
        converted.employee_only = convertPayPeriodToMonthly(converted.employee_only, payrollPeriod);
      }
      if (converted.employee_spouse !== undefined) {
        converted.employee_spouse = convertPayPeriodToMonthly(converted.employee_spouse, payrollPeriod);
      }
      if (converted.employee_children !== undefined) {
        converted.employee_children = convertPayPeriodToMonthly(converted.employee_children, payrollPeriod);
      }
      if (converted.family !== undefined) {
        converted.family = convertPayPeriodToMonthly(converted.family, payrollPeriod);
      }
      dataToSave.tierContributions = converted;
    }
    if (dataToSave.minimumAmount !== undefined) {
      dataToSave.minimumAmount = convertPayPeriodToMonthly(dataToSave.minimumAmount, payrollPeriod);
    }
    
    // Convert age rules flat amounts to monthly (percentages stay as-is)
    if (dataToSave.ageRules && Array.isArray(dataToSave.ageRules)) {
      dataToSave.ageRules = dataToSave.ageRules.map(ageRule => ({
        ...ageRule,
        contributionAmount: ageRule.contributionType === 'flat' 
          ? convertPayPeriodToMonthly(ageRule.contributionAmount, payrollPeriod)
          : ageRule.contributionAmount // Percentage stays as-is
      }));
    }
    
    // Ensure jobPositions is properly formatted (empty array becomes null for backend)
    if (dataToSave.jobPositions && Array.isArray(dataToSave.jobPositions) && dataToSave.jobPositions.length === 0) {
      // Backend expects null for empty job positions filter (applies to all)
      dataToSave.jobPositions = null;
    } else if (dataToSave.jobPositions && Array.isArray(dataToSave.jobPositions) && dataToSave.jobPositions.length > 0) {
      // Keep as array - backend will JSON.stringify it
      // No change needed
    } else if (!dataToSave.jobPositions) {
      // If undefined, set to null
      dataToSave.jobPositions = null;
    }
    
    console.log('🔍 addContributionRule - Saving jobPositions:', dataToSave.jobPositions);

    try {
      const result = await makeApiCall(`/api/groups/${selectedGroup.GroupId}/contributions`, {
        method: 'POST',
        body: JSON.stringify(dataToSave)
      }) as any;
      
      if (result.success) {
        console.log('Contribution rule added successfully');
        resetForm();
        // Force refresh the rules from the database
        await fetchContributionRules(selectedGroup.GroupId);
      } else {
        console.error('Failed to add contribution rule:', result.message);
        alert('Failed to add contribution rule: ' + result.message);
      }
    } catch (error) {
      console.error('Error adding contribution rule:', error);
      
      // Fallback to localStorage for development (dataToSave already has monthly amounts)
      const rule: ContributionRule = {
        ...(dataToSave as ContributionRule),
        contributionId: generateUUID(),
        groupId: selectedGroup.GroupId,
        createdDate: new Date().toISOString()
      };

      const updatedRules = [...contributionRules, rule];
      setContributionRules(updatedRules);
      localStorage.setItem(`contributions_${selectedGroup.GroupId}`, JSON.stringify(updatedRules));
      resetForm();
      alert('Added contribution rule locally due to connection error');
    }
  };

  const updateContributionRule = async () => {
    if (!editingRule || !editingRule.name || !editingRule.contributionType || !selectedGroup) {
      alert('Please fill in required fields');
      return;
    }

    // Convert pay period amounts back to monthly for storage
    const dataToSave = { ...editingRule };
    
    // Ensure productId is properly formatted (empty string or undefined becomes null for all-products rules)
    if (!dataToSave.productId || dataToSave.productId === '') {
      // Empty productId means this is an all-products rule
      dataToSave.productId = null;
      dataToSave.productName = undefined;
    }
    
    // Ensure jobPositions is properly formatted (empty array becomes null for backend)
    if (dataToSave.jobPositions && Array.isArray(dataToSave.jobPositions) && dataToSave.jobPositions.length === 0) {
      // Backend expects null for empty job positions filter (applies to all)
      dataToSave.jobPositions = null;
    } else if (dataToSave.jobPositions && Array.isArray(dataToSave.jobPositions) && dataToSave.jobPositions.length > 0) {
      // Keep as array - backend will JSON.stringify it
      // No change needed
    } else if (!dataToSave.jobPositions) {
      // If undefined, set to null
      dataToSave.jobPositions = null;
    }
    
    console.log('🔍 updateContributionRule - Saving productId:', dataToSave.productId);
    console.log('🔍 updateContributionRule - Saving jobPositions:', dataToSave.jobPositions);
    if (dataToSave.flatRateAmount !== undefined) {
      dataToSave.flatRateAmount = convertPayPeriodToMonthly(dataToSave.flatRateAmount, payrollPeriod);
    }
    if (dataToSave.tierContributions) {
      const converted = { ...dataToSave.tierContributions };
      if (converted.employee_only !== undefined) {
        converted.employee_only = convertPayPeriodToMonthly(converted.employee_only, payrollPeriod);
      }
      if (converted.employee_spouse !== undefined) {
        converted.employee_spouse = convertPayPeriodToMonthly(converted.employee_spouse, payrollPeriod);
      }
      if (converted.employee_children !== undefined) {
        converted.employee_children = convertPayPeriodToMonthly(converted.employee_children, payrollPeriod);
      }
      if (converted.family !== undefined) {
        converted.family = convertPayPeriodToMonthly(converted.family, payrollPeriod);
      }
      dataToSave.tierContributions = converted;
    }
    if (dataToSave.minimumAmount !== undefined) {
      dataToSave.minimumAmount = convertPayPeriodToMonthly(dataToSave.minimumAmount, payrollPeriod);
    }
    
    // Convert age rules flat amounts to monthly (percentages stay as-is)
    if (dataToSave.ageRules && Array.isArray(dataToSave.ageRules)) {
      dataToSave.ageRules = dataToSave.ageRules.map(ageRule => ({
        ...ageRule,
        contributionAmount: ageRule.contributionType === 'flat' 
          ? convertPayPeriodToMonthly(ageRule.contributionAmount, payrollPeriod)
          : ageRule.contributionAmount // Percentage stays as-is
      }));
    }

    // Check if this is a valid UUID (from database) or a timestamp (local storage)
    const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(editingRule.contributionId);
    
    if (!isValidUUID) {
      // This is a locally stored rule with timestamp ID, treat as new rule
      console.log('Converting local rule to database rule...');
      const newRule = {
        ...dataToSave,
        contributionId: undefined, // Let backend generate new ID
        createdDate: undefined
      };
      setNewContribution(newRule);
      setEditingRule(null);
      await addContributionRule();
      return;
    }

    try {
      const result = await makeApiCall(`/api/groups/${selectedGroup.GroupId}/contributions/${editingRule.contributionId}`, {
        method: 'PUT',
        body: JSON.stringify(dataToSave)
      });
      
      if (result.success) {
        console.log('Contribution rule updated successfully');
        setEditingRule(null);
        // Force refresh the rules from the database
        await fetchContributionRules(selectedGroup.GroupId);
      } else {
        console.error('Failed to update contribution rule:', result.message);
        alert('Failed to update contribution rule: ' + result.message);
      }
    } catch (error: any) {
      console.error('Error updating contribution rule:', error);
      alert(`Failed to update contribution rule: ${error.message || 'Unknown error'}`);
    }
  };

  const startEditingRule = (rule: ContributionRule) => {
    // Convert monthly amounts to pay period amounts for display
    const convertedRule = { ...rule };
    
    // Ensure jobPositions is an array (handle null/undefined from backend)
    if (convertedRule.jobPositions === null || convertedRule.jobPositions === undefined) {
      convertedRule.jobPositions = [];
    } else if (!Array.isArray(convertedRule.jobPositions)) {
      // If it's not an array, try to parse it or default to empty array
      convertedRule.jobPositions = [];
    }
    
    if (convertedRule.flatRateAmount !== undefined) {
      convertedRule.flatRateAmount = convertMonthlyToPayPeriod(convertedRule.flatRateAmount, payrollPeriod);
    }
    if (convertedRule.tierContributions) {
      const converted = { ...convertedRule.tierContributions };
      if (converted.employee_only !== undefined) {
        converted.employee_only = convertMonthlyToPayPeriod(converted.employee_only, payrollPeriod);
      }
      if (converted.employee_spouse !== undefined) {
        converted.employee_spouse = convertMonthlyToPayPeriod(converted.employee_spouse, payrollPeriod);
      }
      if (converted.employee_children !== undefined) {
        converted.employee_children = convertMonthlyToPayPeriod(converted.employee_children, payrollPeriod);
      }
      if (converted.family !== undefined) {
        converted.family = convertMonthlyToPayPeriod(converted.family, payrollPeriod);
      }
      convertedRule.tierContributions = converted;
    }
    if (convertedRule.minimumAmount !== undefined) {
      convertedRule.minimumAmount = convertMonthlyToPayPeriod(convertedRule.minimumAmount, payrollPeriod);
    }
    
    console.log('🔍 editRule - Setting editingRule with jobPositions:', convertedRule.jobPositions);
    setEditingRule(convertedRule);
    // Scroll to the form
    setTimeout(() => {
      const formElement = document.querySelector('[data-testid="contribution-form"]');
      if (formElement) {
        formElement.scrollIntoView({ behavior: 'smooth' });
      }
    }, 100);
  };

  const cancelEditing = () => {
    setEditingRule(null);
  };

  const deleteRule = async (ruleId: string) => {
    if (!selectedGroup) return;
    
    // Check if this is a valid UUID (from database) or a timestamp (local storage)
    const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ruleId);
    
    if (!isValidUUID) {
      // This is a locally stored rule, just remove from local storage
      const updatedRules = contributionRules.filter(rule => rule.contributionId !== ruleId);
      setContributionRules(updatedRules);
      localStorage.setItem(`contributions_${selectedGroup.GroupId}`, JSON.stringify(updatedRules));
      console.log('Deleted local rule');
      return;
    }

    // Confirm deletion
    if (!confirm('Are you sure you want to delete this contribution rule? This action cannot be undone.')) {
      return;
    }

    try {
      const result = await makeApiCall(`/api/groups/${selectedGroup.GroupId}/contributions/${ruleId}`, {
        method: 'DELETE'
      }) as any;
      
      if (result.success) {
        console.log('Contribution rule deleted successfully');
        console.log('Before refresh - rule count:', contributionRules.length);
        // Force refresh the rules from the database
        await fetchContributionRules(selectedGroup.GroupId);
      } else {
        console.error('Failed to delete contribution rule:', result.message);
        alert('Failed to delete contribution rule: ' + result.message);
      }
    } catch (error) {
      console.error('Error deleting contribution rule:', error);
      
      // Fallback to localStorage for development
      const updatedRules = contributionRules.filter(rule => rule.contributionId !== ruleId);
      setContributionRules(updatedRules);
      localStorage.setItem(`contributions_${selectedGroup.GroupId}`, JSON.stringify(updatedRules));
      alert('Deleted contribution rule locally due to connection error');
    }
  };

  const duplicateRule = (rule: ContributionRule) => {
    // Convert monthly amounts to pay period amounts for display
    const duplicated = { ...rule };
    if (duplicated.flatRateAmount !== undefined) {
      duplicated.flatRateAmount = convertMonthlyToPayPeriod(duplicated.flatRateAmount, payrollPeriod);
    }
    if (duplicated.tierContributions) {
      const converted = { ...duplicated.tierContributions };
      if (converted.employee_only !== undefined) {
        converted.employee_only = convertMonthlyToPayPeriod(converted.employee_only, payrollPeriod);
      }
      if (converted.employee_spouse !== undefined) {
        converted.employee_spouse = convertMonthlyToPayPeriod(converted.employee_spouse, payrollPeriod);
      }
      if (converted.employee_children !== undefined) {
        converted.employee_children = convertMonthlyToPayPeriod(converted.employee_children, payrollPeriod);
      }
      if (converted.family !== undefined) {
        converted.family = convertMonthlyToPayPeriod(converted.family, payrollPeriod);
      }
      duplicated.tierContributions = converted;
    }
    if (duplicated.minimumAmount !== undefined) {
      duplicated.minimumAmount = convertMonthlyToPayPeriod(duplicated.minimumAmount, payrollPeriod);
    }
    // Set the duplicated rule as the new contribution being edited
    duplicated.contributionId = undefined; // Will be generated when saved
    duplicated.name = `${rule.name} (Copy)`;
    duplicated.createdDate = undefined; // Will be set when saved
    setNewContribution(duplicated);
    setEditingRule(null); // Make sure we're not in edit mode
    // Scroll to the form
    setTimeout(() => {
      const formElement = document.querySelector('[data-testid="contribution-form"]');
      if (formElement) {
        formElement.scrollIntoView({ behavior: 'smooth' });
      }
    }, 100);
  };

  const resetForm = () => {
    setNewContribution({
      contributionType: 'flat_rate',
      contributionDirection: 'Employer',
      effectiveDate: getFirstOfCurrentMonth(),
      status: 'Active',
      priority: 1,
      stacking: true,
      name: '',
      description: ''
    });
  };

  // Safe function to format contribution type text
  const formatContributionType = (contributionType: string | undefined) => {
    if (!contributionType) return 'UNKNOWN CONTRIBUTION';
    return contributionType.replace(/_/g, ' ').toUpperCase() + ' CONTRIBUTION';
  };

  const renderContributionForm = () => {
    const isEditing = editingRule !== null;
    const currentRule = isEditing ? editingRule : newContribution;
    const contributionType = currentRule?.contributionType;

    const updateCurrentRule = (updates: Partial<ContributionRule>) => {
      if (isEditing) {
        setEditingRule(prev => prev ? { ...prev, ...updates } : null);
      } else {
        setNewContribution(prev => ({ ...prev, ...updates }));
      }
    };

    return (
      <div className="space-y-6 border-t pt-6" data-testid="contribution-form">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            {isEditing ? <Edit className="h-5 w-5 text-oe-success" /> : <Plus className="h-5 w-5 text-oe-primary" />}
            <h4 className="text-lg font-semibold text-gray-900">
              {isEditing ? `Edit Contribution Rule: ${editingRule?.name}` : 'Add New Contribution Rule'}
            </h4>
          </div>
          {isEditing && (
            <button
              onClick={cancelEditing}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
        
        {/* Basic Information */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Rule Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={currentRule?.name || ''}
              onChange={(e) => updateCurrentRule({ name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              placeholder="e.g., Base Medical Contribution"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
            <input
              type="number"
              min="0"
              value={currentRule?.priority || 1}
              onChange={(e) => updateCurrentRule({ priority: parseInt(e.target.value) })}
              onWheel={(e) => e.currentTarget.blur()}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              placeholder="1"
            />
            <p className="text-xs text-gray-500 mt-1">Lower numbers = higher priority</p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea
            value={currentRule?.description || ''}
            onChange={(e) => updateCurrentRule({ description: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
            rows={2}
            placeholder="Optional description of this rule..."
          />
        </div>

        {/* Product Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Apply to Product (Optional)
          </label>
          <select
            value={currentRule?.productId || ''}
            onChange={(e) => updateCurrentRule({ 
              productId: e.target.value || undefined,
              productName: e.target.value ? products.find(p => p.ProductId === e.target.value)?.Name : undefined
            })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="">All Products</option>
            {products.map((product) => (
              <option key={product.ProductId} value={product.ProductId}>
                {product.Name} ({product.ProductType})
              </option>
            ))}
          </select>
        </div>

        {/* Contribution Direction */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Contribution Direction <span className="text-red-500">*</span>
          </label>
          <select
            value={currentRule?.contributionDirection || 'Employer'}
            onChange={(e) => updateCurrentRule({ 
              contributionDirection: e.target.value as 'Employer' | 'MaxEmployee'
            })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="Employer">Employer Contribution (Default)</option>
            <option value="MaxEmployee">Max Employee Contribution</option>
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {currentRule?.contributionDirection === 'MaxEmployee' 
              ? 'Employee pays up to the specified amount; employer covers the rest'
              : 'Employer pays the specified amount or percentage; employee pays the remainder'}
          </p>
        </div>

        {/* Contribution Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Contribution Type <span className="text-red-500">*</span>
          </label>
          <select
            value={contributionType}
            onChange={(e) => {
              const newType = e.target.value as ContributionRule['contributionType'];
              const updates: Partial<ContributionRule> = { contributionType: newType };
              
              // Initialize ageRules if switching to age_based
              if (newType === 'age_based' && !currentRule?.ageRules) {
                updates.ageRules = [{ minAge: 0, maxAge: undefined, contributionAmount: 0, contributionType: 'flat' }];
              }
              
              updateCurrentRule(updates);
            }}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="flat_rate">💵 Flat Rate</option>
            <option value="percentage">📊 Percentage</option>
            <option value="tier_based">👥 Tier Based (EE/ES/EC/Family)</option>
            <option value="age_based">🎂 Age Based</option>
          </select>
        </div>

        {/* Dynamic Form Fields */}
        {contributionType === 'flat_rate' && (
          <div className="bg-oe-light p-4 rounded-lg">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {getContributionAmountLabel(payrollPeriod)} ($) <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              step="0.01"
              value={currentRule?.flatRateAmount || ''}
              onChange={(e) => {
                const value = e.target.value;
                // Round to 2 decimals to prevent floating point errors (e.g., 178.0000001 -> 178.00)
                const rounded = value === '' ? undefined : Math.round(parseFloat(value) * 100) / 100;
                updateCurrentRule({ flatRateAmount: rounded });
              }}
              onWheel={(e) => e.currentTarget.blur()}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              placeholder="400.00"
            />
            {payrollPeriod !== 'Monthly' && currentRule?.flatRateAmount && (
              <p className="text-xs text-gray-500 mt-1">
                Monthly equivalent: ${convertPayPeriodToMonthly(currentRule.flatRateAmount, payrollPeriod).toFixed(2)}
              </p>
            )}
          </div>
        )}

        {contributionType === 'percentage' && (
          <div className="bg-green-50 p-4 rounded-lg">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Contribution Percentage (%) <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={currentRule?.percentageAmount || ''}
              onChange={(e) => {
                const value = e.target.value;
                // Round to 2 decimals to prevent floating point errors
                const rounded = value === '' ? undefined : Math.round(parseFloat(value) * 100) / 100;
                updateCurrentRule({ percentageAmount: rounded });
              }}
              onWheel={(e) => e.currentTarget.blur()}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              placeholder="80"
            />
            <p className="text-xs text-gray-600 mt-2 flex items-center">
              <Info className="h-3 w-3 mr-1" />
              Percentage of premium the employer pays {getPayPeriodLabel(payrollPeriod)} (e.g., 80% = employer pays 80%, employee pays 20%)
            </p>
          </div>
        )}

        {contributionType === 'tier_based' && (
          <div className="bg-purple-50 p-4 rounded-lg">
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Contribution by Coverage Tier ({getShortPeriodLabel(payrollPeriod)}) <span className="text-red-500">*</span>
            </label>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">👤 Employee Only</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentRule?.tierContributions?.employee_only || ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    // Round to 2 decimals to prevent floating point errors
                    const rounded = value === '' ? undefined : Math.round(parseFloat(value) * 100) / 100;
                    updateCurrentRule({ 
                      tierContributions: { ...currentRule?.tierContributions, employee_only: rounded }
                    });
                  }}
                  onWheel={(e) => e.currentTarget.blur()}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="500.00"
                />
                {payrollPeriod !== 'Monthly' && currentRule?.tierContributions?.employee_only && (
                  <p className="text-xs text-gray-500 mt-1">
                    Monthly: ${convertPayPeriodToMonthly(currentRule.tierContributions.employee_only, payrollPeriod).toFixed(2)}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">👥 Employee + Spouse</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentRule?.tierContributions?.employee_spouse || ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    // Round to 2 decimals to prevent floating point errors
                    const rounded = value === '' ? undefined : Math.round(parseFloat(value) * 100) / 100;
                    updateCurrentRule({ 
                      tierContributions: { ...currentRule?.tierContributions, employee_spouse: rounded }
                    });
                  }}
                  onWheel={(e) => e.currentTarget.blur()}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="800.00"
                />
                {payrollPeriod !== 'Monthly' && currentRule?.tierContributions?.employee_spouse && (
                  <p className="text-xs text-gray-500 mt-1">
                    Monthly: ${convertPayPeriodToMonthly(currentRule.tierContributions.employee_spouse, payrollPeriod).toFixed(2)}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">👨‍👩‍👧 Employee + Children</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentRule?.tierContributions?.employee_children || ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    // Round to 2 decimals to prevent floating point errors
                    const rounded = value === '' ? undefined : Math.round(parseFloat(value) * 100) / 100;
                    updateCurrentRule({ 
                      tierContributions: { ...currentRule?.tierContributions, employee_children: rounded }
                    });
                  }}
                  onWheel={(e) => e.currentTarget.blur()}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="750.00"
                />
                {payrollPeriod !== 'Monthly' && currentRule?.tierContributions?.employee_children && (
                  <p className="text-xs text-gray-500 mt-1">
                    Monthly: ${convertPayPeriodToMonthly(currentRule.tierContributions.employee_children, payrollPeriod).toFixed(2)}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">👨‍👩‍👧‍👦 Family</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentRule?.tierContributions?.family || ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    // Round to 2 decimals to prevent floating point errors
                    const rounded = value === '' ? undefined : Math.round(parseFloat(value) * 100) / 100;
                    updateCurrentRule({ 
                      tierContributions: { ...currentRule?.tierContributions, family: rounded }
                    });
                  }}
                  onWheel={(e) => e.currentTarget.blur()}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="1000.00"
                />
                {payrollPeriod !== 'Monthly' && currentRule?.tierContributions?.family && (
                  <p className="text-xs text-gray-500 mt-1">
                    Monthly: ${convertPayPeriodToMonthly(currentRule.tierContributions.family, payrollPeriod).toFixed(2)}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {contributionType === 'age_based' && (
          <div className="bg-blue-50 p-4 rounded-lg">
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Contribution by Age Range ({getShortPeriodLabel(payrollPeriod)}) <span className="text-red-500">*</span>
            </label>
            <p className="text-xs text-gray-600 mb-4">
              Define age ranges and contribution amounts. Members will be matched to the first applicable age range.
            </p>
            
            <div className="space-y-4">
              {(currentRule?.ageRules && currentRule.ageRules.length > 0 ? currentRule.ageRules : [{ minAge: 0, maxAge: undefined, contributionAmount: 0, contributionType: 'flat' }]).map((ageRule, index) => (
                <div key={index} className="bg-white p-4 rounded-lg border border-gray-200">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Min Age <span className="text-red-500">*</span></label>
                      <input
                        type="number"
                        min="0"
                        max="120"
                        value={ageRule.minAge || ''}
                        onChange={(e) => {
                          const updatedRules = [...(currentRule?.ageRules || [])];
                          updatedRules[index] = { ...ageRule, minAge: parseInt(e.target.value) || 0 };
                          updateCurrentRule({ ageRules: updatedRules });
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                        placeholder="0"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Max Age (Optional)</label>
                      <input
                        type="number"
                        min="0"
                        max="120"
                        value={ageRule.maxAge || ''}
                        onChange={(e) => {
                          const updatedRules = [...(currentRule?.ageRules || [])];
                          updatedRules[index] = { ...ageRule, maxAge: e.target.value ? parseInt(e.target.value) : undefined };
                          updateCurrentRule({ ageRules: updatedRules });
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                        placeholder="Leave empty for 120+"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Contribution Type</label>
                      <select
                        value={ageRule.contributionType || 'flat'}
                        onChange={(e) => {
                          const updatedRules = [...(currentRule?.ageRules || [])];
                          updatedRules[index] = { ...ageRule, contributionType: e.target.value as 'flat' | 'percentage' };
                          updateCurrentRule({ ageRules: updatedRules });
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                      >
                        <option value="flat">Flat Amount</option>
                        <option value="percentage">Percentage</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Contribution Amount {ageRule.contributionType === 'percentage' ? '(%)' : '($)'} <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={ageRule.contributionAmount || ''}
                        onChange={(e) => {
                          const value = e.target.value;
                          // Round to 2 decimals to prevent floating point errors (e.g., 178.0000001 -> 178.00)
                          const rounded = value === '' ? 0 : Math.round(parseFloat(value) * 100) / 100;
                          const updatedRules = [...(currentRule?.ageRules || [])];
                          updatedRules[index] = { ...ageRule, contributionAmount: rounded };
                          updateCurrentRule({ ageRules: updatedRules });
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                        placeholder={ageRule.contributionType === 'percentage' ? "80" : "400.00"}
                      />
                      {payrollPeriod !== 'Monthly' && ageRule.contributionType === 'flat' && ageRule.contributionAmount && (
                        <p className="text-xs text-gray-500 mt-1">
                          Monthly: ${convertPayPeriodToMonthly(ageRule.contributionAmount, payrollPeriod).toFixed(2)}
                        </p>
                      )}
                    </div>
                  </div>
                  {index > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        const updatedRules = currentRule?.ageRules?.filter((_, i) => i !== index) || [];
                        updateCurrentRule({ ageRules: updatedRules });
                      }}
                      className="mt-3 text-xs text-red-600 hover:text-red-800"
                    >
                      Remove this age range
                    </button>
                  )}
                </div>
              ))}
            </div>
            
            <button
              type="button"
              onClick={() => {
                const currentRules = currentRule?.ageRules || [];
                updateCurrentRule({ 
                  ageRules: [...currentRules, { minAge: 0, maxAge: undefined, contributionAmount: 0, contributionType: 'flat' }]
                });
              }}
              className="mt-4 px-4 py-2 text-sm bg-blue-100 text-oe-primary-dark rounded-md hover:bg-blue-200"
            >
              + Add Another Age Range
            </button>
            
            <p className="text-xs text-gray-500 mt-3">
              <Info className="h-3 w-3 inline mr-1" />
              Example: Ages 0-25: $100, Ages 26-40: $150, Ages 41+: $200
            </p>
          </div>
        )}

        {/* Job Position Filter (Optional - applies to all contribution types) */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Job Position Filter (Optional)
          </label>
          <p className="text-xs text-gray-500 mb-2">
            Select job positions to apply this rule to. Leave empty to apply to all job positions.
          </p>
          <div className="flex gap-2 mb-2">
            <button
              type="button"
              onClick={() => updateCurrentRule({ jobPositions: DEFAULT_JOB_POSITIONS.map(p => p.id) })}
              className="px-3 py-1 text-sm text-oe-primary bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100"
            >
              Select All
            </button>
            <button
              type="button"
              onClick={() => updateCurrentRule({ jobPositions: [] })}
              className="px-3 py-1 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-md hover:bg-gray-100"
            >
              Clear All
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto p-4 border border-gray-300 rounded-lg bg-gray-50">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {DEFAULT_JOB_POSITIONS.map((position) => {
                // Handle null/undefined jobPositions - treat as empty array
                const jobPositionsArray = Array.isArray(currentRule?.jobPositions) ? currentRule.jobPositions : [];
                const isSelected = jobPositionsArray.includes(position.id);
                return (
                  <label key={position.id} className="flex items-center text-sm cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(e) => {
                        const current = Array.isArray(currentRule?.jobPositions) ? currentRule.jobPositions : [];
                        const updated = e.target.checked
                          ? [...current, position.id]
                          : current.filter(id => id !== position.id);
                        // Save as empty array if nothing selected, or undefined to clear the filter
                        updateCurrentRule({ jobPositions: updated.length > 0 ? updated : [] });
                      }}
                      className="h-4 w-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                    />
                    <span className="ml-2 group-hover:text-oe-primary transition-colors">
                      {position.label}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Selected: {currentRule?.jobPositions?.length || 0} of {DEFAULT_JOB_POSITIONS.length} job positions
            {(!currentRule?.jobPositions || currentRule.jobPositions.length === 0) && (
              <span className="text-oe-primary"> (applies to all job positions)</span>
            )}
          </p>
        </div>

        {/* Rule Settings */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Effective Date <span className="text-red-500">*</span>
            </label>
            <input
              type="date"
              value={currentRule?.effectiveDate}
              onChange={(e) => {
                const firstOfMonth = handleDateChange(e.target.value);
                updateCurrentRule({ effectiveDate: firstOfMonth });
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Date (Optional)</label>
            <input
              type="date"
              value={currentRule?.endDate || ''}
              onChange={(e) => {
                const firstOfMonth = e.target.value ? handleDateChange(e.target.value) : '';
                updateCurrentRule({ endDate: firstOfMonth || undefined });
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              value={currentRule?.status}
              onChange={(e) => updateCurrentRule({ status: e.target.value as any })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
              <option value="Pending">Pending</option>
            </select>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={currentRule?.stacking}
              onChange={(e) => updateCurrentRule({ stacking: e.target.checked })}
              className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
            />
            <span className="text-sm text-gray-700">Allow Stacking</span>
          </label>
          <p className="text-xs text-gray-500">
            When enabled, this rule can be combined with other rules
          </p>
        </div>

        <div className="flex justify-end space-x-3 pt-4">
          <button
            type="button"
            onClick={isEditing ? cancelEditing : resetForm}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            {isEditing ? 'Cancel' : 'Reset'}
          </button>
          <button
            type="button"
            onClick={isEditing ? updateContributionRule : addContributionRule}
            className={`px-4 py-2 text-sm font-medium text-white border border-transparent rounded-md flex items-center space-x-2 ${
              isEditing ? 'bg-oe-success hover:bg-green-700' : 'bg-oe-primary hover:bg-oe-dark'
            }`}
          >
            {isEditing ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            <span>{isEditing ? 'Save Changes' : 'Add Rule'}</span>
          </button>
        </div>
      </div>
    );
  };

  const renderCalculator = () => {
    const calculation = calculateEmployerContribution(sampleEmployee, samplePlan);
    const employeeContribution = samplePlan.monthlyPremium - calculation.totalContribution;

    return (
      <div className="space-y-6">
        <div className="bg-gradient-to-r from-oe-primary to-purple-600 text-white p-6 rounded-lg">
          <h3 className="text-lg font-semibold flex items-center space-x-2">
            <Target className="h-5 w-5" />
            <span>Contribution Calculator</span>
          </h3>
          <p className="text-blue-100 mt-1">Test your contribution rules with sample data</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Employee Details */}
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <h4 className="font-semibold text-gray-900 mb-3 flex items-center space-x-2">
              <UserCheck className="h-4 w-4 text-oe-primary" />
              <span>Sample Employee</span>
            </h4>
            <div className="space-y-2 text-sm">
              <div><span className="font-medium">Name:</span> {sampleEmployee.firstName} {sampleEmployee.lastName}</div>
              <div><span className="font-medium">Role:</span> {sampleEmployee.role}</div>
              <div><span className="font-medium">Division:</span> {sampleEmployee.division}</div>
              <div><span className="font-medium">Employment:</span> {sampleEmployee.employmentClass}</div>
              <div><span className="font-medium">Start Date:</span> {sampleEmployee.startDate}</div>
              <div><span className="font-medium">Years of Service:</span> {getYearsOfService(sampleEmployee.startDate)} years</div>
              <div><span className="font-medium">Coverage Tier:</span> {sampleEmployee.coverageTier}</div>
            </div>
          </div>

          {/* Plan Details */}
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <h4 className="font-semibold text-gray-900 mb-3 flex items-center space-x-2">
              <Shield className="h-4 w-4 text-oe-success" />
              <span>Selected Plan</span>
            </h4>
            <div className="space-y-2 text-sm">
              <div><span className="font-medium">Plan:</span> {samplePlan.name}</div>
              <div><span className="font-medium">Type:</span> {samplePlan.planType}</div>
              <div><span className="font-medium">Monthly Premium:</span> ${samplePlan.monthlyPremium}</div>
            </div>
          </div>
        </div>

        {/* Calculation Results */}
        <div className="bg-gradient-to-r from-green-50 to-oe-light border border-green-200 rounded-lg p-6">
          <h4 className="font-semibold text-gray-900 mb-4 flex items-center space-x-2">
            <TrendingUp className="h-5 w-5 text-oe-success" />
            <span>Calculation Results</span>
          </h4>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-oe-success">${calculation.totalContribution}</div>
              <div className="text-sm text-gray-600">Employer Pays</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-oe-primary">${employeeContribution.toFixed(2)}</div>
              <div className="text-sm text-gray-600">Employee Pays</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-600">${samplePlan.monthlyPremium}</div>
              <div className="text-sm text-gray-600">Total Premium</div>
            </div>
          </div>

          <div className="bg-white rounded-lg p-4">
            <h5 className="font-medium text-gray-900 mb-2">Applied Rules:</h5>
            <div className="space-y-1">
              {calculation.appliedRules.map((rule, index) => (
                <div key={index} className="text-sm text-gray-700 flex items-center space-x-2">
                  <Check className="h-3 w-3 text-oe-success" />
                  <span>{rule}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (!isOpen || !selectedGroup) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-6xl w-full max-h-[95vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h3 className="text-xl font-semibold text-gray-900 flex items-center space-x-2">
              <Settings className="h-6 w-6 text-oe-primary" />
              <span>Contribution Settings - {selectedGroup.Name}</span>
            </h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-6 border-b border-gray-200">
          <nav className="-mb-px flex space-x-8">
            <button
              onClick={() => setActiveTab('rules')}
              className={`py-3 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'rules'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <div className="flex items-center space-x-2">
                <Layers className="h-4 w-4" />
                <span>Contribution Rules ({contributionRules.length})</span>
              </div>
            </button>
            <button
              onClick={() => setActiveTab('calculator')}
              className={`py-3 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'calculator'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <div className="flex items-center space-x-2">
                <Target className="h-4 w-4" />
                <span>Calculator</span>
              </div>
            </button>
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'rules' && (
            <div className="space-y-6">
              {/* Existing Rules */}
              <div>
                <h4 className="text-lg font-semibold text-gray-900 mb-4">Current Contribution Rules</h4>
                
                {contributionRules.length === 0 ? (
                  <div className="text-center py-12 text-gray-500 border-2 border-dashed border-gray-300 rounded-lg">
                    <Settings className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <p className="text-lg font-medium">No contribution rules configured</p>
                    <p className="text-sm">Add your first contribution rule below to get started</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {contributionRules
                      .sort((a, b) => a.priority - b.priority)
                      .map((rule) => (
                        <div key={rule.contributionId} className="border border-gray-200 rounded-lg p-4 hover:shadow-sm transition-shadow">
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center space-x-3 mb-2">
                                <div className="flex items-center space-x-2">
                                  <div className="w-6 h-6 bg-oe-light text-oe-primary rounded-full flex items-center justify-center text-xs font-medium">
                                    {rule.priority}
                                  </div>
                                  <h4 className="font-semibold text-gray-900">{rule.name}</h4>
                                </div>
                                <div className="flex items-center space-x-2">
                                  <span className={`px-2 py-1 text-xs rounded-full ${
                                    rule.status === 'Active' ? 'bg-green-100 text-green-800' : 
                                    rule.status === 'Pending' ? 'bg-yellow-100 text-yellow-800' :
                                    'bg-gray-100 text-gray-800'
                                  }`}>
                                    {rule.status}
                                  </span>
                                  {rule.stacking && (
                                    <span className="px-2 py-1 text-xs bg-oe-light text-oe-primary rounded-full">
                                      Stacking
                                    </span>
                                  )}
                                  {rule.productName && (
                                    <span className="px-2 py-1 text-xs bg-purple-100 text-purple-800 rounded-full">
                                      {rule.productName}
                                    </span>
                                  )}
                                </div>
                              </div>
                              
                              {rule.description && (
                                <p className="text-sm text-gray-600 mb-3">{rule.description}</p>
                              )}
                              
                              <div className="bg-gray-50 rounded-lg p-3">
                                <div className="text-sm">
                                  <div className="font-medium text-gray-700 mb-1">
                                    {formatContributionType(rule.contributionType)}
                                    {rule.contributionDirection === 'MaxEmployee' && (
                                      <span className="ml-2 text-xs text-oe-primary font-normal">(Max Employee Contribution)</span>
                                    )}
                                  </div>
                                  
                                  {rule.contributionType === 'flat_rate' && rule.flatRateAmount !== undefined && (
                                    <p><strong>{formatContributionDisplay(rule.flatRateAmount, payrollPeriod)}</strong> per employee</p>
                                  )}
                                  
                                  {rule.contributionType === 'percentage' && (
                                    <p><strong>{rule.percentageAmount}%</strong> of premium {payrollPeriod === 'Monthly' ? 'per month' : 'per pay period'}</p>
                                  )}
                                  
                                  {rule.contributionType === 'tier_based' && rule.tierContributions && (
                                    <div className="grid grid-cols-2 gap-2">
                                      {rule.tierContributions.employee_only !== undefined && (
                                        <span>👤 EE: {formatContributionDisplay(rule.tierContributions.employee_only, payrollPeriod)}</span>
                                      )}
                                      {rule.tierContributions.employee_spouse !== undefined && (
                                        <span>👥 ES: {formatContributionDisplay(rule.tierContributions.employee_spouse, payrollPeriod)}</span>
                                      )}
                                      {rule.tierContributions.employee_children !== undefined && (
                                        <span>👨‍👩‍👧 EC: {formatContributionDisplay(rule.tierContributions.employee_children, payrollPeriod)}</span>
                                      )}
                                      {rule.tierContributions.family !== undefined && (
                                        <span>👨‍👩‍👧‍👦 Family: {formatContributionDisplay(rule.tierContributions.family, payrollPeriod)}</span>
                                      )}
                                    </div>
                                  )}
                                  
                                </div>
                              </div>
                              
                              <div className="flex items-center justify-between mt-3 text-xs text-gray-500">
                                <span>Effective: {new Date(rule.effectiveDate).toLocaleDateString()}</span>
                                {rule.endDate && <span>Ends: {new Date(rule.endDate).toLocaleDateString()}</span>}
                              </div>
                            </div>
                            
                            <div className="flex items-center space-x-2 ml-4">
                              <button
                                onClick={() => duplicateRule(rule)}
                                className="text-oe-primary hover:text-oe-dark p-1 rounded"
                                title="Duplicate Rule"
                              >
                                <Copy className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => startEditingRule(rule)}
                                className="text-oe-success hover:text-green-700 p-1 rounded"
                                title="Edit Rule"
                              >
                                <Edit className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => deleteRule(rule.contributionId)}
                                className="text-oe-error hover:text-red-700 p-1 rounded"
                                title="Delete Rule"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {/* Add New Rule Form */}
              {renderContributionForm()}
            </div>
          )}

          {activeTab === 'calculator' && renderCalculator()}
        </div>
      </div>
    </div>
  );
};

export default GroupsContributions;