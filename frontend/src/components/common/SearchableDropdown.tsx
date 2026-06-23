import { ChevronDown, Search, X, Info } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

interface SearchableDropdownOption {
  id: string;
  label: string;
  value: string;
  email?: string;
  code?: string;
  sublabel?: string; // Optional sublabel (e.g. scope: Tenant, Agency, Agent)
  tooltip?: string; // Optional tooltip content
  disabled?: boolean;
  isGroupHeader?: boolean;
  section?: string;
}

// Separate component for dropdown option with tooltip
const DropdownOptionWithTooltip: React.FC<{
  option: SearchableDropdownOption;
  value: string;
  multiLine: boolean;
  showEmail: boolean;
  showCode: boolean;
  showSublabel: boolean;
  onSelect: (option: SearchableDropdownOption) => void;
}> = ({ option, value, multiLine, showEmail, showCode, showSublabel, onSelect }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const infoButtonRef = useRef<HTMLButtonElement>(null);

  const handleInfoMouseEnter = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (option.tooltip && (buttonRef.current || infoButtonRef.current)) {
      const ref = infoButtonRef.current || buttonRef.current;
      if (ref) {
        const rect = ref.getBoundingClientRect();
        setTooltipPosition({
          top: rect.top + window.scrollY,
          left: rect.right + window.scrollX + 8
        });
        setShowTooltip(true);
      }
    }
  };

  const handleInfoMouseLeave = () => {
    setShowTooltip(false);
    setTooltipPosition(null);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onSelect(option)}
        className={`w-full px-3 py-2 text-left hover:bg-gray-50 focus:bg-gray-50 focus:outline-none ${
          option.value === value ? 'bg-blue-50 text-oe-primary-dark' : 'text-gray-900'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-medium ${multiLine ? 'whitespace-pre-line' : 'truncate'}`}>
              {option.label}
            </div>
            {showSublabel && option.sublabel && (
              <div className="text-xs text-gray-600 truncate">
                {option.sublabel}
              </div>
            )}
            {showEmail && option.email && (
              <div className="text-xs text-gray-500 truncate">
                {option.email}
              </div>
            )}
            {showCode && option.code && (
              <div className="text-xs text-gray-500 truncate">
                {option.code}
              </div>
            )}
          </div>
          {option.tooltip && (
            <button
              ref={infoButtonRef}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
              onMouseEnter={handleInfoMouseEnter}
              onMouseLeave={handleInfoMouseLeave}
              className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-200 hover:bg-gray-300 flex items-center justify-center text-[10px] text-gray-600 font-semibold cursor-help transition-colors"
              title="View rule details"
            >
              <Info className="w-3 h-3" />
            </button>
          )}
        </div>
      </button>
      {showTooltip && tooltipPosition && option.tooltip && (
        <div
          className="fixed z-[10001] w-80 max-w-[90vw] p-3 bg-gray-900 text-white text-xs rounded-lg shadow-xl pointer-events-none"
          style={{
            top: `${tooltipPosition.top}px`,
            left: `${tooltipPosition.left}px`
          }}
        >
          <div className="whitespace-pre-line leading-relaxed">{option.tooltip}</div>
          <div className="absolute -left-1 top-3 w-2 h-2 bg-gray-900 rotate-45"></div>
        </div>
      )}
    </>
  );
};

interface SearchableDropdownProps {
  options: SearchableDropdownOption[];
  value: string;
  /** option is the full selected option (may include extra fields e.g. type for Agent/Agency) */
  onChange: (value: string, label: string, option?: SearchableDropdownOption) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  showEmail?: boolean;
  /** When true, show email in the dropdown list only (not in the selection area when selected). Default true = list only. */
  showEmailInSelection?: boolean;
  showCode?: boolean;
  showSublabel?: boolean;
  multiLine?: boolean; // New prop for multi-line display
  onSearch?: (query: string) => void; // Optional backend search callback
  useBackendSearch?: boolean; // If true, skip client-side filtering
  maxHeight?: string; // Custom max height for dropdown menu (e.g., '80vh', '400px')
  /** When set, options with matching `section` get a labeled header row in the menu. */
  sectionLabels?: Record<string, string>;
}

const SearchableDropdown: React.FC<SearchableDropdownProps> = ({
  options,
  value,
  onChange,
  placeholder = "Select an option",
  searchPlaceholder = "Search...",
  loading = false,
  disabled = false,
  className = "",
  showEmail = false,
  showEmailInSelection = false,
  showCode = false,
  showSublabel = false,
  multiLine = false,
  onSearch,
  useBackendSearch = false,
  maxHeight = "60",
  sectionLabels
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedOption, setSelectedOption] = useState<SearchableDropdownOption | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight?: number } | null>(null);
  const onSearchRef = useRef(onSearch);
  
  // Keep ref updated with latest callback
  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);

  const valueMatches = (a: string, b: string) => {
    if (a === b) return true;
    const al = a.trim().toLowerCase();
    const bl = b.trim().toLowerCase();
    return al.length > 0 && al === bl;
  };

  // Find selected option — keep existing selectedOption when value is set but not in current options
  useEffect(() => {
    const option = options.find((opt) => valueMatches(opt.value, value));
    if (option) {
      setSelectedOption(option);
    } else if (!value) {
      setSelectedOption(null);
    }
  }, [value, options]);

  const selectableOptions = options.filter((option) => !option.isGroupHeader && !option.disabled);

  // Filter options based on search query
  // If using backend search, skip client-side filtering
  const filteredSelectable = useBackendSearch ? selectableOptions : (() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return selectableOptions;

    const scoreOption = (option: SearchableDropdownOption) => {
      const label = option.label.toLowerCase();
      const value = option.value.toLowerCase();
      const code = option.code?.toLowerCase() || '';
      if (label === query || value === query || code === query) return 0;
      if (label.startsWith(query) || value.startsWith(query) || code.startsWith(query)) return 1;
      if (label.includes(query) || value.includes(query) || code.includes(query)) return 2;
      const sublabel = option.sublabel?.toLowerCase() || '';
      if (sublabel) {
        const uplineMatch = sublabel.match(/upline:\s*(.+)/);
        if (uplineMatch && uplineMatch[1].includes(query) && !label.includes(query)) return 4;
        if (sublabel.includes(query)) return 3;
      }
      if (option.email && option.email.toLowerCase().includes(query)) return 5;
      return 6;
    };

    return selectableOptions
      .filter((option) => scoreOption(option) < 6)
      .sort((a, b) => {
        const scoreDiff = scoreOption(a) - scoreOption(b);
        if (scoreDiff !== 0) return scoreDiff;
        return a.label.localeCompare(b.label);
      });
  })();

  const filteredOptions = (() => {
    if (!sectionLabels || !filteredSelectable.length) return filteredSelectable;
    const out: SearchableDropdownOption[] = [];
    let lastSection: string | undefined;
    for (const option of filteredSelectable) {
      const section = option.section;
      if (section && section !== lastSection) {
        out.push({
          id: `__section_${section}`,
          value: '',
          label: sectionLabels[section] || section,
          isGroupHeader: true,
          disabled: true
        });
        lastSection = section;
      }
      out.push(option);
    }
    return out;
  })();

  // Handle search input change with debouncing for backend search
  useEffect(() => {
    if (useBackendSearch && onSearchRef.current) {
      const timer = setTimeout(() => {
        onSearchRef.current?.(searchQuery);
      }, 300); // 300ms debounce

      return () => clearTimeout(timer);
    }
  }, [searchQuery, useBackendSearch]);

  // Trigger initial search when dropdown opens (for backend search)
  useEffect(() => {
    if (isOpen && useBackendSearch && onSearchRef.current && searchQuery === '') {
      // Small delay to ensure dropdown is fully rendered
      const timer = setTimeout(() => {
        onSearchRef.current?.('');
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen, useBackendSearch, searchQuery]);

  // Calculate dropdown position when it opens
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - rect.bottom;
      const spaceAbove = rect.top;
      
      // Calculate max height based on available space
      const maxHeightValue = maxHeight.includes('vh') 
        ? parseFloat(maxHeight) * viewportHeight / 100
        : maxHeight.includes('px')
        ? parseFloat(maxHeight)
        : parseFloat(maxHeight) * viewportHeight / 100;
      
      // Always prefer opening downward unless there's very little space below
      // Only open upward if there's less than 150px below
      const minSpaceForDownward = 150;
      const openDownward = spaceBelow >= minSpaceForDownward;
      
      let calculatedMaxHeight: number;
      
      if (openDownward) {
        // Open downward - position directly below the trigger using 'top'
        const top = rect.bottom + 4; // 4px gap below
        // Limit height to available space below (with padding)
        calculatedMaxHeight = Math.min(maxHeightValue, spaceBelow - 20);
        
        setDropdownPosition({
          top: top,
          left: rect.left,
          width: rect.width,
          maxHeight: calculatedMaxHeight
        });
      } else {
        // Open upward - use 'bottom' positioning so dropdown bottom aligns with trigger top
        // Limit height to available space above (with padding)
        calculatedMaxHeight = Math.min(maxHeightValue, spaceAbove - 20);
        // Use bottom positioning: distance from bottom of viewport to top of trigger
        const bottom = viewportHeight - rect.top + 4; // 4px gap above trigger
        
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
  }, [isOpen, maxHeight]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      // Check if click is outside both the trigger button and the dropdown menu
      const isOutsideTrigger = triggerRef.current && !triggerRef.current.contains(target);
      const isOutsideMenu = menuRef.current && !menuRef.current.contains(target);
      
      if (isOutsideTrigger && isOutsideMenu) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    if (isOpen) {
      // Use a small delay to avoid closing immediately when opening
      const timeoutId = setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside);
      }, 0);
      return () => {
        clearTimeout(timeoutId);
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isOpen]);

  const handleSelect = (option: SearchableDropdownOption) => {
    onChange(option.value, option.label, option);
    setSelectedOption(option);
    setIsOpen(false);
    setSearchQuery('');
  };

  const handleClear = () => {
    onChange('', '');
    setSelectedOption(null);
    setSearchQuery('');
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
            {selectedOption ? (
              <div>
                <div className={`text-sm font-medium text-gray-900 ${multiLine ? 'whitespace-pre-line' : 'truncate'}`}>
                  {selectedOption.label}
                </div>
                {showEmailInSelection && showEmail && selectedOption.email && (
                  <div className="text-xs text-gray-500 truncate">
                    {selectedOption.email}
                  </div>
                )}
                {showEmailInSelection && showCode && selectedOption.code && (
                  <div className="text-xs text-gray-500 truncate">
                    {selectedOption.code}
                  </div>
                )}
                {showEmailInSelection && showSublabel && selectedOption.sublabel && (
                  <div className="text-xs text-gray-500 truncate">
                    {selectedOption.sublabel}
                  </div>
                )}
              </div>
            ) : (
              <span className="text-gray-500">{placeholder}</span>
            )}
          </div>
          <div className="flex items-center space-x-2 ml-2">
            {selectedOption && !disabled && (
              <div
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClear();
                }}
                className="text-gray-400 hover:text-gray-600 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </div>
            )}
            <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </div>
        </div>
      </button>

      {/* Dropdown Menu - Use fixed positioning to extend beyond modal */}
      {isOpen && dropdownPosition && (
        <div 
          ref={menuRef}
          className="fixed bg-white border border-gray-300 rounded-lg shadow-xl overflow-hidden"
          style={{ 
            ...(dropdownPosition.top !== undefined ? { top: `${dropdownPosition.top}px` } : {}),
            ...(dropdownPosition.bottom !== undefined ? { bottom: `${dropdownPosition.bottom}px` } : {}),
            left: `${dropdownPosition.left}px`,
            width: `${dropdownPosition.width}px`,
            maxHeight: dropdownPosition.maxHeight 
              ? `${dropdownPosition.maxHeight}px` 
              : (maxHeight.includes('vh') || maxHeight.includes('px') ? maxHeight : `${maxHeight}vh`),
            zIndex: 9999 // Very high z-index to appear above all modal content
          }}
        >
          {/* Search Input */}
          <div className="p-2 border-b border-gray-200 flex-shrink-0">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder={searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                autoFocus
              />
            </div>
          </div>

          {/* Options List - Use calculated maxHeight minus search input height (~60px) */}
          <div 
            className="overflow-y-auto" 
            style={{ 
              maxHeight: dropdownPosition.maxHeight 
                ? `${dropdownPosition.maxHeight - 60}px`
                : (maxHeight.includes('vh') 
                  ? `calc(${maxHeight} - 60px)` 
                  : maxHeight.includes('px')
                  ? `calc(${maxHeight} - 60px)`
                  : `calc(${maxHeight}vh - 60px)`)
            }}
          >
            {loading ? (
              <div className="p-3 text-center text-gray-500">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-oe-primary mx-auto mb-2"></div>
                Loading...
              </div>
            ) : filteredOptions.length === 0 ? (
              <div className="p-3 text-center text-gray-500">
                {searchQuery ? 'No options found' : 'No options available'}
              </div>
            ) : (
              filteredOptions.map((option) => (
                option.isGroupHeader ? (
                  <div
                    key={option.id}
                    className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 border-b border-gray-100 sticky top-0"
                  >
                    {option.label}
                  </div>
                ) : (
                  <DropdownOptionWithTooltip
                    key={option.id}
                    option={option}
                    value={value}
                    multiLine={multiLine}
                    showEmail={showEmail}
                    showCode={showCode}
                    showSublabel={showSublabel}
                    onSelect={handleSelect}
                  />
                )
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SearchableDropdown;
