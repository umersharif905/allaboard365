/**
 * Shared interactive styles for the public form builder: visible press feedback + focus rings.
 */

const press = 'transition-transform duration-150 ease-out active:scale-[0.97] disabled:active:scale-100';
const pressSoft = 'transition-all duration-150 ease-out active:scale-[0.98] disabled:active:scale-100';
const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oe-primary focus-visible:ring-offset-1';

/** “Add field” palette buttons */
export const fbPaletteBtn = `text-left w-full px-3 py-2 rounded border border-gray-200 bg-white hover:bg-gray-50 text-sm text-gray-800 active:bg-gray-100 ${press} ${focusRing}`;

/** Small bordered controls (e.g. option Up / Down) */
export const fbInspectorIconBtn = `text-[10px] px-1.5 py-0.5 border border-gray-200 rounded bg-white hover:bg-gray-50 active:bg-gray-100 ${press} ${focusRing} disabled:opacity-40`;

/** Red text action (remove option) */
export const fbInspectorDangerIconBtn = `text-[10px] px-1.5 py-0.5 rounded border border-red-200 bg-white text-red-700 hover:bg-red-50 active:bg-red-100 ${press} ${focusRing}`;

/** + Add option */
export const fbAddOptionBtn = `text-xs text-oe-primary hover:text-oe-dark hover:underline rounded px-1 py-0.5 transition-opacity duration-150 active:opacity-60 ${focusRing}`;

/** Remove field (inspector header) */
export const fbRemoveFieldBtn = `text-xs text-red-700 hover:underline rounded px-1 py-0.5 transition-opacity duration-150 active:opacity-60 ${focusRing}`;

/** Outline button (Preview, Upload image) */
export const fbOutlineBtn = `inline-flex items-center justify-center border border-gray-300 bg-white px-3 py-1.5 rounded text-sm text-gray-800 hover:bg-gray-50 active:bg-gray-100 ${pressSoft} ${focusRing} disabled:opacity-50`;

/** Header image upload (slightly denser) */
export const fbHeaderUploadBtn = `border border-gray-300 bg-gray-50 px-3 py-1.5 rounded text-sm text-gray-800 hover:bg-gray-100 active:bg-gray-200 ${pressSoft} ${focusRing} disabled:opacity-50`;

/** Remove image (text link) */
export const fbTextDangerBtn = `text-sm text-red-700 hover:underline rounded px-1 py-0.5 transition-opacity duration-150 active:opacity-60 ${focusRing}`;

/** Preview dialog Close */
export const fbDialogCloseBtn = `rounded px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 ${pressSoft} ${focusRing}`;

/** Editor page: primary solid actions */
export const fbSolidSlateBtn = `bg-oe-primary text-white px-4 py-2 rounded text-sm hover:bg-oe-dark active:opacity-95 ${pressSoft} ${focusRing}`;

export const fbSolidDangerOutlineBtn = `border border-red-300 text-red-800 bg-white px-4 py-2 rounded text-sm hover:bg-red-50 active:bg-red-100 ${pressSoft} ${focusRing}`;

export const fbSolidBlueBtn = `bg-oe-primary text-white px-4 py-2 rounded text-sm hover:bg-oe-dark active:opacity-95 ${pressSoft} ${focusRing} disabled:opacity-50`;

export const fbSolidEmeraldBtn = `bg-oe-success text-white px-4 py-2 rounded text-sm hover:opacity-90 active:opacity-90 ${pressSoft} ${focusRing} disabled:opacity-50`;

/** Version table “Open in editor” */
export const fbLinkBlueBtn = `text-oe-primary hover:text-oe-dark hover:underline rounded px-0.5 py-0.5 transition-opacity duration-150 active:opacity-60 ${focusRing} disabled:opacity-50`;
