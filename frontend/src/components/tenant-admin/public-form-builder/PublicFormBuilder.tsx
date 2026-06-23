import { FieldPalette } from './FieldPalette';
import { FieldCanvas } from './FieldCanvas';
import { FieldInspector } from './FieldInspector';
import { PageManager } from './PageManager';
import { PreScreeningManager } from './PreScreeningManager';
import { RichHtmlEditor } from './RichHtmlEditor';
import { FormHeaderImageControls } from './FormHeaderImageControls';
import type { FormDefinitionController } from './useFormDefinition';

/**
 * The form-building surface — the body of the editor's "Build form" tab.
 * Controlled: all definition state + mutators come from `useFormDefinition`,
 * which the editor page owns and also shares with the Setup tab. The
 * form-structure toggles (multi-page / pre-screening) live in Setup; this
 * component only reacts to `def.multiPage` / `def.preScreeningEnabled`.
 */
export function PublicFormBuilder({
  controller,
  formTemplateId
}: {
  controller: FormDefinitionController;
  /** Required for header image upload to Azure */
  formTemplateId?: string;
}) {
  const {
    def,
    pages,
    activePage,
    patchDef,
    selectedName,
    setSelectedName,
    selectedField,
    nameDuplicate,
    activePageId,
    setActivePageId,
    canvasFields,
    fieldCountByPage,
    handleAdd,
    handleAddMemberField,
    handleDragEnd,
    updateSelected,
    removeSelected,
    setPreScreening,
    addPage,
    updatePage,
    removePage,
    movePage
  } = controller;

  return (
    <div className="space-y-6">
      {/* Form header & intro — a compact, always-visible mirror of how the
          public form opens: header image + rich text, then heading + intro. */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Form header &amp; intro
        </span>
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="sm:w-72 shrink-0">
            {formTemplateId ? (
              <FormHeaderImageControls
                formTemplateId={formTemplateId}
                value={def.headerImage}
                onChange={(headerImage) => patchDef({ headerImage })}
              />
            ) : (
              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded p-2">
                Save the form first to upload a header image.
              </p>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <RichHtmlEditor
              compact
              value={def.headerHtml ?? ''}
              onChange={(html) => patchDef({ headerHtml: html || undefined })}
            />
            <p className="text-[11px] text-gray-500 mt-1">
              Rich text shown at the top of the public form, below the image.
            </p>
          </div>
        </div>

        <div className="max-w-2xl space-y-3">
          <label className="block text-sm">
            <span className="text-gray-600">
              Form heading <span className="text-gray-400">— if blank, the form's title is used</span>
            </span>
            <input
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
              value={def.title}
              onChange={(e) => patchDef({ title: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">
              Introduction <span className="text-gray-400">— plain text under the heading</span>
            </span>
            <textarea
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm min-h-[60px] focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
              rows={2}
              value={def.introHtml ?? ''}
              onChange={(e) => patchDef({ introHtml: e.target.value || undefined })}
            />
          </label>
        </div>
      </div>

      {/* Pre-screening manager */}
      {def.preScreeningEnabled && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <PreScreeningManager
            questions={def.preScreening ?? []}
            pages={pages}
            fields={def.fields}
            onChange={setPreScreening}
          />
        </div>
      )}

      {/* Builder surface — page tabs, palette, canvas, slide-in inspector,
          all zones inside one card. */}
      <div className="rounded-lg border border-gray-200 bg-white">
        {def.multiPage && (
          <div className="px-4 pt-3">
            <PageManager
              pages={pages}
              activePageId={activePageId}
              fieldCountByPage={fieldCountByPage}
              onSelectPage={setActivePageId}
              onAddPage={addPage}
              onUpdatePage={updatePage}
              onRemovePage={removePage}
              onMovePage={movePage}
            />
          </div>
        )}
        <div className="flex min-h-[320px]">
          {/* Palette zone */}
          <div className="w-52 shrink-0 border-r border-gray-200 bg-gray-50/60 p-3">
            <FieldPalette onAdd={handleAdd} onAddMember={handleAddMemberField} />
          </div>
          {/* Canvas zone — the primary surface */}
          <div className="flex-1 min-w-0 p-4">
            {!def.multiPage && (
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">
                Form fields
              </h3>
            )}
            {def.multiPage && activePage?.description?.trim() ? (
              <p className="text-[11px] text-gray-500 mb-3">{activePage.description}</p>
            ) : null}
            <FieldCanvas
              headerHtml={def.headerHtml}
              headerImage={def.headerImage}
              fields={canvasFields}
              selectedName={selectedName}
              onSelect={(name) => setSelectedName((cur) => (cur === name ? null : name))}
              onDragEnd={handleDragEnd}
              emptyHint={
                def.multiPage
                  ? 'This page has no fields yet. Add fields from the palette.'
                  : undefined
              }
            />
          </div>
          {/* Inspector zone — slides in when a field is selected */}
          <div
            className={`shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
              selectedField ? 'w-80 border-l border-gray-200' : 'w-0'
            }`}
          >
            {selectedField && (
              <div className="w-80 p-3">
                <FieldInspector
                  field={selectedField}
                  nameDuplicate={nameDuplicate}
                  multiPage={!!def.multiPage}
                  pages={pages}
                  onChange={updateSelected}
                  onRemove={removeSelected}
                  onClose={() => setSelectedName(null)}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
