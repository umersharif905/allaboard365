// CaseSettings — VendorAdmin-only editor for the per-vendor ticket
// type/subcategory taxonomy. Rendered in the workspace's main pane when the
// URL matches /vendor/cases/settings.
//
// Out of scope here: drag-reorder (using up/down arrows instead — keeps the
// dependency surface small), color/icon customization, hard-delete.

import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Briefcase,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import {
  useFullCaseTaxonomy,
  useCreateType,
  useUpdateType,
  useReorderTypes,
  useCreateSubcategory,
  useUpdateSubcategory,
  useReorderSubcategories,
  type TaxonomyType,
  type TaxonomySubcategory,
} from '../../../hooks/useCaseTaxonomy';

const CaseSettings = () => {
  const { data: types = [], isLoading, isError } = useFullCaseTaxonomy();
  const reorderTypes = useReorderTypes();
  const [expandedTypeId, setExpandedTypeId] = useState<string | null>(null);
  const [addingType, setAddingType] = useState(false);

  const moveType = (typeId: string, direction: -1 | 1) => {
    const idx = types.findIndex((t) => t.typeId === typeId);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= types.length) return;
    const ordered = [...types];
    const [moved] = ordered.splice(idx, 1);
    ordered.splice(target, 0, moved);
    reorderTypes.mutate(ordered.map((t) => t.typeId));
  };

  return (
    <div className="p-4 sm:p-6 max-w-3xl">
      <div className="mb-4 flex items-center gap-2">
        <SettingsIcon className="h-5 w-5 text-oe-primary" />
        <h1 className="text-lg font-semibold text-gray-900">Case Settings</h1>
      </div>
      <p className="text-sm text-gray-600 mb-5">
        Customize the types and subcategories used when creating cases for your vendor.
        Renaming preserves existing tickets. Disabling hides an item from the create dropdown but
        keeps it on tickets that already use it.
      </p>

      {isLoading && <div className="text-sm text-gray-500">Loading…</div>}
      {isError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Failed to load taxonomy.
        </div>
      )}

      {!isLoading && !isError && (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {types.map((t, i) => (
            <TypeRow
              key={t.typeId}
              type={t}
              isExpanded={expandedTypeId === t.typeId}
              onToggle={() => setExpandedTypeId(expandedTypeId === t.typeId ? null : t.typeId)}
              onMoveUp={i > 0 ? () => moveType(t.typeId, -1) : undefined}
              onMoveDown={i < types.length - 1 ? () => moveType(t.typeId, 1) : undefined}
            />
          ))}

          {addingType ? (
            <AddTypeRow onDone={() => setAddingType(false)} />
          ) : (
            <button
              type="button"
              onClick={() => setAddingType(true)}
              className="w-full flex items-center justify-center gap-1.5 px-4 py-3 text-sm font-medium text-oe-primary hover:bg-oe-light/40"
            >
              <Plus className="h-4 w-4" /> Add type
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------

const TypeRow = ({
  type, isExpanded, onToggle, onMoveUp, onMoveDown,
}: {
  type: TaxonomyType;
  isExpanded: boolean;
  onToggle: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(type.label);
  const updateType = useUpdateType();
  const reorderSubs = useReorderSubcategories();
  const [addingSub, setAddingSub] = useState(false);

  const moveSub = (subcategoryId: string, direction: -1 | 1) => {
    const idx = type.subcategories.findIndex((s) => s.subcategoryId === subcategoryId);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= type.subcategories.length) return;
    const ordered = [...type.subcategories];
    const [moved] = ordered.splice(idx, 1);
    ordered.splice(target, 0, moved);
    reorderSubs.mutate({ typeId: type.typeId, orderedSubcategoryIds: ordered.map((s) => s.subcategoryId) });
  };

  const handleSaveLabel = () => {
    if (!label.trim()) return;
    if (label === type.label) { setEditing(false); return; }
    updateType.mutate({ typeId: type.typeId, body: { label: label.trim() } }, { onSuccess: () => setEditing(false) });
  };

  const handleToggleActive = () => {
    updateType.mutate({ typeId: type.typeId, body: { isActive: !type.isActive } });
  };

  return (
    <div>
      <div className={`flex items-center gap-2 px-4 py-3 ${type.isActive === false ? 'opacity-60' : ''}`}>
        <button
          type="button"
          onClick={onToggle}
          className="p-0.5 text-gray-400 hover:text-gray-700"
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
        >
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <Briefcase className="h-4 w-4 text-oe-primary shrink-0" />

        {editing ? (
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSaveLabel(); if (e.key === 'Escape') { setLabel(type.label); setEditing(false); } }}
            autoFocus
            className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-oe-primary"
          />
        ) : (
          <span className="flex-1 text-sm font-medium text-gray-900">
            {type.label}
            <span className="ml-2 text-xs text-gray-400 font-mono">{type.code}</span>
            {type.isActive === false && (
              <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">Disabled</span>
            )}
          </span>
        )}

        <div className="flex items-center gap-1 shrink-0">
          {editing ? (
            <>
              <IconBtn onClick={handleSaveLabel} disabled={updateType.isPending || !label.trim()} label="Save" tone="primary"><Check className="h-3.5 w-3.5" /></IconBtn>
              <IconBtn onClick={() => { setLabel(type.label); setEditing(false); }} label="Cancel"><X className="h-3.5 w-3.5" /></IconBtn>
            </>
          ) : (
            <>
              <IconBtn onClick={onMoveUp} disabled={!onMoveUp} label="Move up"><ArrowUp className="h-3.5 w-3.5" /></IconBtn>
              <IconBtn onClick={onMoveDown} disabled={!onMoveDown} label="Move down"><ArrowDown className="h-3.5 w-3.5" /></IconBtn>
              <IconBtn onClick={() => setEditing(true)} label="Rename"><Pencil className="h-3.5 w-3.5" /></IconBtn>
              <IconBtn
                onClick={handleToggleActive}
                label={type.isActive ? 'Disable' : 'Enable'}
                disabled={updateType.isPending}
              >
                {type.isActive ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </IconBtn>
            </>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="pl-10 pr-4 pb-3 space-y-1">
          {type.subcategories.length === 0 && (
            <p className="text-xs text-gray-500 py-1">No subcategories yet.</p>
          )}
          {type.subcategories.map((s, i) => (
            <SubRow
              key={s.subcategoryId}
              sub={s}
              onMoveUp={i > 0 ? () => moveSub(s.subcategoryId, -1) : undefined}
              onMoveDown={i < type.subcategories.length - 1 ? () => moveSub(s.subcategoryId, 1) : undefined}
            />
          ))}

          {addingSub ? (
            <AddSubRow typeId={type.typeId} onDone={() => setAddingSub(false)} />
          ) : (
            <button
              type="button"
              onClick={() => setAddingSub(true)}
              className="inline-flex items-center gap-1.5 text-xs text-oe-primary hover:text-oe-dark px-2 py-1"
            >
              <Plus className="h-3.5 w-3.5" /> Add subcategory
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const SubRow = ({
  sub, onMoveUp, onMoveDown,
}: {
  sub: TaxonomySubcategory;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(sub.label);
  const updateSub = useUpdateSubcategory();

  const handleSaveLabel = () => {
    if (!label.trim()) return;
    if (label === sub.label) { setEditing(false); return; }
    updateSub.mutate({ subcategoryId: sub.subcategoryId, body: { label: label.trim() } }, { onSuccess: () => setEditing(false) });
  };

  const handleToggleActive = () => {
    updateSub.mutate({ subcategoryId: sub.subcategoryId, body: { isActive: !sub.isActive } });
  };

  return (
    <div className={`flex items-center gap-2 py-1 ${sub.isActive === false ? 'opacity-60' : ''}`}>
      {editing ? (
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSaveLabel(); if (e.key === 'Escape') { setLabel(sub.label); setEditing(false); } }}
          autoFocus
          className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-oe-primary"
        />
      ) : (
        <span className="flex-1 text-sm text-gray-800">
          {sub.label}
          <span className="ml-2 text-[11px] text-gray-400 font-mono">{sub.code}</span>
          {sub.isActive === false && (
            <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">Disabled</span>
          )}
        </span>
      )}
      <div className="flex items-center gap-1 shrink-0">
        {editing ? (
          <>
            <IconBtn onClick={handleSaveLabel} disabled={updateSub.isPending || !label.trim()} label="Save" tone="primary"><Check className="h-3.5 w-3.5" /></IconBtn>
            <IconBtn onClick={() => { setLabel(sub.label); setEditing(false); }} label="Cancel"><X className="h-3.5 w-3.5" /></IconBtn>
          </>
        ) : (
          <>
            <IconBtn onClick={onMoveUp} disabled={!onMoveUp} label="Move up"><ArrowUp className="h-3.5 w-3.5" /></IconBtn>
            <IconBtn onClick={onMoveDown} disabled={!onMoveDown} label="Move down"><ArrowDown className="h-3.5 w-3.5" /></IconBtn>
            <IconBtn onClick={() => setEditing(true)} label="Rename"><Pencil className="h-3.5 w-3.5" /></IconBtn>
            <IconBtn
              onClick={handleToggleActive}
              label={sub.isActive ? 'Disable' : 'Enable'}
              disabled={updateSub.isPending}
            >
              {sub.isActive ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </IconBtn>
          </>
        )}
      </div>
    </div>
  );
};

const AddTypeRow = ({ onDone }: { onDone: () => void }) => {
  const [label, setLabel] = useState('');
  const createType = useCreateType();
  const handleSave = () => {
    if (!label.trim()) return;
    createType.mutate({ label: label.trim() }, { onSuccess: () => { setLabel(''); onDone(); } });
  };
  return (
    <div className="flex items-center gap-2 px-4 py-3 bg-oe-light/30">
      <Briefcase className="h-4 w-4 text-oe-primary shrink-0" />
      <input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onDone(); }}
        placeholder="New type name…"
        autoFocus
        className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-oe-primary"
      />
      <IconBtn onClick={handleSave} disabled={createType.isPending || !label.trim()} label="Save" tone="primary"><Check className="h-3.5 w-3.5" /></IconBtn>
      <IconBtn onClick={onDone} label="Cancel"><X className="h-3.5 w-3.5" /></IconBtn>
    </div>
  );
};

const AddSubRow = ({ typeId, onDone }: { typeId: string; onDone: () => void }) => {
  const [label, setLabel] = useState('');
  const createSub = useCreateSubcategory();
  const handleSave = () => {
    if (!label.trim()) return;
    createSub.mutate({ typeId, body: { label: label.trim() } }, { onSuccess: () => { setLabel(''); onDone(); } });
  };
  return (
    <div className="flex items-center gap-2 py-1">
      <input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onDone(); }}
        placeholder="New subcategory name…"
        autoFocus
        className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-oe-primary"
      />
      <IconBtn onClick={handleSave} disabled={createSub.isPending || !label.trim()} label="Save" tone="primary"><Check className="h-3.5 w-3.5" /></IconBtn>
      <IconBtn onClick={onDone} label="Cancel"><X className="h-3.5 w-3.5" /></IconBtn>
    </div>
  );
};

const IconBtn = ({
  children, onClick, disabled, label, tone,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  label: string;
  tone?: 'primary';
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={label}
    className={`p-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      tone === 'primary'
        ? 'text-white bg-oe-primary hover:bg-oe-dark'
        : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
    }`}
  >
    {children}
  </button>
);

export default CaseSettings;
