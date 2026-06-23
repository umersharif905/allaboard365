// frontend/src/components/SessionManager.tsx
import { AlertTriangle, Clock } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authService } from '../services/auth.service';

const SessionManager: React.FC = () => {
  const [showWarning, setShowWarning] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(300); // 5 minutes in seconds
  const [isExtending, setIsExtending] = useState(false);

  const { logout } = useAuth();

  useEffect(() => {
    const handleInactivityWarning = (_event: CustomEvent) => {
      setShowWarning(true);
      setTimeRemaining(300); // Reset to 5 minutes
    };

    window.addEventListener('show-inactivity-warning' as any, handleInactivityWarning);

    return () => {
      window.removeEventListener('show-inactivity-warning' as any, handleInactivityWarning);
    };
  }, []);

  useEffect(() => {
    let interval: number;

    if (showWarning && timeRemaining > 0) {
      interval = window.setInterval(() => {
        setTimeRemaining((prev) => {
          if (prev <= 1) {
            setShowWarning(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [showWarning, timeRemaining]);

  const handleExtendSession = async () => {
    setIsExtending(true);
    try {
      authService.resetInactivityTimer();
      await authService.getAccessToken();
      setShowWarning(false);
      setTimeRemaining(300);
    } catch (error) {
      console.error('Failed to extend session:', error);
    } finally {
      setIsExtending(false);
    }
  };

  const handleLogout = () => {
    logout();
  };

  const formatTime = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const progressValue = ((300 - timeRemaining) / 300) * 100;

  if (!showWarning) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="session-warning-title">
      <div className="w-full max-w-sm rounded-lg bg-white shadow-xl">
        <div className="flex flex-col items-center pt-8 pb-6 px-6 text-center">
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-yellow-100">
            <AlertTriangle className="h-8 w-8 text-yellow-600" />
          </div>
          <h2 id="session-warning-title" className="text-xl font-semibold text-gray-900 mb-2">
            Session Expiring Soon
          </h2>
          <p className="text-gray-600 mb-6">
            Your session will expire due to inactivity in:
          </p>
          <div className="flex items-center gap-2 mb-6">
            <Clock className="h-6 w-6 text-gray-500" />
            <span className={`text-2xl font-semibold ${timeRemaining < 60 ? 'text-red-600' : 'text-gray-900'}`}>
              {formatTime(timeRemaining)}
            </span>
          </div>
          <div className="w-full mb-6 h-2 overflow-hidden rounded-full bg-gray-200">
            <div
              className={`h-full rounded-full transition-all ${timeRemaining < 60 ? 'bg-red-500' : 'bg-yellow-500'}`}
              style={{ width: `${progressValue}%` }}
            />
          </div>
          <p className="text-sm text-gray-500">
            Click &quot;Continue Working&quot; to stay logged in, or &quot;Log Out&quot; to end your session now.
          </p>
        </div>
        <div className="flex gap-3 px-6 pb-6">
          <button
            type="button"
            onClick={handleLogout}
            disabled={isExtending}
            className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Log Out
          </button>
          <button
            type="button"
            onClick={handleExtendSession}
            disabled={isExtending}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isExtending ? 'Extending...' : 'Continue Working'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SessionManager;
