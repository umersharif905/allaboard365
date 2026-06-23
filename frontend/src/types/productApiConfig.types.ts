export type PrefillOption = 'memberEmail' | 'memberPhoneNumber' | 'householdMemberID' | 'memberFirstName' | 'memberLastName' | 'memberDateOfBirth' | 'memberGender' | 'memberZipCode' | 'memberCity' | 'memberState' | 'lyricStateId' | 'memberAddress1' | 'memberAddress2' | 'householdId' | 'enrollmentId' | 'familySizeId' | 'authToken' | 'terminationDate' | 'effectiveDate';

export interface ApiHeaderBodyItem {
  key: string;
  value: string;
  prefill: PrefillOption | null;
}

export interface ResponseMapping {
  tokenPath?: string;
  tokenPrefixStrip?: string;
}

export interface AuthStepConfig {
  enabled: boolean;
  endpoint: string;
  method: string;
  contentType: 'application/json' | 'application/x-www-form-urlencoded' | 'multipart/form-data';
  body: ApiHeaderBodyItem[];
  responseMapping: ResponseMapping;
}

export interface EnrollmentApiConfig {
  enabled: boolean;
  method: string;
  endpoint: string;
  contentType?: 'application/json' | 'application/x-www-form-urlencoded' | 'multipart/form-data';
  headers: ApiHeaderBodyItem[];
  body: ApiHeaderBodyItem[];
  responseMapping?: ResponseMapping;
}

export interface DeactivationApiConfig {
  enabled: boolean;
  method: string;
  endpoint: string;
  contentType?: 'application/json' | 'application/x-www-form-urlencoded' | 'multipart/form-data';
  headers: ApiHeaderBodyItem[];
  body: ApiHeaderBodyItem[];
}

export interface UpdateApiConfig {
  enabled: boolean;
  method: string;
  endpoint: string;
  contentType?: 'application/json' | 'application/x-www-form-urlencoded' | 'multipart/form-data';
  headers: ApiHeaderBodyItem[];
  body: ApiHeaderBodyItem[];
}

/** SSO admin login (get JWT) – same pattern as AuthStepConfig */
export interface SSOLoginConfig {
  enabled: boolean;
  endpoint: string;
  method: string;
  contentType: 'application/json' | 'application/x-www-form-urlencoded' | 'multipart/form-data';
  body: ApiHeaderBodyItem[];
  responseMapping: ResponseMapping;
}

/** Optional SSO token request (create member access token) */
export interface SSOTokenRequestConfig {
  enabled: boolean;
  endpoint: string;
  method: string;
  contentType?: 'application/json' | 'application/x-www-form-urlencoded' | 'multipart/form-data';
  headers: ApiHeaderBodyItem[];
  body: ApiHeaderBodyItem[];
}

/** Portal URL and template for member SSO redirect */
export interface SSOPortalConfig {
  portalBaseUrl: string;
  urlTemplate: string;
  customFields: ApiHeaderBodyItem[];
}

export interface SSOConfig {
  enabled: boolean;
  login: SSOLoginConfig;
  tokenRequest?: SSOTokenRequestConfig;
  portal: SSOPortalConfig;
}

export interface ProductAPIConfig {
  /** When true, Azure product-api-jobs timer calls POST /api/scheduled-jobs/product-api-daily for this product (same as "Run API for everyone"). */
  runDaily?: boolean;
  authStep?: AuthStepConfig;
  enrollment?: EnrollmentApiConfig;
  update?: UpdateApiConfig;
  deactivation?: DeactivationApiConfig;
  sso?: SSOConfig;
}

export const PREFILL_OPTIONS: { value: PrefillOption; label: string }[] = [
  { value: 'memberEmail', label: 'Member Email' },
  { value: 'memberPhoneNumber', label: 'Member Phone Number' },
  { value: 'householdMemberID', label: 'Household Member ID' },
  { value: 'memberFirstName', label: 'Member First Name' },
  { value: 'memberLastName', label: 'Member Last Name' },
  { value: 'memberDateOfBirth', label: 'Member Date of Birth (MM/DD/YYYY)' },
  { value: 'memberGender', label: 'Member Gender (m/f/u)' },
  { value: 'memberZipCode', label: 'Member Zip Code' },
  { value: 'memberCity', label: 'Member City' },
  { value: 'memberState', label: 'Member State' },
  { value: 'lyricStateId', label: 'Lyric State ID (from member State abbrev)' },
  { value: 'memberAddress1', label: 'Member Address (line 1)' },
  { value: 'memberAddress2', label: 'Member Address (line 2)' },
  { value: 'familySizeId', label: 'Family Size ID (1=EE, 2=ES/EC, 3=EF)' },
  { value: 'terminationDate', label: 'Termination Date (MM/DD/YYYY, today if past)' },
  { value: 'effectiveDate', label: 'Effective Date (MM/DD/YYYY)' },
  { value: 'authToken', label: 'Auth Token' },
  // { value: 'householdId', label: 'Household ID' },
  // { value: 'enrollmentId', label: 'Enrollment ID' }
];
