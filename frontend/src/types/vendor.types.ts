export interface Vendor {
  VendorId: string;
  TenantId: string;
  VendorName: string;
  Address1?: string;
  Address2?: string;
  City?: string;
  State?: string;
  ZipCode?: string;
  ContactName?: string;
  Phone?: string;
  Email?: string;
  /** Minimum enrolled employees required per group (null = no minimum). */
  MinimumEmployeesPerGroup?: number | null;
}
