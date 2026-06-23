/** Matches backend `newGroupFormGenerationService` vendor group ID placeholders. */
export function isVendorGroupIdSystemVariable(systemVariable?: string): boolean {
  const s = (systemVariable || '').trim().toLowerCase();
  return s === 'group.vendormastergroupid' || s.startsWith('group.vendorproductgroupid_');
}

/** Backend fills group.vendorNetworkTitle from DB: group's vendor-network override if set; else that vendor's default network (VendorNetworks.IsDefault). Not related to the field editor "Default value" box. GUIDs are intentionally not exposed on the form. */
export const NEW_GROUP_FORM_VENDOR_NETWORK_SYSTEM_VARIABLES: ReadonlyArray<{ value: string; label: string }> = [
  {
    value: 'group.vendorNetworkTitle',
    label: "Group: Vendor network name (group override, else vendor's default network)",
  },
];

export function isVendorNetworkSystemVariable(systemVariable?: string): boolean {
  const s = (systemVariable || '').trim().toLowerCase();
  return s === 'group.vendornetworktitle';
}
