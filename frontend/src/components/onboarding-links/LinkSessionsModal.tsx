// frontend/src/components/onboarding-links/LinkSessionsModal.tsx
import { AlertCircle, Calendar, CheckCircle, Clock, User, X, XCircle } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { OnboardingLink, OnboardingLinksService, OnboardingSession } from '../../services/onboardingLinks.service';

interface LinkSessionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  link: OnboardingLink;
  currentRole: string;
}

const LinkSessionsModal: React.FC<LinkSessionsModalProps> = ({
  isOpen,
  onClose,
  link,
  currentRole
}) => {
  const [sessions, setSessions] = useState<OnboardingSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadSessions();
    }
  }, [isOpen, link.LinkId]);

  const loadSessions = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await OnboardingLinksService.getLinkSessions(link.LinkId, currentRole);
      if (response.success && response.data) {
        setSessions(response.data);
      } else {
        setError('Failed to load sessions');
      }
    } catch (err) {
      setError('An error occurred while loading sessions');
      console.error('Error loading sessions:', err);
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Completed':
        return <CheckCircle className="w-4 h-4 text-green-600" />;
      case 'InProgress':
        return <Clock className="w-4 h-4 text-oe-primary" />;
      case 'Pending':
        return <Clock className="w-4 h-4 text-yellow-600" />;
      case 'Failed':
      case 'Expired':
      case 'Cancelled':
        return <XCircle className="w-4 h-4 text-red-600" />;
      default:
        return <AlertCircle className="w-4 h-4 text-gray-600" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const baseClasses = "inline-flex items-center px-2 py-1 rounded-full text-xs font-medium";
    
    switch (status) {
      case 'Completed':
        return `${baseClasses} bg-green-100 text-green-800`;
      case 'InProgress':
        return `${baseClasses} bg-blue-100 text-blue-800`;
      case 'Pending':
        return `${baseClasses} bg-yellow-100 text-yellow-800`;
      case 'Failed':
        return `${baseClasses} bg-red-100 text-red-800`;
      case 'Expired':
        return `${baseClasses} bg-gray-100 text-gray-800`;
      case 'Cancelled':
        return `${baseClasses} bg-red-100 text-red-800`;
      default:
        return `${baseClasses} bg-gray-100 text-gray-800`;
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString() + ' ' + new Date(dateString).toLocaleTimeString();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Onboarding Sessions</h2>
            <p className="text-sm text-gray-600">Sessions for: {link.LinkName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Error Message */}
          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg flex items-center">
              <AlertCircle className="w-5 h-5 mr-2" />
              {error}
            </div>
          )}

          {/* Loading State */}
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
              <span className="ml-2 text-gray-600">Loading sessions...</span>
            </div>
          )}

          {/* Sessions List */}
          {!loading && sessions.length === 0 && (
            <div className="text-center py-8">
              <User className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No sessions yet</h3>
              <p className="text-gray-600">No agents have started the onboarding process for this link.</p>
            </div>
          )}

          {!loading && sessions.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Agent
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Started
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Completed
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Expires
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      IP Address
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {sessions.map((session) => (
                    <tr key={session.SessionId} className="hover:bg-gray-50">
                      <td className="px-6 py-4">
                        {session.AgentName ? (
                          <div>
                            <div className="text-sm font-medium text-gray-900">{session.AgentName}</div>
                            <div className="text-sm text-gray-500">{session.AgentEmail}</div>
                          </div>
                        ) : (
                          <div className="text-sm text-gray-500">Anonymous</div>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <span className={getStatusBadge(session.Status)}>
                          {getStatusIcon(session.Status)}
                          <span className="ml-1">{session.Status}</span>
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        <div className="flex items-center">
                          <Calendar className="w-4 h-4 mr-1 text-gray-400" />
                          {formatDate(session.StartedDate)}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        {session.CompletedDate ? (
                          <div className="flex items-center">
                            <Calendar className="w-4 h-4 mr-1 text-gray-400" />
                            {formatDate(session.CompletedDate)}
                          </div>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        <div className="flex items-center">
                          <Calendar className="w-4 h-4 mr-1 text-gray-400" />
                          {formatDate(session.ExpiresDate)}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-500">
                        {session.IPAddress || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Session Statistics */}
          {!loading && sessions.length > 0 && (
            <div className="mt-6 bg-gray-50 p-4 rounded-lg">
              <h3 className="text-sm font-medium text-gray-700 mb-3">Session Statistics</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">Total Sessions:</span>
                  <span className="ml-2 font-medium text-gray-900">{sessions.length}</span>
                </div>
                <div>
                  <span className="text-gray-500">Completed:</span>
                  <span className="ml-2 font-medium text-gray-900">
                    {sessions.filter(s => s.Status === 'Completed').length}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">In Progress:</span>
                  <span className="ml-2 font-medium text-gray-900">
                    {sessions.filter(s => s.Status === 'InProgress').length}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Failed/Expired:</span>
                  <span className="ml-2 font-medium text-gray-900">
                    {sessions.filter(s => ['Failed', 'Expired', 'Cancelled'].includes(s.Status)).length}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end p-6 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default LinkSessionsModal;




















