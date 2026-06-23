// frontend/src/components/vendor/NotificationsBell.tsx
//
// Notification bell for the back-office header. Surfaces:
//   - @-mentions on Share Request and Case notes
//   - new public-form submissions for templates owned by the vendor
//
// Backed by oe.Notifications: read state is persisted server-side (each row's
// IsRead), so the unread badge stays consistent across devices. We mark rows
// read via the API on click / "mark all read", optimistically updating local
// state first.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, ClipboardList, Briefcase, FileText } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';

interface Notification {
  id: string;
  type: 'mention' | 'form-submission';
  contextType: 'share-request' | 'case' | 'form-submission';
  contextId: string;
  contextLabel: string;
  noteSnippet: string | null;
  createdByName: string | null;
  createdDate: string;
  href: string;
  isRead: boolean;
}

const POLL_INTERVAL_MS = 60_000;

const formatRelative = (iso: string): string => {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
};

const iconFor = (n: Notification) => {
  switch (n.contextType) {
    case 'share-request':
      return <ClipboardList className="h-4 w-4 text-oe-primary" />;
    case 'case':
      return <Briefcase className="h-4 w-4 text-indigo-600" />;
    case 'form-submission':
      return <FileText className="h-4 w-4 text-green-600" />;
    default:
      return <Bell className="h-4 w-4 text-gray-500" />;
  }
};

const NotificationsBell: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.userId;

  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadNotifications = useCallback(async () => {
    if (!userId) return;
    try {
      setLoading(true);
      const resp = await apiService.get<{
        success: boolean;
        data: Notification[];
        unreadCount: number;
      }>('/api/me/vendor/notifications');
      if (resp.success && Array.isArray(resp.data)) {
        setNotifications(resp.data);
        setUnreadCount(resp.unreadCount ?? resp.data.filter((n) => !n.isRead).length);
      }
    } catch (err) {
      console.error('Failed to load notifications:', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void loadNotifications();
    const id = window.setInterval(() => void loadNotifications(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [userId, loadNotifications]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const handleItemClick = (n: Notification) => {
    if (!n.isRead) {
      // Optimistic: flip locally, then persist server-side (best-effort).
      setNotifications((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
      void apiService
        .post('/api/me/vendor/notifications/mark-read', { ids: [n.id] })
        .catch((err) => console.error('Failed to mark notification read:', err));
    }
    setOpen(false);
    if (n.href) navigate(n.href);
  };

  const handleMarkAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
    void apiService
      .post('/api/me/vendor/notifications/mark-all-read')
      .catch((err) => console.error('Failed to mark all notifications read:', err));
  };

  if (!userId) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        className="relative inline-flex items-center justify-center h-10 w-10 rounded-full hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-oe-primary"
      >
        <Bell className="h-5 w-5 text-gray-700" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold text-white bg-red-500 rounded-full">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-96 max-w-[90vw] bg-white rounded-lg border border-gray-200 shadow-lg z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <div className="font-semibold text-gray-900">Notifications</div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs font-medium text-oe-primary hover:text-oe-dark"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading && notifications.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-gray-500">Loading…</div>
            )}
            {!loading && notifications.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-gray-500">
                You're all caught up.
              </div>
            )}
            {notifications.map((n) => {
              const isUnread = !n.isRead;
              return (
                <button
                  type="button"
                  key={n.id}
                  onClick={() => handleItemClick(n)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 flex gap-3 ${
                    isUnread ? 'bg-oe-light/40' : ''
                  }`}
                >
                  <div className="mt-0.5">{iconFor(n)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {isUnread && (
                        <span className="h-2 w-2 rounded-full bg-oe-primary flex-shrink-0" />
                      )}
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {n.type === 'mention'
                          ? `${n.createdByName || 'A teammate'} mentioned you`
                          : 'New form submission'}
                      </div>
                    </div>
                    <div className="text-xs text-gray-600 truncate">{n.contextLabel}</div>
                    {n.noteSnippet && (
                      <div className="text-xs text-gray-500 mt-1 line-clamp-2">
                        {n.noteSnippet}
                      </div>
                    )}
                    <div className="text-[11px] text-gray-400 mt-1">
                      {formatRelative(n.createdDate)}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationsBell;
