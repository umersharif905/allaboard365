import { useQuery } from '@tanstack/react-query';
import { dashboardService } from '../services/sysadmin/dashboard.service';

// Refresh intervals
const METRICS_REFRESH = 30000; // 30 seconds
const ENROLLMENTS_REFRESH = 60000; // 1 minute
const CHARTS_REFRESH = 300000; // 5 minutes

export const useDashboardMetrics = () => {
  return useQuery({
    queryKey: ['dashboard', 'metrics'],
    queryFn: () => dashboardService.getMetrics(),
    refetchInterval: METRICS_REFRESH,
    staleTime: 10000, // Consider data stale after 10 seconds
  });
};

export const useRecentEnrollments = () => {
  return useQuery({
    queryKey: ['dashboard', 'recent-enrollments'],
    queryFn: () => dashboardService.getRecentEnrollments(),
    refetchInterval: ENROLLMENTS_REFRESH,
  });
};

export const useTopTenants = () => {
  return useQuery({
    queryKey: ['dashboard', 'top-tenants'],
    queryFn: () => dashboardService.getTopTenants(),
    refetchInterval: CHARTS_REFRESH,
  });
};

export const useRevenueByProduct = () => {
  return useQuery({
    queryKey: ['dashboard', 'revenue-by-product'],
    queryFn: () => dashboardService.getRevenueByProduct(),
    refetchInterval: CHARTS_REFRESH,
  });
};

export const useTrendingEnrollments = () => {
  return useQuery({
    queryKey: ['dashboard', 'trending-enrollments'],
    queryFn: () => dashboardService.getTrendingEnrollments(),
    refetchInterval: ENROLLMENTS_REFRESH,
  });
};

export const useMonthlyRevenue = (year?: number) => {
  return useQuery({
    queryKey: ['dashboard', 'monthly-revenue', year],
    queryFn: () => dashboardService.getMonthlyRevenue(year),
    refetchInterval: CHARTS_REFRESH,
  });
};

// Hook to fetch all dashboard data
export const useDashboardData = () => {
  const metrics = useDashboardMetrics();
  const recentEnrollments = useRecentEnrollments();
  const topTenants = useTopTenants();
  const revenueByProduct = useRevenueByProduct();
  const trendingEnrollments = useTrendingEnrollments();
  const monthlyRevenue = useMonthlyRevenue();

  const isLoading = 
    metrics.isLoading || 
    recentEnrollments.isLoading || 
    topTenants.isLoading || 
    revenueByProduct.isLoading || 
    trendingEnrollments.isLoading ||
    monthlyRevenue.isLoading;

  const isError = 
    metrics.isError || 
    recentEnrollments.isError || 
    topTenants.isError || 
    revenueByProduct.isError || 
    trendingEnrollments.isError ||
    monthlyRevenue.isError;

  return {
    metrics,
    recentEnrollments,
    topTenants,
    revenueByProduct,
    trendingEnrollments,
    monthlyRevenue,
    isLoading,
    isError,
  };
};
