import React from 'react';
import { Link } from 'react-router-dom';
import { Bell, Search } from 'lucide-react';

interface SharedHeaderProps {
  title: string;
  showSearch?: boolean;
  showNotifications?: boolean;
  onSearch?: (query: string) => void;
  onNotificationClick?: () => void;
  notificationCount?: number;
  searchValue?: string; // Add controlled value prop
  /** When set, shows a back link before the title (e.g. vendor detail → all vendors) */
  backTo?: string;
  backLabel?: string;
}

const SharedHeader: React.FC<SharedHeaderProps> = ({
  title,
  showSearch = true,
  showNotifications = true,
  onSearch,
  onNotificationClick,
  notificationCount = 0,
  searchValue = '', // Default to empty string
  backTo,
  backLabel = 'Back',
}) => {
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (onSearch) {
      onSearch(e.target.value);
    }
  };

  return (
    <header className="bg-white shadow-sm border-b border-gray-200">
      <div className="px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0 flex-1">
            {backTo && (
              <Link
                to={backTo}
                className="shrink-0 text-sm font-medium text-oe-primary hover:underline"
              >
                ← {backLabel}
              </Link>
            )}
            <h1 className="text-2xl font-semibold text-gray-800 truncate">{title}</h1>
          </div>
          
          <div className="flex items-center space-x-4">
            {/* Search */}
            {showSearch && (
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search..."
                  value={searchValue}
                  onChange={handleSearchChange}
                  autoComplete="off"
                  className="w-64 pl-10 pr-4 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={18} />
              </div>
            )}
            
            {/* Notifications */}
            {showNotifications && (
              <button 
                onClick={onNotificationClick}
                className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <Bell size={20} className="text-gray-600" />
                {notificationCount > 0 && (
                  <span className="absolute top-1 right-1 w-2 h-2 bg-oe-error rounded-full"></span>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

export default SharedHeader;