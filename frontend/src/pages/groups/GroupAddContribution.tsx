import {
    ChevronDown,
    ChevronUp,
    Edit,
    Layers,
    Plus,
    Save,
    Target,
    UserCheck,
    X
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useCreateContribution, useGroupProducts, useUpdateContribution } from '../../hooks/useGroups';
import { useGroupDetails } from '../../hooks/useGroupDetails';
import { ContributionRule, Group } from '../../services/groups.service';
import { 
  convertMonthlyToPayPeriod, 
  convertPayPeriodToMonthly, 
  getContributionAmountLabel,
  getShortPeriodLabel,
  type PayrollPeriod 
} from '../../utils/payrollPeriodConverter';
import { DEFAULT_JOB_POSITIONS } from '../../constants/jobPositions';

interface GroupAddContributionProps {
    isOpen: boolean;
    onClose: () => void;
    selectedGroup: Group | null;
    editingRule?: ContributionRule | null;
    /** When set, form is pre-filled from this rule (name "Copy of ...") and save creates a new rule */
    duplicateFromRule?: ContributionRule | null;
    onSaveSuccess: () => void;
}

// --- COMPONENT ---

const GroupAddContribution: React.FC<GroupAddContributionProps> = ({
    isOpen,
    onClose,
    selectedGroup,
    editingRule,
    duplicateFromRule,
    onSaveSuccess
}) => {
    // --- STATE MANAGEMENT ---
    useAuth();
    const [formData, setFormData] = useState<Partial<ContributionRule>>({});
    const [applyToAllEmployees, setApplyToAllEmployees] = useState<boolean>(true);
    const [activeTab, setActiveTab] = useState<'form' | 'calculator'>('form');
    const [productDropdownOpen, setProductDropdownOpen] = useState<boolean>(false);
    const productDropdownRef = useRef<HTMLDivElement>(null);
    const isEditing = !!editingRule && !duplicateFromRule;

    // Get group details to access PayrollPeriod setting
    const { data: groupData } = useGroupDetails(selectedGroup?.GroupId);
    const payrollPeriod: PayrollPeriod = (groupData as any)?.PayrollPeriod || 'Monthly';

    // Use our hooks for data fetching and mutations
    const { 
        data: groupProductsData, 
        isLoading: productsLoading 
    } = useGroupProducts(selectedGroup?.GroupId || '');
    
    // Extract products from the hook response
    const products = groupProductsData || [];
    
    const createContributionMutation = useCreateContribution();
    const updateContributionMutation = useUpdateContribution();

    // --- MOCK DATA FOR CALCULATOR ---
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
        if (isOpen) {
            const sourceRule = editingRule || duplicateFromRule;
            if (sourceRule) {
                // Convert monthly amounts to pay period amounts for display
                const convertedRule = { ...sourceRule };
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
                // Normalize jobPositions to array for the form
                if (convertedRule.jobPositions == null || !Array.isArray(convertedRule.jobPositions)) {
                    convertedRule.jobPositions = typeof convertedRule.jobPositions === 'string'
                        ? (() => { try { return JSON.parse(convertedRule.jobPositions as string); } catch { return []; } })()
                        : [];
                }
                // Multi-product: prefer productIds, fallback to single productId
                const productIds = (convertedRule as any).productIds ?? (convertedRule.productId ? [convertedRule.productId] : []);
                setApplyToAllEmployees(!(Array.isArray(convertedRule.jobPositions) && convertedRule.jobPositions.length > 0));
                // Duplicate: use "Copy of ..." and omit contributionId so save creates a new rule
                const formPayload = { ...convertedRule, productIds };
                if (duplicateFromRule) {
                    formPayload.name = `Copy of ${sourceRule.name}`;
                    formPayload.contributionId = undefined as any;
                }
                setFormData(formPayload);
            } else {
                setApplyToAllEmployees(true);
                setFormData({
                    contributionType: 'flat_rate',
                    contributionDirection: 'Employer', // Default to Employer Contribution
                    effectiveDate: getFirstOfCurrentMonth(), // Default: first day of current month
                    status: 'Active',
                    priority: 1,
                    stacking: true,
                    name: '',
                    description: '',
                    productIds: [],
                });
            }
        }
    }, [isOpen, editingRule, duplicateFromRule, payrollPeriod]);

    // Close product dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (productDropdownRef.current && !productDropdownRef.current.contains(event.target as Node)) {
                setProductDropdownOpen(false);
            }
        };
        if (productDropdownOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [productDropdownOpen]);

    // --- HELPERS ---
    const getFirstOfCurrentMonth = () => {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    };

    const handleDateChange = (dateString: string) => {
        if (!dateString) return getFirstOfCurrentMonth();
        const date = new Date(dateString);
        return new Date(date.getFullYear(), date.getMonth(), 1).toISOString().split('T')[0];
    };

    const handleSave = async () => {
        if (!formData.name || !formData.contributionType || !selectedGroup) {
            alert('Please fill in required fields');
            return;
        }

        // Convert pay period amounts back to monthly for storage. Priority and stacking are fixed (1 and true).
        const dataToSave = { ...formData, priority: 1, stacking: true };
        // Normalize equivalentTier for persistence
        if (dataToSave.contributionType !== 'percentage') {
            dataToSave.equivalentTier = null;
        } else if (dataToSave.equivalentTier === undefined) {
            dataToSave.equivalentTier = null;
        }
        // Job position filtering:
        // - "Apply to all employees" means NO job filter (null in DB).
        // - Otherwise, store the selected job position ids (or null if empty).
        if (applyToAllEmployees) {
            dataToSave.jobPositions = null;
        } else {
            // Ensure jobPositions: null when empty (backend expects null or array of ids)
            if (dataToSave.jobPositions && Array.isArray(dataToSave.jobPositions) && dataToSave.jobPositions.length === 0) {
                dataToSave.jobPositions = null;
            } else if (!dataToSave.jobPositions) {
                dataToSave.jobPositions = null;
            }
        }
        // Multi-product: send productIds; backend accepts productIds (array) and uses productId as fallback when length === 1
        const selectedProductIds = Array.isArray(formData.productIds) ? formData.productIds : [];
        dataToSave.productIds = selectedProductIds.length > 0 ? selectedProductIds : [];
        if (selectedProductIds.length === 1) {
            (dataToSave as any).productId = selectedProductIds[0];
        } else {
            (dataToSave as any).productId = undefined;
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

        if (isEditing && formData.contributionId) {
            updateContributionMutation.mutate(
                {
                    groupId: selectedGroup.GroupId,
                    contributionId: formData.contributionId,
                    contributionData: dataToSave
                },
                {
                    onSuccess: (response) => {
                        if (response.success) {
                            onSaveSuccess();
                            onClose();
                        } else {
                            alert(`Failed to update contribution rule: ${response.message}`);
                        }
                    },
                    onError: (error) => {
                        alert('An error occurred while updating the contribution rule.');
                        console.error('Error updating contribution rule:', error);
                    }
                }
            );
        } else {
            createContributionMutation.mutate(
                {
                    groupId: selectedGroup.GroupId,
                    contributionData: dataToSave
                },
                {
                    onSuccess: (response) => {
                        if (response.success) {
                            onSaveSuccess();
                            onClose();
                        } else {
                            alert(`Failed to create contribution rule: ${response.message}`);
                        }
                    },
                    onError: (error: any) => {
                        const message = error?.response?.data?.message || error?.message || 'An error occurred while creating the contribution rule.';
                        alert(message);
                        console.error('Error creating contribution rule:', error);
                    }
                }
            );
        }
    };

    const updateFormData = (updates: Partial<ContributionRule>) => {
        setFormData(prev => ({ ...prev, ...updates }));
    };

    const calculateEmployerContribution = (employee: any, plan: any, rules: ContributionRule[]) => {
        const premium = plan?.monthlyPremium ?? 0;
        let employerContribution = 0;
        const appliedRules: string[] = [];

        for (const rule of rules) {
            if (!rule.contributionType) continue;
            const isMaxEmployee = rule.contributionDirection === 'MaxEmployee';
            let amount = 0;

            if (rule.contributionType === 'flat_rate' && rule.flatRateAmount != null) {
                amount = convertPayPeriodToMonthly(rule.flatRateAmount, payrollPeriod);
                appliedRules.push(isMaxEmployee ? `Max employee pays $${amount.toFixed(2)}/mo` : `${rule.name || 'Rule'}: $${amount.toFixed(2)}/mo`);
            } else if (rule.contributionType === 'percentage' && rule.percentageAmount != null) {
                // Calculator uses sample premium; equivalent-tier premiums are populated server-side during real pricing.
                const baseLabel = rule.equivalentTier ? `${rule.equivalentTier} equivalent` : 'premium';
                amount = premium * (rule.percentageAmount / 100);
                appliedRules.push(
                    isMaxEmployee
                        ? `Max employee pays $${amount.toFixed(2)} (${rule.percentageAmount}% of ${baseLabel} $${premium})`
                        : `${rule.name || 'Rule'}: ${rule.percentageAmount}% of ${baseLabel} = $${amount.toFixed(2)}`
                );
            } else if (rule.contributionType === 'tier_based' && rule.tierContributions) {
                const tier = String(employee?.coverageTier || 'employee_only').replace(/-/g, '_');
                const tierKey = tier === 'family' ? 'family' : tier === 'employee_spouse' ? 'employee_spouse' : tier === 'employee_children' ? 'employee_children' : 'employee_only';
                const tierAmount = rule.tierContributions[tierKey] ?? rule.tierContributions.employee_only ?? 0;
                amount = convertPayPeriodToMonthly(tierAmount, payrollPeriod);
                appliedRules.push(isMaxEmployee ? `Max employee pays $${amount.toFixed(2)}/mo (${tierKey})` : `${rule.name || 'Rule'}: ${tierKey} = $${amount.toFixed(2)}/mo`);
            }

            if (isMaxEmployee) {
                employerContribution = Math.max(0, premium - amount);
            } else {
                employerContribution += amount;
            }
        }

        return { totalContribution: employerContribution, appliedRules };
    };


    // --- RENDER LOGIC ---

    const renderCalculator = () => {
        const rulesToCalculate = editingRule ? [editingRule] : formData.name ? [formData] : [];
        const calculation = calculateEmployerContribution(sampleEmployee, samplePlan, rulesToCalculate as ContributionRule[]);
        const employeeContribution = samplePlan.monthlyPremium - calculation.totalContribution;

        return (
            <div className="space-y-6">
                <div className="bg-gradient-to-r from-oe-primary to-purple-600 text-white p-6 rounded-lg">
                    <h3 className="text-lg font-semibold flex items-center space-x-2">
                        <Target className="h-5 w-5" />
                        <span>Contribution Calculator</span>
                    </h3>
                    <p className="text-blue-100 mt-1">Test your new rule with sample data</p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Employee & Plan Details */}
                    <div className="bg-white border border-gray-200 rounded-lg p-4">
                        <h4 className="font-semibold text-gray-900 mb-3 flex items-center space-x-2">
                            <UserCheck className="h-4 w-4 text-oe-primary" />
                            <span>Sample Employee & Plan</span>
                        </h4>
                        <div className="space-y-2 text-sm">
                            <div><span className="font-medium">Role:</span> {sampleEmployee.role}</div>
                            <div><span className="font-medium">Coverage Tier:</span> {sampleEmployee.coverageTier}</div>
                            <div><span className="font-medium">Plan Premium:</span> ${samplePlan.monthlyPremium}</div>
                        </div>
                    </div>
                    {/* Calculation Results */}
                    <div className="bg-gradient-to-r from-green-50 to-oe-light border border-green-200 rounded-lg p-6">
                        <h4 className="font-semibold text-gray-900 mb-4">Calculation Results</h4>
                        <div className="grid grid-cols-2 gap-4 mb-4">
                            <div className="text-center">
                                <div className="text-2xl font-bold text-oe-success">${calculation.totalContribution.toFixed(2)}</div>
                                <div className="text-sm text-gray-600">Employer Pays</div>
                            </div>
                            <div className="text-center">
                                <div className="text-2xl font-bold text-oe-primary">${employeeContribution.toFixed(2)}</div>
                                <div className="text-sm text-gray-600">Employee Pays</div>
                            </div>
                        </div>
                        {calculation.appliedRules.length > 0 && (
                            <div className="text-xs text-gray-600 border-t border-green-200 pt-3 mt-3">
                                <span className="font-medium">Applied: </span>
                                {calculation.appliedRules.join('; ')}
                            </div>
                        )}
                        {rulesToCalculate.length > 0 && !calculation.appliedRules.length && (
                            <p className="text-xs text-amber-700 mt-2">Fill in rule amount (flat rate, %, or tier) to see a preview.</p>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    if (!isOpen || !selectedGroup) return null;

    if (productsLoading) {
        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                <div className="bg-white rounded-lg p-6">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto"></div>
                    <p className="mt-2 text-center text-gray-600">Loading...</p>
                </div>
            </div>
        );
    }

    const contributionType = formData.contributionType;
    const isSubmitting = createContributionMutation.isPending || updateContributionMutation.isPending;

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-lg max-w-4xl w-full max-h-[95vh] overflow-hidden flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-gray-200">
                    <h3 className="text-xl font-semibold text-gray-900 flex items-center space-x-2">
                        {isEditing ? <Edit className="h-5 w-5 text-oe-success" /> : <Plus className="h-5 w-5 text-oe-primary" />}
                        <span>{duplicateFromRule ? 'Duplicate Contribution Rule' : isEditing ? 'Edit Contribution Rule' : 'Add New Contribution Rule'}</span>
                    </h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
                        <X className="h-6 w-6" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="px-6 border-b border-gray-200">
                    <nav className="-mb-px flex space-x-8">
                        <button
                            onClick={() => setActiveTab('form')}
                            className={`py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-2 ${
                                activeTab === 'form'
                                    ? 'border-oe-primary text-oe-primary'
                                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                            }`}
                        >
                            <Layers className="h-4 w-4" />
                            <span>Rule Details</span>
                        </button>
                        <button
                            onClick={() => setActiveTab('calculator')}
                            className={`py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-2 ${
                                activeTab === 'calculator'
                                    ? 'border-oe-primary text-oe-primary'
                                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                            }`}
                        >
                            <Target className="h-4 w-4" />
                            <span>Calculator</span>
                        </button>
                    </nav>
                </div>

                {/* Form Content */}
                <div className="flex-1 overflow-y-auto p-6">
                    {activeTab === 'form' && (
                        <div className="space-y-6">
                            {/* Basic Information */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Rule Name <span className="text-red-500">*</span></label>
                                    <input
                                        type="text"
                                        value={formData.name || ''}
                                        onChange={(e) => updateFormData({ name: e.target.value })}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                                        placeholder="e.g., Base Medical Contribution"
                                    />
                                </div>
                            </div>

                            {/* Description */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                                <textarea
                                    value={formData.description || ''}
                                    onChange={(e) => updateFormData({ description: e.target.value })}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                                    rows={2}
                                    placeholder="Optional description of this rule..."
                                />
                            </div>

                            {/* Product Selection (multi-select with checkboxes) */}
                            <div ref={productDropdownRef} className="relative">
                                <label className="block text-sm font-medium text-gray-700 mb-1">Apply to Product (Optional)</label>
                                <button
                                    type="button"
                                    onClick={() => setProductDropdownOpen((o) => !o)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary text-left flex items-center justify-between bg-white"
                                >
                                    <span className="text-gray-700">
                                        {Array.isArray(formData.productIds) && formData.productIds.length > 0
                                            ? formData.productIds.length === 1
                                                ? products.find(p => p.ProductId === formData.productIds?.[0])?.Name ?? formData.productIds[0]
                                                : `${formData.productIds.length} products`
                                            : 'All Products'}
                                    </span>
                                    {productDropdownOpen ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
                                </button>
                                {productDropdownOpen && (
                                    <div className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg max-h-60 overflow-auto">
                                        <label className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100">
                                            <input
                                                type="checkbox"
                                                checked={!Array.isArray(formData.productIds) || formData.productIds.length === 0}
                                                onChange={() => updateFormData({ productIds: [], productId: undefined, productName: undefined })}
                                                className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                                            />
                                            <span className="text-sm text-gray-700">All Products</span>
                                        </label>
                                        {products.map((product) => {
                                            const selectedIds = Array.isArray(formData.productIds) ? formData.productIds : [];
                                            const checked = selectedIds.includes(product.ProductId);
                                            return (
                                                <label
                                                    key={product.ProductId}
                                                    className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={checked}
                                                        onChange={() => {
                                                            const next = checked
                                                                ? selectedIds.filter((id) => id !== product.ProductId)
                                                                : [...selectedIds, product.ProductId];
                                                            const productName = next.length === 1 ? products.find(p => p.ProductId === next[0])?.Name : undefined;
                                                            updateFormData({
                                                                productIds: next,
                                                                productId: next.length === 1 ? next[0] : undefined,
                                                                productName,
                                                            });
                                                        }}
                                                        className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                                                    />
                                                    <span className="text-sm text-gray-700">{product.Name} ({product.ProductType})</span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {/* Contribution Direction */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Contribution Direction <span className="text-red-500">*</span>
                                </label>
                                <select
                                    value={formData.contributionDirection || 'Employer'}
                                    onChange={(e) => updateFormData({ 
                                        contributionDirection: e.target.value as 'Employer' | 'MaxEmployee'
                                    })}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                                >
                                    <option value="Employer">Employer Contribution (Default)</option>
                                    <option value="MaxEmployee">Max Employee Contribution</option>
                                </select>
                                <p className="text-xs text-gray-500 mt-1">
                                    {formData.contributionDirection === 'MaxEmployee' 
                                        ? 'Employee pays up to the specified amount; employer covers the rest'
                                        : 'Employer pays the specified amount or percentage; employee pays the remainder'}
                                </p>
                            </div>

                            {/* Contribution Type */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Contribution Type <span className="text-red-500">*</span></label>
                                <select
                                    value={contributionType}
                                    onChange={(e) => updateFormData({ contributionType: e.target.value as ContributionRule['contributionType'] })}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                                >
                                    <option value="flat_rate">💵 Flat Rate</option>
                                    <option value="percentage">📊 Percentage</option>
                                    <option value="tier_based">👥 Tier Based</option>
                                </select>
                            </div>

                            {/* Dynamic Form Fields */}
                            {contributionType === 'flat_rate' && (
                                <div className="bg-oe-light/50 p-4 rounded-lg">
                                    <label className="block text-sm font-medium text-gray-700 mb-1">
                                        {getContributionAmountLabel(payrollPeriod)} ($) <span className="text-red-500">*</span>
                                    </label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={formData.flatRateAmount || ''}
                                        onChange={(e) => updateFormData({ flatRateAmount: parseFloat(e.target.value) })}
                                        onWheel={(e) => e.currentTarget.blur()}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                                    />
                                    {payrollPeriod !== 'Monthly' && (
                                        <p className="text-xs text-gray-500 mt-1">
                                            Monthly equivalent: ${formData.flatRateAmount ? convertPayPeriodToMonthly(formData.flatRateAmount, payrollPeriod).toFixed(2) : '0.00'}
                                        </p>
                                    )}
                                </div>
                            )}

                            {contributionType === 'percentage' && (
                                <div className="bg-green-50 p-4 rounded-lg space-y-4">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Percentage of</label>
                                        <select
                                            value={formData.equivalentTier ?? ''}
                                            onChange={(e) => updateFormData({
                                                // Use null (not undefined) so updates correctly clear the DB field
                                                equivalentTier: e.target.value === '' ? null : (e.target.value as 'EE' | 'ES' | 'EC' | 'EF')
                                            })}
                                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                                        >
                                            <option value="">Actual premium</option>
                                            <option value="EE">EE equivalent</option>
                                            <option value="ES">ES equivalent</option>
                                            <option value="EC">EC equivalent</option>
                                            <option value="EF">EF equivalent</option>
                                        </select>
                                        {(formData.equivalentTier === 'EE' || formData.equivalentTier === 'ES' || formData.equivalentTier === 'EC' || formData.equivalentTier === 'EF') && (
                                            <p className="text-xs text-gray-600 mt-1">
                                                Employer pays this % of the selected tier&apos;s premium (same age, tobacco, config) for everyone, regardless of their actual tier.
                                            </p>
                                        )}
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Contribution Percentage (%) <span className="text-red-500">*</span></label>
                                        <input
                                            type="number"
                                            step="0.01"
                                            min="0"
                                            max="100"
                                            value={formData.percentageAmount || ''}
                                            onChange={(e) => updateFormData({ percentageAmount: parseFloat(e.target.value) })}
                                            onWheel={(e) => e.currentTarget.blur()}
                                            className="w-full px-3 py-2 border border-gray-300 rounded-md"
                                        />
                                    </div>
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
                                                value={formData.tierContributions?.employee_only || ''}
                                                onChange={(e) => updateFormData({ tierContributions: { ...formData.tierContributions, employee_only: parseFloat(e.target.value) } })}
                                                onWheel={(e) => e.currentTarget.blur()}
                                                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                                            />
                                            {payrollPeriod !== 'Monthly' && formData.tierContributions?.employee_only && (
                                                <p className="text-xs text-gray-500 mt-1">
                                                    Monthly: ${convertPayPeriodToMonthly(formData.tierContributions.employee_only, payrollPeriod).toFixed(2)}
                                                </p>
                                            )}
                                        </div>
                                        <div>
                                            <label className="block text-xs font-medium text-gray-600 mb-1">👥 Employee + Spouse</label>
                                            <input
                                                type="number"
                                                step="0.01"
                                                value={formData.tierContributions?.employee_spouse || ''}
                                                onChange={(e) => updateFormData({ tierContributions: { ...formData.tierContributions, employee_spouse: parseFloat(e.target.value) } })}
                                                onWheel={(e) => e.currentTarget.blur()}
                                                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                                            />
                                            {payrollPeriod !== 'Monthly' && formData.tierContributions?.employee_spouse && (
                                                <p className="text-xs text-gray-500 mt-1">
                                                    Monthly: ${convertPayPeriodToMonthly(formData.tierContributions.employee_spouse, payrollPeriod).toFixed(2)}
                                                </p>
                                            )}
                                        </div>
                                        <div>
                                            <label className="block text-xs font-medium text-gray-600 mb-1">👨‍👩‍👧 Employee + Children</label>
                                            <input
                                                type="number"
                                                step="0.01"
                                                value={formData.tierContributions?.employee_children || ''}
                                                onChange={(e) => updateFormData({ tierContributions: { ...formData.tierContributions, employee_children: parseFloat(e.target.value) } })}
                                                onWheel={(e) => e.currentTarget.blur()}
                                                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                                            />
                                            {payrollPeriod !== 'Monthly' && formData.tierContributions?.employee_children && (
                                                <p className="text-xs text-gray-500 mt-1">
                                                    Monthly: ${convertPayPeriodToMonthly(formData.tierContributions.employee_children, payrollPeriod).toFixed(2)}
                                                </p>
                                            )}
                                        </div>
                                        <div>
                                            <label className="block text-xs font-medium text-gray-600 mb-1">👨‍👩‍👧‍👦 Family</label>
                                            <input
                                                type="number"
                                                step="0.01"
                                                value={formData.tierContributions?.family || ''}
                                                onChange={(e) => updateFormData({ tierContributions: { ...formData.tierContributions, family: parseFloat(e.target.value) } })}
                                                onWheel={(e) => e.currentTarget.blur()}
                                                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                                            />
                                            {payrollPeriod !== 'Monthly' && formData.tierContributions?.family && (
                                                <p className="text-xs text-gray-500 mt-1">
                                                    Monthly: ${convertPayPeriodToMonthly(formData.tierContributions.family, payrollPeriod).toFixed(2)}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Job Position Filter (Optional) */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Job Position Filter (Optional)
                                </label>
                                <div className="flex items-center gap-2 mb-2">
                                    <input
                                        id="applyToAllEmployees"
                                        type="checkbox"
                                        checked={applyToAllEmployees}
                                        onChange={(e) => {
                                            const checked = e.target.checked;
                                            setApplyToAllEmployees(checked);
                                            if (checked) {
                                                // Clearing job positions means "no job filter" (applies to everyone).
                                                updateFormData({ jobPositions: [] });
                                            }
                                        }}
                                        className="h-4 w-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                                    />
                                    <label htmlFor="applyToAllEmployees" className="text-sm text-gray-700">
                                        Apply to all employees
                                    </label>
                                </div>

                                <p className="text-xs text-gray-500 mb-2">
                                    {applyToAllEmployees
                                        ? 'Applies to everyone. Uncheck to filter by job position.'
                                        : 'Select job positions to apply this rule to.'}
                                </p>

                                <div className={applyToAllEmployees ? 'opacity-50 pointer-events-none' : ''}>
                                    <div className="flex gap-2 mb-2">
                                        <button
                                            type="button"
                                            onClick={() => updateFormData({ jobPositions: DEFAULT_JOB_POSITIONS.map(p => p.id) })}
                                            className="px-3 py-1 text-sm text-oe-primary bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100"
                                        >
                                            Select All
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => updateFormData({ jobPositions: [] })}
                                            className="px-3 py-1 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-md hover:bg-gray-100"
                                        >
                                            Clear All
                                        </button>
                                    </div>
                                    <div className="max-h-48 overflow-y-auto p-4 border border-gray-300 rounded-lg bg-gray-50">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                            {DEFAULT_JOB_POSITIONS.map((position) => {
                                                const jobPositionsArray = Array.isArray(formData.jobPositions) ? formData.jobPositions : [];
                                                const isSelected = jobPositionsArray.includes(position.id);
                                                return (
                                                    <label key={position.id} className="flex items-center text-sm cursor-pointer group">
                                                        <input
                                                            type="checkbox"
                                                            checked={isSelected}
                                                            onChange={(e) => {
                                                                const current = Array.isArray(formData.jobPositions) ? formData.jobPositions : [];
                                                                const updated = e.target.checked
                                                                    ? [...current, position.id]
                                                                    : current.filter((id: string) => id !== position.id);
                                                                updateFormData({ jobPositions: updated.length > 0 ? updated : [] });
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
                                        Selected: {Array.isArray(formData.jobPositions) ? formData.jobPositions.length : 0} of {DEFAULT_JOB_POSITIONS.length} job positions
                                    </p>
                                </div>
                            </div>
                            
                            {/* Rule Settings */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Effective Date <span className="text-red-500">*</span></label>
                                    <input
                                        type="date"
                                        value={formData.effectiveDate}
                                        onChange={(e) => updateFormData({ effectiveDate: handleDateChange(e.target.value) })}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">End Date (Optional)</label>
                                    <input
                                        type="date"
                                        value={formData.endDate || ''}
                                        onChange={(e) => updateFormData({ endDate: e.target.value ? handleDateChange(e.target.value) : undefined })}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                                    <select
                                        value={formData.status}
                                        onChange={(e) => updateFormData({ status: e.target.value as any })}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                                    >
                                        <option value="Active">Active</option>
                                        <option value="Inactive">Inactive</option>
                                        <option value="Pending">Pending</option>
                                    </select>
                                </div>
                            </div>

                        </div>
                    )}
                    {activeTab === 'calculator' && renderCalculator()}
                </div>

                {/* Footer */}
                <div className="flex justify-end space-x-3 p-6 border-t border-gray-200 bg-gray-50">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                        disabled={isSubmitting}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={isSubmitting}
                        className={`px-4 py-2 text-sm font-medium text-white border border-transparent rounded-md flex items-center space-x-2 ${isEditing ? 'bg-oe-success hover:bg-green-700' : 'bg-oe-primary hover:bg-oe-dark'} ${isSubmitting ? 'opacity-70 cursor-not-allowed' : ''}`}
                    >
                        {isEditing ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                        <span>
                            {isSubmitting 
                                ? (isEditing ? 'Saving...' : 'Adding...') 
                                : (isEditing ? 'Save Changes' : 'Add Rule')}
                        </span>
                    </button>
                </div>
            </div>
        </div>
    );
};

export default GroupAddContribution;