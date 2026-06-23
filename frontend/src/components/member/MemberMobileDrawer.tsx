import React, { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LogOut, User, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useMemberNavigationItems } from '../../hooks/member/useMemberNavigationItems';
import useUserProfile from '../../hooks/useUserProfile';

interface MemberMobileDrawerProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Off-canvas navigation drawer for the Member portal on mobile viewports (<md).
 * Uses the same navigation items as the desktop sidebar via `useMemberNavigationItems`.
 * Closes automatically on route change and on backdrop tap.
 */
const MemberMobileDrawer: React.FC<MemberMobileDrawerProps> = ({ open, onClose }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout, user: authUser } = useAuth();
  const navigationItems = useMemberNavigationItems();
  const { data: profileData } = useUserProfile();

  // Close drawer on route change
  useEffect(() => {
    if (open) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Lock body scroll while drawer is open
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const isActive = (path: string) => {
    const current = location.pathname;
    if (path.endsWith('/dashboard')) {
      return current === path || current === `${path}/` || current === path.replace('/dashboard', '');
    }
    if (current === path || current === `${path}/`) return true;
    if (current.startsWith(`${path}/`)) return true;
    return false;
  };

  const firstName = profileData?.FirstName ?? '';
  const lastName = profileData?.LastName ?? '';
  const fullName = `${firstName} ${lastName}`.trim();
  const email = profileData?.Email ?? authUser?.email ?? '';

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-30 bg-black/50 transition-opacity md:hidden ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <aside
        className={`fixed top-0 left-0 z-40 h-full w-72 max-w-[85vw] bg-white shadow-xl transition-transform duration-300 md:hidden flex flex-col ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Member navigation"
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between h-14 px-4 border-b border-gray-200 flex-shrink-0">
          <span className="text-base font-semibold text-gray-900">Member Portal</span>
          <button
            type="button"
            onClick={onClose}
            className="p-2 -mr-2 rounded-md text-gray-600 hover:bg-gray-100 min-h-11 min-w-11 flex items-center justify-center"
            aria-label="Close navigation"
          >
            <X size={22} />
          </button>
        </div>

        {/* Nav list */}
        <nav className="flex-1 overflow-y-auto px-3 py-3">
          <ul className="space-y-1">
            {navigationItems.map((item) => {
              const active = isActive(item.path);
              return (
                <li key={item.path}>
                  <button
                    type="button"
                    onClick={() => {
                      navigate(item.path);
                      onClose();
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left min-h-11 transition-colors ${
                      active
                        ? 'bg-oe-light text-oe-dark font-semibold'
                        : 'text-gray-700 hover:bg-gray-100'
                    }`}
                    style={active ? { borderLeft: '3px solid var(--oe-primary, #1f8dbf)' } : {}}
                  >
                    <span className={`flex-shrink-0 ${active ? 'text-oe-primary' : 'text-gray-600'}`}>
                      {item.icon}
                    </span>
                    <span className="truncate text-sm">{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* User footer */}
        <div className="flex-shrink-0 border-t border-gray-200 p-4">
          <div className="flex items-center mb-3">
            <div className="w-10 h-10 rounded-full bg-oe-primary flex items-center justify-center flex-shrink-0">
              <User size={20} className="text-white" />
            </div>
            <div className="ml-3 flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">
                {fullName || 'Member'}
              </p>
              <p className="text-xs text-gray-600 truncate">{email}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              onClose();
              logout();
            }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm text-red-600 hover:bg-red-50 border border-gray-200 min-h-11"
          >
            <LogOut size={16} />
            Sign Out
          </button>
        </div>
      </aside>
    </>
  );
};

export default MemberMobileDrawer;
