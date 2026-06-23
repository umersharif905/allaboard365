import { CheckCircle, DollarSign, Eye, Loader, Receipt, RefreshCcw, XCircle } from 'lucide-react';
import React, { useEffect } from 'react';
import { toast } from 'react-hot-toast';
import { useAccounting } from '../../hooks/useAccounting';
import { PaymentRecord } from '../../services/AccountingService';

const StatCard = ({ title, value, icon: Icon, change, changeType }: { title: string, value: string | number, icon: React.ElementType, change?: string, changeType?: 'increase' | 'decrease' }) => (
  <div className="bg-white rounded-lg border border-gray-200 p-4">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-gray-500">{title}</p>
        <p className="text-2xl font-semibold text-gray-900">{value}</p>
      </div>
      <div className="bg-blue-100 text-oe-primary p-3 rounded-full">
        <Icon size={24} />
      </div>
    </div>
    {change && (
        <div className="text-sm mt-2">
            <span className={changeType === 'increase' ? 'text-green-600' : 'text-red-600'}>{change}</span>
            <span className="text-gray-500 ml-1">from last month</span>
        </div>
    )}
  </div>
);


const AgentAccounting = () => {
  const { 
    payments, 
    paymentSummary, 
    paymentsLoading, 
    paymentsError, 
    retryPayment,
    fetchPayments,
  } = useAccounting();

  useEffect(() => {
    fetchPayments();
  }, [fetchPayments]);

  const handleRetryPayment = async (paymentId: string) => {
    const toastId = toast.loading('Retrying payment...');
    try {
      const response = await retryPayment(paymentId);
      if (response.success) {
        toast.success('Payment retry successful!', { id: toastId });
      } else {
        toast.error(`Payment retry failed: ${response.message}`, { id: toastId });
      }
    } catch (error) {
      toast.error(`An error occurred: ${error instanceof Error ? error.message : 'Unknown error'}`, { id: toastId });
    }
  };
  
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Completed':
        return 'bg-green-100 text-green-800';
      case 'Pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'Failed':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="p-6 bg-gray-50 min-h-full">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
            <h1 className="text-2xl font-semibold text-gray-900">Accounting Overview</h1>
            <p className="text-sm text-gray-600">Review payments and commissions for your clients.</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
            <StatCard title="Total Revenue" value={`$${(paymentSummary?.totalRevenue || 0).toLocaleString()}`} icon={DollarSign} />
            <StatCard title="Successful Payments" value={paymentSummary?.successfulPayments || 0} icon={CheckCircle} />
            <StatCard title="Pending Payments" value={paymentSummary?.pendingPayments || 0} icon={Loader} />
            <StatCard title="Failed Payments" value={paymentSummary?.failedPayments || 0} icon={XCircle} />
        </div>
        
        {paymentsError && (
          <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 mb-6 rounded-md" role="alert">
            <p className="font-bold">Error</p>
            <p>{paymentsError}</p>
          </div>
        )}

        {/* Payments Table */}
        <div className="bg-white rounded-lg border border-gray-200">
            <div className="p-4 border-b border-gray-200">
                <h2 className="text-lg font-medium text-gray-900">Payment History</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                      <tr>
                          <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Member</th>
                          <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                          <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                          <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                          <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                          <th scope="col" className="relative px-6 py-3"><span className="sr-only">Actions</span></th>
                      </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                      {paymentsLoading ? (
                          <tr>
                              <td colSpan={6} className="text-center py-12">
                                  <Loader className="mx-auto h-8 w-8 text-gray-400 animate-spin" />
                                  <p className="mt-2 text-sm text-gray-500">Loading payments...</p>
                              </td>
                          </tr>
                      ) : payments.length === 0 ? (
                          <tr>
                              <td colSpan={6} className="text-center py-12">
                                  <Receipt className="mx-auto h-12 w-12 text-gray-400" />
                                  <h3 className="mt-2 text-sm font-medium text-gray-900">No payments found</h3>
                                  <p className="mt-1 text-sm text-gray-500">Payments related to your members will appear here.</p>
                              </td>
                          </tr>
                      ) : (
                          payments.map((payment: PaymentRecord) => (
                              <tr key={payment.PaymentId}>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{payment.MemberName}</td>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{payment.ProductName}</td>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${payment.Amount.toFixed(2)}</td>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                                      <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getStatusColor(payment.Status)}`}>
                                          {payment.Status}
                                      </span>
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{new Date(payment.PaymentDate).toLocaleDateString()}</td>
                                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                    <div className="flex items-center space-x-2">
                                        <button className="text-oe-primary hover:text-blue-900" title="View Details">
                                            <Eye size={16} />
                                        </button>
                                        {payment.Status === 'Failed' && (
                                            <button 
                                                onClick={() => handleRetryPayment(payment.PaymentId)}
                                                className="text-green-600 hover:text-green-900"
                                                title="Retry Payment"
                                            >
                                                <RefreshCcw size={16} />
                                            </button>
                                        )}
                                    </div>
                                  </td>
                              </tr>
                          ))
                      )}
                  </tbody>
              </table>
            </div>
        </div>
      </div>
    </div>
  );
};

export default AgentAccounting; 