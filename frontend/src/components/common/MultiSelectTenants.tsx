import { Check, ChevronDown, Search, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

interface Tenant {
  TenantId: string;
  Name: string;
}

interface MultiSelectTenantsProps {
  tenants: Tenant[];
  selectedTenantIds: string[];
  onChange: (selectedIds: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  excludeTenantId?: string; // Exclude primary tenant from additional tenants list
  className?: string;
}

const MultiSelectTenants: React.FC<MultiSelectTenantsProps> = ({
  tenants,
  selectedTenantIds,
  onChange,
  placeholder = "Select additional tenants...",
  disabled = false,
  excludeTenantId,
  className = ""
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight?: number } | null>(null);

  // Filter out excluded tenant and apply search filter
  const filteredTenants = tenants.filter(tenant => {
    if (excludeTenantId && tenant.TenantId === excludeTenantId) {
      return false;
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return tenant.Name.toLowerCase().includes(query);
    }
    return true;
  });

  // Get selected tenant names for display
  const selectedTenants = tenants.filter(t => selectedTenantIds.includes(t.TenantId));

  // Calculate dropdown position when it opens
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - rect.bottom;
      const spaceAbove = rect.top;
      
      const maxHeightValue = 400; // Max height in pixels
      const minSpaceForDownward = 150;
      const openDownward = spaceBelow >= minSpaceForDownward;
      
      let calculatedMaxHeight: number;
      
      if (openDownward) {
        const top = rect.bottom + 4;
        calculatedMaxHeight = Math.min(maxHeightValue, spaceBelow - 20);
        setDropdownPosition({
          top: top,
          left: rect.left,
          width: rect.width,
          maxHeight: calculatedMaxHeight
        });
      } else {
        calculatedMaxHeight = Math.min(maxHeightValue, spaceAbove - 20);
        const bottom = viewportHeight - rect.top + 4;
        setDropdownPosition({
          bottom: bottom,
          left: rect.left,
          width: rect.width,
          maxHeight: calculatedMaxHeight
        });
      }
    } else {
      setDropdownPosition(null);
    }
  }, [isOpen]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isOutsideTrigger = triggerRef.current && !triggerRef.current.contains(target);
      const isOutsideMenu = menuRef.current && !menuRef.current.contains(target);
      
      if (isOutsideTrigger && isOutsideMenu) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    if (isOpen) {
      const timeoutId = setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside);
      }, 0);
      return () => {
        clearTimeout(timeoutId);
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isOpen]);

  const handleToggleTenant = (tenantId: string) => {
    if (selectedTenantIds.includes(tenantId)) {
      onChange(selectedTenantIds.filter(id => id !== tenantId));
    } else {
      onChange([...selectedTenantIds, tenantId]);
    }
  };

  const handleRemoveTenant = (tenantId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(selectedTenantIds.filter(id => id !== tenantId));
  };

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`w-full px-3 py-2 text-left border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
          disabled ? 'bg-gray-50 text-gray-400 cursor-not-allowed' : 'bg-white hover:border-gray-400'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex-1 min-w-0">
            {selectedTenants.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {selectedTenants.map(tenant => (
                  <span
                    key={tenant.TenantId}
                    className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-blue-100 text-blue-800"
                  >
                    {tenant.Name}
                    {!disabled && (
                      <button
                        type="button"
                        onClick={(e) => handleRemoveTenant(tenant.TenantId, e)}
                        className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-blue-200 focus:outline-none"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-gray-500">{placeholder}</span>
            )}
          </div>
          <ChevronDown className={`h-4 w-4 text-gray-400 ml-2 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {/* Dropdown Menu */}
      {isOpen && dropdownPosition && (
        <div 
          ref={menuRef}
          className="fixed bg-white border border-gray-300 rounded-lg shadow-xl overflow-hidden z-50"
          style={{ 
            ...(dropdownPosition.top !== undefined ? { top: `${dropdownPosition.top}px` } : {}),
            ...(dropdownPosition.bottom !== undefined ? { bottom: `${dropdownPosition.bottom}px` } : {}),
            left: `${dropdownPosition.left}px`,
            width: `${dropdownPosition.width}px`,
            maxHeight: dropdownPosition.maxHeight ? `${dropdownPosition.maxHeight}px` : '400px',
            zIndex: 9999
          }}
        >
          {/* Search Input */}
          <div className="p-2 border-b border-gray-200 flex-shrink-0">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search tenants..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                autoFocus
              />
            </div>
          </div>

          {/* Options List */}
          <div 
            className="overflow-y-auto" 
            style={{ 
              maxHeight: dropdownPosition.maxHeight 
                ? `${dropdownPosition.maxHeight - 60}px`
                : '340px'
            }}
          >
            {filteredTenants.length === 0 ? (
              <div className="p-3 text-center text-gray-500 text-sm">
                {searchQuery ? 'No tenants found' : 'No tenants available'}
              </div>
            ) : (
              filteredTenants.map((tenant) => {
                const isSelected = selectedTenantIds.includes(tenant.TenantId);
                return (
                  <button
                    key={tenant.TenantId}
                    type="button"
                    onClick={() => handleToggleTenant(tenant.TenantId)}
                    className={`w-full px-3 py-2 text-left hover:bg-gray-50 focus:bg-gray-50 focus:outline-none flex items-center ${
                      isSelected ? 'bg-blue-50' : ''
                    }`}
                  >
                    <div className={`flex-shrink-0 w-5 h-5 border-2 rounded flex items-center justify-center mr-2 ${
                      isSelected ? 'border-oe-primary bg-oe-primary' : 'border-gray-300'
                    }`}>
                      {isSelected && <Check className="h-3 w-3 text-white" />}
                    </div>
                    <span className={`text-sm ${isSelected ? 'font-medium text-oe-primary-dark' : 'text-gray-900'}`}>
                      {tenant.Name}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default MultiSelectTenants;

