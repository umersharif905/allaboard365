import React from 'react';

export type ScopeFilter = 'all' | 'tenant' | 'vendor';

interface ScopeFilterDropdownProps {
  value: ScopeFilter;
  onChange: (value: ScopeFilter) => void;
  className?: string;
}

/**
 * SysAdmin-only scope filter: All / Tenant / Vendor.
 * The parent decides whether to render this (gate by SysAdmin role).
 */
const ScopeFilterDropdown: React.FC<ScopeFilterDropdownProps> = ({ value, onChange, className }) => {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ScopeFilter)}
      className={
        className ??
        'px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary'
      }
      aria-label="Filter by ownership scope"
    >
      <option value="all">All Scopes</option>
      <option value="tenant">Tenant</option>
      <option value="vendor">Vendor</option>
    </select>
  );
};

export default ScopeFilterDropdown;
