import { apiService } from '../api.service';

export interface DashboardMetrics {
  totalHouseholds: number;
  /** @deprecated Use totalHouseholds — kept for backward compatibility */
  totalMembers: number;
  monthlyRevenue: number;
  totalTenants: number;
  totalCommissions: number;
  membersChange: number;
  revenueChange: number;
  tenantsChange: number;
  commissionsChange: number;
}

export interface RecentEnrollment {
  memberId: string;
  memberName: string;
  plan: string;
  date: string;
  amount: number;
}

export interface TenantPerformance {
  tenantName: string;
  totalMembers: number;
  monthlyRevenue: number;
}

export interface RevenueByProduct {
  productName: string;
  revenue: number;
  percentage: number;
}

export interface TrendingEnrollment {
  week: string;
  enrollments: number;
}

export interface MonthlyRevenue {
  name: string;
  revenue: number;
  profit: number;
}

class DashboardService {
  async getMetrics(): Promise<DashboardMetrics> {
    // apiService.get already returns the data directly, no .data needed
    return await apiService.get<DashboardMetrics>('/api/admin/dashboard/metrics');
  }

  async getRecentEnrollments(): Promise<RecentEnrollment[]> {
    return await apiService.get<RecentEnrollment[]>('/api/admin/dashboard/recent-enrollments');
  }

  async getTopTenants(): Promise<TenantPerformance[]> {
    return await apiService.get<TenantPerformance[]>('/api/admin/dashboard/top-tenants');
  }

  async getRevenueByProduct(): Promise<RevenueByProduct[]> {
    return await apiService.get<RevenueByProduct[]>('/api/admin/dashboard/revenue-by-product');
  }

  async getTrendingEnrollments(): Promise<TrendingEnrollment[]> {
    return await apiService.get<TrendingEnrollment[]>('/api/admin/dashboard/trending-enrollments');
  }

  async getMonthlyRevenue(year?: number): Promise<MonthlyRevenue[]> {
    const currentYear = year || new Date().getFullYear();
    return await apiService.get<MonthlyRevenue[]>(`/api/admin/dashboard/monthly-revenue?year=${currentYear}`);
  }
}

export const dashboardService = new DashboardService();