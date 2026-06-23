export interface CommissionRole {
  name: string;
  code: string;
}

export const COMMISSION_ROLES: CommissionRole[] = [
  { name: "Field Marketing Organization", code: "FMO" },
  { name: "International Marketing Organization", code: "IMO" },
  { name: "National Marketing Organization", code: "NMO" },
  { name: "Managing General Agency", code: "MGA" },
  { name: "General Agency", code: "GA" },
  { name: "Agent", code: "Agent" },
];
  