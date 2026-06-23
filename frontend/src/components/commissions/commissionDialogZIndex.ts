/**
 * Stacking order for commission wizards and nested pickers (all roles / tenants).
 * Parent wizard must stay below nested dialogs so Add Tier, AI, Copy, etc. are visible.
 */
export const COMMISSION_WIZARD_DIALOG_Z = 1500;

/** Nested inside commission wizard (Add Tier, Edit with AI, Copy from rule, …). */
export const COMMISSION_NESTED_DIALOG_Z = 1700;

/** Confirm dialogs opened on top of another nested commission dialog. */
export const COMMISSION_NESTED_CONFIRM_DIALOG_Z = 1800;

export function commissionDialogSlotProps(zIndex: number) {
  return {
    root: { sx: { zIndex }, style: { zIndex } },
    paper: { sx: { zIndex } },
    backdrop: { sx: { zIndex: zIndex - 1 } },
    container: { sx: { zIndex } },
  };
}

/** Nested confirm/ack dialogs rendered inside a parent commission Dialog (use with disablePortal). */
export function commissionNestedConfirmDialogProps() {
  const z = COMMISSION_NESTED_CONFIRM_DIALOG_Z;
  return {
    disablePortal: true,
    sx: { zIndex: z },
    slotProps: commissionDialogSlotProps(z),
  };
}
