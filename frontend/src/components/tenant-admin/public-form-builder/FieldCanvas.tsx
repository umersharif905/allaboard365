import { DragDropContext, Draggable, Droppable, type DropResult } from '@hello-pangea/dnd';
import type { FieldDef, HeaderImageDef } from '../../../types/publicFormDefinition';
import { isLegacyFieldType } from '../../../types/publicFormDefinition';

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function FieldPreview({ field }: { field: FieldDef }) {
  const legacy = isLegacyFieldType(field.type);
  const showTopLabel = field.type !== 'checkbox' && field.type !== 'terms';
  const textLikePreview =
    field.type === 'text' ||
    field.type === 'email' ||
    field.type === 'tel' ||
    field.type === 'first_name' ||
    field.type === 'last_name' ||
    field.type === 'member_id';

  return (
    <div className="pointer-events-none space-y-1">
      {showTopLabel && (
        <div className="text-xs font-medium text-gray-800">
          {field.label}
          {field.required ? <span className="text-red-600"> *</span> : null}
        </div>
      )}
      {textLikePreview ? (
        <div className="space-y-0.5">
          <div className="h-9 border border-gray-300 rounded px-2 flex items-center text-gray-400 text-xs bg-gray-50">
            {field.placeholder || '…'}
          </div>
          {(field.type === 'first_name' || field.type === 'last_name' || field.type === 'member_id') && (
            <span className="text-[9px] text-gray-400 font-mono">
              {field.type === 'first_name' ? '→ firstName' : field.type === 'last_name' ? '→ lastName' : '→ memberId'}
            </span>
          )}
        </div>
      ) : null}
      {field.type === 'date' ? (
        <div className="h-9 border border-gray-300 rounded px-2 flex items-center text-gray-400 text-xs bg-gray-50">
          yyyy-mm-dd
        </div>
      ) : null}
      {field.type === 'textarea' || field.type === 'paragraph' ? (
        <div
          className="border border-gray-300 rounded px-2 py-1 text-gray-400 text-xs bg-gray-50"
          style={{
            minHeight: `${Math.min(
              120,
              16 + (field.rows ?? (field.type === 'paragraph' ? 8 : 4)) * 12
            )}px`
          }}
        />
      ) : null}
      {field.type === 'static_html' ? (
        <div className="text-[10px] text-gray-600 border border-dashed border-gray-300 rounded p-2 bg-gray-50 max-h-20 overflow-hidden">
          {field.contentHtml ? stripHtml(field.contentHtml).slice(0, 100) : 'Rich content'}
          …
        </div>
      ) : null}
      {field.type === 'select' ? (
        <div className="h-9 border border-gray-300 rounded px-2 flex items-center text-gray-500 text-xs bg-white">
          Select…
        </div>
      ) : null}
      {field.type === 'radio' ? (
        <div className="space-y-1 pl-1">
          {(field.options || []).slice(0, 4).map((o) => (
            <div key={o.value} className="flex items-center gap-2 text-[11px] text-gray-600">
              <span className="w-3 h-3 rounded-full border border-gray-400 shrink-0" />
              <span className="truncate">{o.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      {field.type === 'checkbox_group' ? (
        <div className="space-y-1 pl-1">
          {(field.options || []).slice(0, 4).map((o) => (
            <div key={o.value} className="flex items-center gap-2 text-[11px] text-gray-600">
              <span className="w-3 h-3 border border-gray-400 rounded shrink-0" />
              <span className="truncate">{o.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      {field.type === 'terms' ? (
        <div className="space-y-2 border border-gray-200 rounded p-2 bg-gray-50">
          <p className="text-[10px] text-gray-500">
            {field.termsHtml ? stripHtml(field.termsHtml).slice(0, 60) || 'Rich text' : 'Rich text'}
            …
          </p>
          <div className="flex items-start gap-2 text-xs text-gray-800">
            <span className="inline-block w-3.5 h-3.5 border border-gray-400 rounded mt-0.5 bg-white shrink-0" />
            <span>
              {field.label}
              {field.required ? <span className="text-red-600"> *</span> : null}
            </span>
          </div>
        </div>
      ) : null}
      {field.type === 'checkbox' ? (
        <div className="flex items-start gap-2 text-xs text-gray-800">
          <span className="inline-block w-3.5 h-3.5 border border-gray-400 rounded mt-0.5 bg-white shrink-0" />
          <span>
            {field.label}
            {field.required ? <span className="text-red-600"> *</span> : null}
          </span>
        </div>
      ) : null}
      {field.type === 'signature' ? (
        <div className="h-16 border border-dashed border-gray-300 rounded bg-gray-50 flex items-center justify-center text-[10px] text-gray-500">
          Signature pad (audit metadata applied on submit)
        </div>
      ) : null}
      {field.type === 'file' ? (
        <div className="text-xs text-gray-500 border border-dashed border-gray-300 rounded px-2 py-2 bg-gray-50">
          Choose files…
        </div>
      ) : null}
      {field.type === 'provider_search' ? (
        <div className="border border-dashed border-gray-300 rounded bg-gray-50 p-2 space-y-1">
          <div className="h-7 border border-gray-300 rounded bg-white" />
          <div className="flex gap-1">
            <div className="h-7 flex-1 border border-gray-300 rounded bg-white" />
            <div className="h-7 w-16 rounded bg-oe-primary/70" />
          </div>
          <span className="text-[9px] text-gray-400">
            NPI provider search ({field.providerSearchMode || 'individual'})
          </span>
        </div>
      ) : null}
      {field.type === 'anatomy_surgery' ? (
        <div className="border border-dashed border-gray-300 rounded bg-gray-50 p-2 flex items-center justify-center min-h-[3rem]">
          <span className="text-[10px] text-gray-500">Anatomy procedure selector</span>
        </div>
      ) : null}
      {field.helperText && field.type !== 'checkbox' && field.type !== 'terms' && (
        <p className="text-[10px] text-gray-500">{field.helperText}</p>
      )}
      {legacy && (
        <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-900">
          {field.type}
        </span>
      )}
    </div>
  );
}

export function FieldCanvas({
  headerHtml,
  headerImage,
  fields,
  selectedName,
  onSelect,
  onDragEnd,
  emptyHint
}: {
  headerHtml?: string;
  headerImage?: HeaderImageDef;
  fields: FieldDef[];
  selectedName: string | null;
  onSelect: (name: string) => void;
  onDragEnd: (result: DropResult) => void;
  /** Override the empty-canvas hint (e.g. per-page copy on multi-page forms). */
  emptyHint?: string;
}) {
  const headerPlain = headerHtml?.trim() ? stripHtml(headerHtml) : '';
  const justify =
    headerImage?.align === 'left'
      ? 'justify-start'
      : headerImage?.align === 'right'
        ? 'justify-end'
        : 'justify-center';

  return (
    <div>
      {headerImage?.url?.trim() ? (
        <div className={`mb-3 flex ${justify}`}>
          <img
            src={headerImage.url}
            alt=""
            className="max-h-16 max-w-[40%] object-contain rounded border border-dashed border-gray-300"
          />
        </div>
      ) : null}
      {headerPlain ? (
        <div className="mb-3 px-2 py-2 rounded border border-dashed border-oe-primary/30 bg-oe-light text-[11px] text-gray-900">
          <span className="font-semibold">Form header: </span>
          {headerPlain.length > 140 ? `${headerPlain.slice(0, 140)}…` : headerPlain}
        </div>
      ) : null}
      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="form-fields">
          {(provided) => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className="flex flex-wrap gap-2 min-h-[120px]"
            >
              {fields.length === 0 && (
                <p className="w-full text-sm text-gray-500 py-8 text-center border border-dashed border-gray-200 rounded-lg">
                  {emptyHint || 'Add fields from the palette or reorder them here.'}
                </p>
              )}
              {fields.map((field, index) => {
                const isHalf = field.width === 'half';
                const isHidden = !!field.defaultHidden;
                return (
                  <Draggable key={field.name} draggableId={field.name} index={index}>
                    {(dragProvided, snapshot) => (
                      <div
                        ref={dragProvided.innerRef}
                        {...dragProvided.draggableProps}
                        {...dragProvided.dragHandleProps}
                        role="button"
                        tabIndex={0}
                        onClick={() => onSelect(field.name)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelect(field.name);
                          }
                        }}
                        className={`relative rounded-lg border p-3 text-left cursor-grab active:cursor-grabbing transition-all duration-150 ease-out active:scale-[0.995] active:brightness-[0.99] ${
                          isHalf ? 'w-[calc(50%-0.25rem)]' : 'w-full'
                        } ${
                          selectedName === field.name
                            ? 'border-oe-primary ring-1 ring-oe-light bg-oe-light/70'
                            : 'border-gray-200 bg-white hover:border-gray-300'
                        } ${snapshot.isDragging ? 'shadow-lg' : ''}`}
                      >
                        {isHidden && (
                          <div className="absolute top-1.5 right-1.5">
                            <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                              hidden by default
                            </span>
                          </div>
                        )}
                        <FieldPreview field={field} />
                      </div>
                    )}
                  </Draggable>
                );
              })}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>
    </div>
  );
}
