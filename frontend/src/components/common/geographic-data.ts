// Common geographic data for the application
// Location: frontend/src/components/common/geographic-data.ts

// Type definitions
export interface GeographicLocation {
  name: string;
  code: string;
}

export interface Country extends GeographicLocation {
  states?: GeographicLocation[];
  provinces?: GeographicLocation[];
}

export const US_STATES: GeographicLocation[] = [
  { name: "ALABAMA", code: "AL" },
  { name: "ALASKA", code: "AK" },
  { name: "AMERICAN SAMOA", code: "AS" },
  { name: "ARIZONA", code: "AZ" },
  { name: "ARKANSAS", code: "AR" },
  { name: "CALIFORNIA", code: "CA" },
  { name: "COLORADO", code: "CO" },
  { name: "CONNECTICUT", code: "CT" },
  { name: "DELAWARE", code: "DE" },
  { name: "DISTRICT OF COLUMBIA", code: "DC" },
  { name: "FLORIDA", code: "FL" },
  { name: "GEORGIA", code: "GA" },
  { name: "GUAM", code: "GU" },
  { name: "HAWAII", code: "HI" },
  { name: "IDAHO", code: "ID" },
  { name: "ILLINOIS", code: "IL" },
  { name: "INDIANA", code: "IN" },
  { name: "IOWA", code: "IA" },
  { name: "KANSAS", code: "KS" },
  { name: "KENTUCKY", code: "KY" },
  { name: "LOUISIANA", code: "LA" },
  { name: "MAINE", code: "ME" },
  { name: "MARYLAND", code: "MD" },
  { name: "MASSACHUSETTS", code: "MA" },
  { name: "MICHIGAN", code: "MI" },
  { name: "MINNESOTA", code: "MN" },
  { name: "MISSISSIPPI", code: "MS" },
  { name: "MISSOURI", code: "MO" },
  { name: "MONTANA", code: "MT" },
  { name: "NEBRASKA", code: "NE" },
  { name: "NEVADA", code: "NV" },
  { name: "NEW HAMPSHIRE", code: "NH" },
  { name: "NEW JERSEY", code: "NJ" },
  { name: "NEW MEXICO", code: "NM" },
  { name: "NEW YORK", code: "NY" },
  { name: "NORTH CAROLINA", code: "NC" },
  { name: "NORTH DAKOTA", code: "ND" },
  { name: "NORTHERN MARIANA IS", code: "MP" },
  { name: "OHIO", code: "OH" },
  { name: "OKLAHOMA", code: "OK" },
  { name: "OREGON", code: "OR" },
  { name: "PENNSYLVANIA", code: "PA" },
  { name: "PUERTO RICO", code: "PR" },
  { name: "RHODE ISLAND", code: "RI" },
  { name: "SOUTH CAROLINA", code: "SC" },
  { name: "SOUTH DAKOTA", code: "SD" },
  { name: "TENNESSEE", code: "TN" },
  { name: "TEXAS", code: "TX" },
  { name: "UTAH", code: "UT" },
  { name: "VERMONT", code: "VT" },
  { name: "VIRGINIA", code: "VA" },
  { name: "VIRGIN ISLANDS", code: "VI" },
  { name: "WASHINGTON", code: "WA" },
  { name: "WEST VIRGINIA", code: "WV" },
  { name: "WISCONSIN", code: "WI" },
  { name: "WYOMING", code: "WY" }
];

export const CANADIAN_PROVINCES: GeographicLocation[] = [
  { name: "ALBERTA", code: "AB" },
  { name: "BRITISH COLUMBIA", code: "BC" },
  { name: "MANITOBA", code: "MB" },
  { name: "NEW BRUNSWICK", code: "NB" },
  { name: "NEWFOUNDLAND AND LABRADOR", code: "NL" },
  { name: "NORTHWEST TERRITORIES", code: "NT" },
  { name: "NOVA SCOTIA", code: "NS" },
  { name: "NUNAVUT", code: "NU" },
  { name: "ONTARIO", code: "ON" },
  { name: "PRINCE EDWARD ISLAND", code: "PE" },
  { name: "QUEBEC", code: "QC" },
  { name: "SASKATCHEWAN", code: "SK" },
  { name: "YUKON", code: "YT" }
];

export const COUNTRIES: Country[] = [
  { name: "United States", code: "US", states: US_STATES },
  { name: "Canada", code: "CA", provinces: CANADIAN_PROVINCES },
  { name: "Mexico", code: "MX" },
  { name: "United Kingdom", code: "GB" },
  { name: "Germany", code: "DE" },
  { name: "France", code: "FR" },
  { name: "Italy", code: "IT" },
  { name: "Spain", code: "ES" },
  { name: "Australia", code: "AU" },
  { name: "New Zealand", code: "NZ" },
  { name: "Japan", code: "JP" },
  { name: "China", code: "CN" },
  { name: "India", code: "IN" },
  { name: "Brazil", code: "BR" },
  { name: "Argentina", code: "AR" },
  { name: "South Africa", code: "ZA" }
];

// Helper functions
export const getStatesByCountry = (countryCode: string) => {
  const country = COUNTRIES.find(c => c.code === countryCode);
  if (country) {
    if (countryCode === 'US') return country.states || [];
    if (countryCode === 'CA') return country.provinces || [];
  }
  return [];
};

export const getStateByCode = (stateCode: string, countryCode: string = 'US') => {
  const states = getStatesByCountry(countryCode);
  return states.find(s => s.code === stateCode);
};

export const getCountryByCode = (countryCode: string) => {
  return COUNTRIES.find(c => c.code === countryCode);
};

// For backward compatibility - all states/provinces combined
export const ALL_STATES_PROVINCES = [
  ...US_STATES,
  ...CANADIAN_PROVINCES
];

// Multiple format exports for different component needs
export const US_STATES_FORMATTED = US_STATES.map(state => ({
  value: state.code,
  label: state.name
}));

export const US_STATES_CODE_NAME = US_STATES.map(state => ({
  code: state.code,
  name: state.name
}));

export const US_STATES_NAME_CODE = US_STATES.map(state => ({
  name: state.name,
  code: state.code
}));