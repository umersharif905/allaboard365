import type { AgentMetrics, CommissionRecord, SalesActivity } from '../../types/agent/agent.types';

export const mockAgentMetrics: AgentMetrics = {
  totalActiveHouseholds: 48,
  monthlyPremiumAmount: 18250.75,
  estimatedMonthlyCommission: 3650.15,
  commissionPayoutAverageWindowMonths: 12,
  totalActiveMembers: 120,
  newMembersThisMonth: 15,
  pendingEnrollments: 5,
  commissionsMTD: 4200.5,
  commissionsYTD: 25000.75,
  upcomingPayments: 0,
  pendingApplications: 0,
  failedPayments: 0,
  recentCommissions: [
    {
      commissionId: 'c1',
      date: '2024-07-15',
      amount: 120.0,
      memberName: 'John Doe',
      memberId: 'm1',
      productName: 'Gold Plan',
      productId: 'p1',
      status: 'Paid'
    },
    {
      commissionId: 'c2',
      date: '2024-07-20',
      amount: 200.5,
      memberName: 'Jane Smith',
      memberId: 'm2',
      productName: 'Silver Plan',
      productId: 'p2',
      status: 'Paid'
    },
    {
      commissionId: 'c3',
      date: '2024-08-01',
      amount: 75.0,
      memberName: 'Peter Jones',
      memberId: 'm3',
      productName: 'Bronze Plan',
      productId: 'p3',
      status: 'Pending'
    }
  ],
  performanceRanking: {
    rank: 4,
    totalAgents: 25,
    category: 'Above Average'
  },
  recentActivity: {
    newEnrollments: 3,
    memberInteractions: 12,
    quotesSent: 5,
    meetingsScheduled: 2
  },
};

export const sampleActivities: SalesActivity[] = [
  {
    id: '1',
    activityId: '1',
    subject: 'Follow up with Johnson family',
    activityType: 'Call',
    scheduledDate: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    priority: 'High',
    status: 'Scheduled'
  },
  {
    id: '2',
    activityId: '2',
    subject: 'Send quote to Smith Corp',
    activityType: 'Email',
    scheduledDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    priority: 'Medium',
    status: 'Scheduled'
  },
  {
    id: '3',
    activityId: '3',
    subject: 'Review enrollment documents',
    activityType: 'Meeting',
    scheduledDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    priority: 'Low',
    status: 'Scheduled'
  }
];

export const sampleCommissions: CommissionRecord[] = [
  {
    commissionId: 'c1',
    date: '2025-01-15',
    amount: 67.50,
    memberName: 'Johnson Family',
    memberId: 'm1',
    productName: 'Family Health Plan',
    productId: 'p1',
    status: 'Pending'
  },
  {
    commissionId: 'c2',
    date: '2025-01-15',
    amount: 38.46,
    memberName: 'Smith Corp',
    memberId: 'm2',
    productName: 'Group Dental',
    productId: 'p2',
    status: 'Pending'
  },
  {
    commissionId: 'c3',
    date: '2024-12-15',
    amount: 18.08,
    memberName: 'Davis Individual',
    memberId: 'm3',
    productName: 'Individual Plan',
    productId: 'p3',
    status: 'Paid',
  }
]; 