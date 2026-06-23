import {
    Bell,
    Building,
    DollarSign,
    Search,
    TrendingUp,
    Users
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { API_CONFIG } from '../../config/api';

// TypeScript interfaces
interface DashboardData {
  totalHouseholds?: number;
  totalMembers?: number;
  monthlyRevenue?: number;
  totalTenants?: number;
  totalCommissions?: number;
}

const AdminDashboard = () => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const apiBaseUrl = API_CONFIG.BASE_URL;
        const apiUrl = `${apiBaseUrl}/api/admin/dashboard/metrics`;
        
        console.log('Fetching from:', apiUrl);
        const response = await fetch(apiUrl, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
          }
        });
        console.log('Response status:', response.status);
        if (response.ok) {
          const fetchedData = await response.json();
          setData(fetchedData);
        }
      } catch (error) {
        console.error('API Error:', error);
      } finally {
        setLoading(false);
      }
    };
    
    fetchData();
  }, []);

  const metrics = [
    { 
      title: 'Total Households', 
      value: (data?.totalHouseholds ?? data?.totalMembers ?? 0).toLocaleString(),
      color: '#3b82f6',
      icon: <Users className="h-6 w-6" />
    },
    { 
      title: 'Monthly Premium Volume', 
      value: `$${(data?.monthlyRevenue || 0).toLocaleString()}`,
      color: '#10b981',
      icon: <DollarSign className="h-6 w-6" />
    },
    { 
      title: 'Total Tenants', 
      value: data?.totalTenants || 0,
      color: '#8b5cf6',
      icon: <Building className="h-6 w-6" />
    },
    { 
      title: 'Total Commissions', 
      value: `$${(data?.totalCommissions || 0).toLocaleString()}`,
      color: '#f59e0b',
      icon: <TrendingUp className="h-6 w-6" />
    }
  ];

  return (
    <>
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold text-gray-800">Admin Dashboard</h1>
            
            <div className="flex items-center space-x-4">
              {/* Search */}
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search..."
                  className="w-64 pl-10 pr-4 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={18} />
              </div>
              
              {/* Notifications */}
              <button className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors">
                <Bell size={20} className="text-gray-600" />
                <span className="absolute top-1 right-1 w-2 h-2 bg-oe-error rounded-full"></span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Dashboard Content */}
      <main className="p-6">
        {/* Metrics Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {metrics.map((metric, index) => (
            <div key={index} className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-600 mb-1">{metric.title}</p>
                  <p className="text-2xl font-bold text-oe-neutral-dark">{metric.value}</p>
                </div>
                <div 
                  className="w-12 h-12 rounded-full flex items-center justify-center text-white"
                  style={{ backgroundColor: metric.color }}
                >
                  {metric.icon}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Recent Activity Section */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-800">Recent Activity</h2>
          </div>
          <div className="p-6">
            <p className="text-gray-600 mb-4">
              Welcome to your AllAboard365 admin dashboard. All systems are operational.
            </p>
            {loading ? (
              <p className="text-gray-500">Loading dashboard data...</p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center text-sm">
                  <div className="w-2 h-2 bg-oe-success rounded-full mr-2"></div>
                  <span className="text-gray-600">All services running normally</span>
                </div>
                <div className="flex items-center text-sm">
                  <div className="w-2 h-2 bg-oe-success rounded-full mr-2"></div>
                  <span className="text-gray-600">Database connected</span>
                </div>
                <div className="flex items-center text-sm">
                  <div className="w-2 h-2 bg-oe-success rounded-full mr-2"></div>
                  <span className="text-gray-600">API endpoints operational</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
};

export default AdminDashboard;