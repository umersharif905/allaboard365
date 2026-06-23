/**
 * Lyric Health API state IDs - maps US state abbreviations to Lyric's state_id.
 * Used for Product API prefill (lyricStateId) when member.State is stored as abbreviation (AL, TX, etc.).
 */
const LYRIC_STATES = [
  { state_id: 1, name: 'Alabama', abbreviation: 'AL' },
  { state_id: 2, name: 'Alaska', abbreviation: 'AK' },
  { state_id: 53, name: 'American Samoa', abbreviation: 'AS' },
  { state_id: 3, name: 'Arizona', abbreviation: 'AZ' },
  { state_id: 4, name: 'Arkansas', abbreviation: 'AR' },
  { state_id: 61, name: 'Armed Forces Americas', abbreviation: 'AA' },
  { state_id: 60, name: 'Armed Forces Non-Americas', abbreviation: 'AE' },
  { state_id: 62, name: 'Armed Forces Pacific', abbreviation: 'AP' },
  { state_id: 5, name: 'California', abbreviation: 'CA' },
  { state_id: 6, name: 'Colorado', abbreviation: 'CO' },
  { state_id: 7, name: 'Connecticut', abbreviation: 'CT' },
  { state_id: 8, name: 'Delaware', abbreviation: 'DE' },
  { state_id: 9, name: 'District of Columbia', abbreviation: 'DC' },
  { state_id: 54, name: 'Federated States of Micronesia', abbreviation: 'FM' },
  { state_id: 10, name: 'Florida', abbreviation: 'FL' },
  { state_id: 11, name: 'Georgia', abbreviation: 'GA' },
  { state_id: 55, name: 'Guam', abbreviation: 'GU' },
  { state_id: 12, name: 'Hawaii', abbreviation: 'HI' },
  { state_id: 13, name: 'Idaho', abbreviation: 'ID' },
  { state_id: 14, name: 'Illinois', abbreviation: 'IL' },
  { state_id: 15, name: 'Indiana', abbreviation: 'IN' },
  { state_id: 16, name: 'Iowa', abbreviation: 'IA' },
  { state_id: 17, name: 'Kansas', abbreviation: 'KS' },
  { state_id: 18, name: 'Kentucky', abbreviation: 'KY' },
  { state_id: 19, name: 'Louisiana', abbreviation: 'LA' },
  { state_id: 20, name: 'Maine', abbreviation: 'ME' },
  { state_id: 56, name: 'Marshall Islands', abbreviation: 'MH' },
  { state_id: 21, name: 'Maryland', abbreviation: 'MD' },
  { state_id: 22, name: 'Massachusetts', abbreviation: 'MA' },
  { state_id: 23, name: 'Michigan', abbreviation: 'MI' },
  { state_id: 24, name: 'Minnesota', abbreviation: 'MN' },
  { state_id: 25, name: 'Mississippi', abbreviation: 'MS' },
  { state_id: 26, name: 'Missouri', abbreviation: 'MO' },
  { state_id: 27, name: 'Montana', abbreviation: 'MT' },
  { state_id: 28, name: 'Nebraska', abbreviation: 'NE' },
  { state_id: 29, name: 'Nevada', abbreviation: 'NV' },
  { state_id: 30, name: 'New Hampshire', abbreviation: 'NH' },
  { state_id: 31, name: 'New Jersey', abbreviation: 'NJ' },
  { state_id: 32, name: 'New Mexico', abbreviation: 'NM' },
  { state_id: 33, name: 'New York', abbreviation: 'NY' },
  { state_id: 34, name: 'North Carolina', abbreviation: 'NC' },
  { state_id: 35, name: 'North Dakota', abbreviation: 'ND' },
  { state_id: 57, name: 'Northern Mariana Islands', abbreviation: 'MP' },
  { state_id: 36, name: 'Ohio', abbreviation: 'OH' },
  { state_id: 37, name: 'Oklahoma', abbreviation: 'OK' },
  { state_id: 38, name: 'Oregon', abbreviation: 'OR' },
  { state_id: 58, name: 'Palau', abbreviation: 'PW' },
  { state_id: 39, name: 'Pennsylvania', abbreviation: 'PA' },
  { state_id: 52, name: 'Puerto Rico', abbreviation: 'PR' },
  { state_id: 40, name: 'Rhode Island', abbreviation: 'RI' },
  { state_id: 41, name: 'South Carolina', abbreviation: 'SC' },
  { state_id: 42, name: 'South Dakota', abbreviation: 'SD' },
  { state_id: 43, name: 'Tennessee', abbreviation: 'TN' },
  { state_id: 44, name: 'Texas', abbreviation: 'TX' },
  { state_id: 45, name: 'Utah', abbreviation: 'UT' },
  { state_id: 46, name: 'Vermont', abbreviation: 'VT' },
  { state_id: 59, name: 'Virgin Islands', abbreviation: 'VI' },
  { state_id: 47, name: 'Virginia', abbreviation: 'VA' },
  { state_id: 48, name: 'Washington', abbreviation: 'WA' },
  { state_id: 49, name: 'West Virginia', abbreviation: 'WV' },
  { state_id: 50, name: 'Wisconsin', abbreviation: 'WI' },
  { state_id: 51, name: 'Wyoming', abbreviation: 'WY' }
];

const abbreviationToStateId = new Map(LYRIC_STATES.map((s) => [s.abbreviation.toUpperCase(), s.state_id]));
const nameToStateId = new Map(LYRIC_STATES.map((s) => [s.name.toUpperCase(), s.state_id]));

/**
 * Get Lyric state_id from member State (abbreviation like "TX" or full name like "Texas").
 * @param {string} state - State abbreviation (AL, TX) or full name
 * @returns {string} Lyric state_id as string, or empty string if not found
 */
function getLyricStateId(state) {
  if (!state || typeof state !== 'string') return '';
  const trimmed = state.trim().toUpperCase();
  if (!trimmed) return '';
  return String(abbreviationToStateId.get(trimmed) ?? nameToStateId.get(trimmed) ?? '');
}

module.exports = {
  LYRIC_STATES,
  getLyricStateId
};
