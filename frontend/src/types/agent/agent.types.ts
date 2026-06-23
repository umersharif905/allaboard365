// src/types/agent/agent.types.ts
/**
 * Type definitions for Agent portal
 * Handles agent-scoped member management and sales activities
 */

/** Dashboard recent row — aligns with GET /api/me/agent/payments list shape */
export interface AgentDashboardCommissionPaymentRow {
    paymentId: string;
    paymentDate: string;
    amount: number;
    status: string;
    paymentMethod?: string | null;
    sellingAgentId?: string | null;
    sellingAgentName?: string | null;
    isUplinePayment?: boolean;
    groupId?: string | null;
    groupName?: string | null;
    memberId?: string | null;
    memberName?: string | null;
    commissionAmount: number;
}

export interface AgentDashboardBillingPaymentRow {
    paymentId: string;
    amount: number;
    paymentDate: string;
    status: string;
    paymentMethod?: string | null;
    memberId?: string | null;
    groupId?: string | null;
    memberName?: string | null;
    groupName?: string | null;
}

export interface AgentMetrics {
    // New primary metrics
    totalActiveHouseholds: number;
    monthlyPremiumAmount: number;
    /** The agent's own human-readable code (e.g. "TEN-00042"). Null for agents without a code assigned. */
    agentCode?: string | null;
    /** Avg. monthly paid commission: mean of each completed calendar month's NACHA total in the trailing window (current month excluded; months with no payout excluded from the average). */
    estimatedMonthlyCommission: number;
    /** Months in the trailing window for `estimatedMonthlyCommission` (e.g. 12) */
    commissionPayoutAverageWindowMonths?: number;
    failedPayments: number;
    /** Scope used for the three headline totals */
    metricsScope?: 'agency' | 'downline' | 'none';
    /** When true, headline totals include agents beyond the viewer (show scope sublabel). */
    metricsScopeIncludesOtherAgents?: boolean;
    /** Your commission on recent payments (same filter as Commissions page default) */
    recentCommissionPayments?: AgentDashboardCommissionPaymentRow[];
    recentBillingPayments?: AgentDashboardBillingPaymentRow[];
    unresolvedFailedPaymentCount?: number;
    
    // Legacy metrics (kept for backward compatibility)
    totalActiveMembers: number;
    newMembersThisMonth: number;
    pendingEnrollments: number;
    commissionsMTD: number;
    commissionsYTD: number;
    upcomingPayments: number;
    pendingApplications: number;
    recentCommissions: CommissionRecord[];
    errors?: string[]; // To hold backend error messages
    assignedMembers?: number;
    assignedGroups?: number;
    monthlyCommission?: number;
    revenueGenerated?: number;
    conversionRate?: number;
    activeEnrollments?: number;
    recentActivity?: {
        newEnrollments: number;
        memberInteractions: number;
        quotesSent: number;
        meetingsScheduled: number;
    };
    performanceRanking?: {
        rank: number;
        totalAgents: number;
        category: string;
    };
}

export interface AgentMember {
  memberId: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  phoneNumber?: string;
  dateOfBirth?: string;
  address?: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
  };
  groupId?: string;
  groupName?: string;
  status: 'Active' | 'Inactive' | 'Pending';
  enrollmentStatus: 'Enrolled' | 'Pending' | 'Declined' | 'Not Started';
  lastContactDate?: string;
  nextFollowUpDate?: string;
  assignedDate: string;
  totalPremium: number;
  dependentCount: number;
  notes?: string;
  preferredContactMethod: 'Email' | 'Phone' | 'Text';
  lifecycleStage: 'Lead' | 'Prospect' | 'Member' | 'Renewal';
}

export interface AgentGroup {
  groupId: string;
  name: string;
  description?: string;
  companyName: string;
  contactPerson: string;
  contactEmail: string;
  contactPhone?: string;
  memberCount: number;
  enrolledCount: number;
  pendingCount: number;
  monthlyPremium: number;
  assignedDate: string;
  lastActivityDate?: string;
  renewalDate?: string;
  status: 'Active' | 'Inactive' | 'Renewal Due' | 'At Risk';
  enrollmentProgress: number; // percentage
  notes?: string;
}

export interface CommissionRecord {
  commissionId: string;
  date: string;
  amount: number;
  memberName: string;
  memberId: string;
  productName: string;
  productId: string;
  status: 'Paid' | 'Pending' | 'Cancelled';
}

export interface SalesActivity {
  id: string; // Corrected from activityId to id to match usage
  activityId: string;
  memberId?: string;
  groupId?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  activityType: 'Call' | 'Email' | 'Meeting' | 'Quote' | 'Enrollment' | 'Follow-up' | 'Note';
  subject: string;
  description?: string;
  scheduledDate?: string;
  completedDate?: string;
  status: 'Scheduled' | 'Completed' | 'Cancelled' | 'No Show';
  priority: 'Low' | 'Medium' | 'High' | 'Urgent';
  outcome?: string;
  nextAction?: string;
  nextActionDate?: string;
  attachments?: string[];
}

export interface CreateSalesActivityRequest {
  memberId?: string;
  groupId?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  activityType: 'Call' | 'Email' | 'Meeting' | 'Quote' | 'Enrollment' | 'Follow-up' | 'Note';
  subject: string;
  description?: string;
  scheduledDate?: string;
  priority: 'Low' | 'Medium' | 'High' | 'Urgent';
}

export interface EnrollmentLead {
  leadId: string;
  memberId?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  groupId?: string;
  groupName?: string;
  source: 'Referral' | 'Website' | 'Marketing' | 'Cold Call' | 'Group Enrollment';
  status: 'New' | 'Contacted' | 'Qualified' | 'Proposal Sent' | 'Enrolled' | 'Lost';
  priority: 'Low' | 'Medium' | 'High' | 'Hot';
  interestedProducts: string[];
  estimatedPremium?: number;
  expectedCloseDate?: string;
  lastContactDate?: string;
  nextFollowUpDate?: string;
  lostReason?: string;
  notes?: string;
  createdDate: string;
}

export interface UpdateLeadRequest {
  status?: 'New' | 'Contacted' | 'Qualified' | 'Proposal Sent' | 'Enrolled' | 'Lost';
  priority?: 'Low' | 'Medium' | 'High' | 'Hot';
  interestedProducts?: string[];
  estimatedPremium?: number;
  expectedCloseDate?: string;
  nextFollowUpDate?: string;
  lostReason?: string;
  notes?: string;
}

export interface QuoteRequest {
  quoteId?: string;
  memberId?: string;
  leadId?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  dateOfBirth: string;
  zipCode: string;
  productIds: string[];
  dependents?: Array<{
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    relationship: string;
  }>;
  effectiveDate: string;
  tobaccoUse?: boolean;
  healthQuestions?: Record<string, any>;
  notes?: string;
}

export interface GeneratedQuote {
  quoteId: string;
  quoteNumber: string;
  memberId?: string;
  memberName: string;
  products: Array<{
    productId: string;
    productName: string;
    coverage: string;
    premium: number;
    deductible?: number;
    copay?: number;
  }>;
  totalPremium: number;
  effectiveDate: string;
  expirationDate: string;
  status: 'Draft' | 'Sent' | 'Viewed' | 'Accepted' | 'Expired';
  sentDate?: string;
  viewedDate?: string;
  notes?: string;
  pdfUrl?: string;
}

export interface EnrollmentWizardData {
  step: number;
  totalSteps: number;
  memberId?: string;
  quoteId?: string;
  personalInfo: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    dateOfBirth: string;
    ssn?: string;
    address: {
      street: string;
      city: string;
      state: string;
      zipCode: string;
    };
  };
  dependents: Array<{
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    relationship: string;
    ssn?: string;
  }>;
  selectedProducts: Array<{
    productId: string;
    coverageLevel?: string;
    beneficiaryInfo?: any;
  }>;
  healthQuestions: Record<string, any>;
  paymentInfo: {
    paymentMethod: 'Credit Card' | 'Bank Account' | 'Payroll Deduction';
    billingFrequency: 'Monthly' | 'Quarterly' | 'Annual';
  };
  applicationSignature?: {
    signature: string;
    dateSigned: string;
    ipAddress: string;
  };
}

export interface AgentPerformanceGoals {
  agentId: string;
  period: string; // "2025-Q2" format
  goals: {
    newEnrollments: { target: number; actual: number };
    revenue: { target: number; actual: number };
    retention: { target: number; actual: number };
    leadConversion: { target: number; actual: number };
  };
  achievements: string[];
  areasForImprovement: string[];
  nextReviewDate: string;
}

export interface AgentProfile {
    AgentId: string;
    UserId: string;
    FirstName: string;
    LastName: string;
    Email: string;
    PhoneNumber: string;
    LicenseNumber: string;
    W9Stored: boolean;
    BankingInfoStored: boolean;
}

export interface Member {
    MemberId: string;
    UserId: string;
    FirstName: string;
    LastName: string;
    Email: string;
    PhoneNumber: string;
    Status: string;
    RelationshipType: string;
    DateOfBirth: string;
    GroupName: string;
    GroupId: string;
    ActivePolicies: number;
}

export interface Product {
    id: number;
    name: string;
    carrier: string;
    type: string;
    description: string;
    brochureUrl: string;
}
