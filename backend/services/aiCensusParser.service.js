// backend/services/aiCensusParser.service.js
// AI service for parsing member census files (CSV/Excel)

const OpenAI = require('openai');
const XLSX = require('xlsx');
const { tokenLimitOption, buildChatCompletionOptions } = require('../utils/openaiChatOptions');

class AICensusParserService {
  constructor() {
    this._openai = null; // Lazy initialization
    this.model = 'gpt-4.1'; // Explicitly use GPT-4.1 for large file support (32k completion tokens, 1M context)
    this.maxRetries = 3;
  }

  // Lazy getter for OpenAI client
  get openai() {
    if (!this._openai) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable is not set. Please check your .env file.');
      }
      // Configure OpenAI client
      // Note: OpenAI SDK v4 uses fetch, timeout handling may be unreliable
      // We use Promise.race for timeout handling instead
      this._openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        maxRetries: 0, // Disable SDK retries - we handle timeouts manually
        baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      });
      
      console.log('✅ OpenAI client created');
    }
    return this._openai;
  }

  /**
   * Extract content from CSV/Excel file buffer
   * @param {Buffer} fileBuffer - File buffer
   * @param {string} filename - Original filename
   * @returns {Promise<string>} - Extracted text content
   */
  async extractFileContent(fileBuffer, filename) {
    try {
      const ext = filename.split('.').pop().toLowerCase();
      
      if (ext === 'csv') {
        // CSV files - read as text, but strip completely empty rows
        const raw = fileBuffer.toString('utf-8');
        const lines = raw.split(/\r?\n/);
        
        // Keep only rows where at least one cell has a non-empty value
        const nonEmptyLines = lines.filter((line) => {
          if (!line || !line.trim()) return false;
          // Quick split on comma; we're just trying to detect "all empty", not parse perfectly
          const cells = line.split(',');
          return cells.some((cell) => cell && cell.trim() !== '');
        });
        
        // Log row stats and a small preview for debugging
        console.log('📄 [CensusParser] CSV raw line count:', lines.length);
        console.log('📄 [CensusParser] CSV non-empty line count sent to AI:', nonEmptyLines.length);
        console.log('📄 [CensusParser] First 5 non-empty CSV lines to AI preview:', nonEmptyLines.slice(0, 5));
        
        return nonEmptyLines.join('\n');
      } else if (['xlsx', 'xls'].includes(ext)) {
        // Excel files - convert to text format
        // Use XLSX.read with buffer type for memory-based file buffer
        const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
        let text = '';
        let totalNonEmptyRowsAcrossSheets = 0;
        const previewLines = [];
        
        workbook.SheetNames.forEach(sheetName => {
          const sheet = workbook.Sheets[sheetName];
          // Convert sheet to JSON with header row (first row as headers)
          const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
          
          // 1) Drop completely empty rows
          const nonEmptyRows = jsonData.filter((row) =>
            Array.isArray(row) &&
            row.some((cell) => {
              if (cell === null || cell === undefined) return false;
              if (typeof cell === 'string') return cell.trim() !== '';
              return String(cell).trim() !== '';
            })
          );
          
          if (nonEmptyRows.length === 0) {
            return;
          }
          
          totalNonEmptyRowsAcrossSheets += nonEmptyRows.length;
          
          // 2) Drop columns that are completely empty across all rows
          const maxCols = nonEmptyRows.reduce((max, row) => Math.max(max, row.length || 0), 0);
          // Track indices of columns that have at least one non-empty value
          const nonEmptyColIndices = [];
          for (let col = 0; col < maxCols; col++) {
            const hasValue = nonEmptyRows.some((row) => {
              const cell = row[col];
              if (cell === null || cell === undefined) return false;
              if (typeof cell === 'string') return cell.trim() !== '';
              return String(cell).trim() !== '';
            });
            if (hasValue) {
              nonEmptyColIndices.push(col);
            }
          }
          
          text += `\n\n=== Sheet: ${sheetName} ===\n`;
          
          // Detect header rows: rows that look like metadata/headers
          // Metadata indicators: company info, contact info, etc.
          const metadataIndicators = [
            'company name', 'tax id', 'naics', 'effective date', 'address', 
            'tier', 'employee status', 'waived', 'contact name', 'phone number', 
            'pay frequency', 'city/state/zip', 'city/state', 'contact', 'phone'
          ];
          // Column header indicators: rows that contain typical column header words
          // IMPORTANT: A true column header row will have MULTIPLE of these indicators, not just one
          const columnHeaderIndicators = ['first name', 'last name', 'number', 'dob', 'date of birth', 'gender', 'relationship', 'email', 'phone', 'zip', 'tobacco', 'cobra', 'salary', 'title'];
          let dataStartIndex = 0;
          let columnHeaderFound = false;
          
          // Strategy: Find the column header row first, then data starts right after it
          // Skip everything before the column header (all metadata)
          // A true column header will have MULTIPLE column header indicators (e.g., "First Name", "Last Name", "DOB", etc.)
          for (let i = 0; i < Math.min(20, nonEmptyRows.length); i++) {
            const row = nonEmptyRows[i];
            const rowText = row.slice(0, 15).map(c => String(c || '').toLowerCase()).join(' ');
            
            // Count how many column header indicators this row contains
            const indicatorCount = columnHeaderIndicators.filter(indicator => rowText.includes(indicator)).length;
            
            // A true column header row should have at least 3-4 column header indicators
            // This prevents matching metadata rows that happen to contain one indicator (like "City/State/Zip" containing "zip")
            const isColumnHeader = indicatorCount >= 3;
            
            if (isColumnHeader) {
              // Found the column header - data starts on the next row
              dataStartIndex = i + 1;
              columnHeaderFound = true;
              console.log(`📄 [CensusParser] Found column header row at index ${i} (contains ${indicatorCount} header indicators: ${row.slice(0, 5).join(', ')}), data starts at index ${dataStartIndex}`);
              break;
            }
          }
          
          // If no column header found, look for first data row (has numeric ID + name pattern)
          if (!columnHeaderFound) {
            for (let i = 0; i < Math.min(20, nonEmptyRows.length); i++) {
              const row = nonEmptyRows[i];
              const rowText = row.slice(0, 10).map(c => String(c || '').toLowerCase()).join(' ');
              
              // Skip metadata rows
              const isMetadata = metadataIndicators.some(indicator => rowText.includes(indicator));
              if (isMetadata) continue;
              
              // Check if this looks like a data row: first cell is a number, second/third are names
              const firstCell = String(row[0] || '').trim();
              const secondCell = String(row[1] || '').trim();
              const thirdCell = String(row[2] || '').trim();
              
              // Data row pattern: number in first column, capitalized name in second/third
              const hasNumericId = /^\d+$/.test(firstCell);
              const hasNamePattern = (secondCell && /^[A-Z]/.test(secondCell)) || (thirdCell && /^[A-Z]/.test(thirdCell));
              
              if (hasNumericId && hasNamePattern) {
                dataStartIndex = i;
                console.log(`📄 [CensusParser] Found data row at index ${i} (no column header detected, pattern: ${firstCell}, ${secondCell}, ${thirdCell})`);
                break;
              }
            }
          }
          
          const dataRows = nonEmptyRows.slice(dataStartIndex);
          console.log(`📄 [CensusParser] Sheet "${sheetName}": Skipped ${dataStartIndex} header rows (including column header), ${dataRows.length} data rows to process`);
          
          // 3) Convert to tab-separated format for AI (preserve only non-empty columns)
          // Add row numbers to help AI track progress
          // IMPORTANT: All rows here are DATA ROWS - the column header has already been skipped
          dataRows.forEach((row, relativeIndex) => {
            const absoluteRowIndex = dataStartIndex + relativeIndex;
            const rowValues = nonEmptyColIndices.map((colIndex) => {
              const cell = row[colIndex];
              if (cell === null || cell === undefined) return '';
              if (typeof cell === 'object' && cell instanceof Date) {
                return cell.toISOString().split('T')[0]; // Format dates as YYYY-MM-DD
              }
              return String(cell);
            });
            // Prefix with row number for tracking: "ROW_N: data..."
            text += `ROW_${absoluteRowIndex}: ${rowValues.join('\t')}\n`;
            
            // Capture a small preview sample (up to 5 rows across all sheets)
            if (previewLines.length < 5) {
              previewLines.push({
                sheet: sheetName,
                rowIndex: absoluteRowIndex,
                raw: row,
                tsv: rowValues.join('\t')
              });
            }
          });
        });
        
        console.log('📄 [CensusParser] Excel total non-empty row count sent to AI:', totalNonEmptyRowsAcrossSheets);
        console.log('📄 [CensusParser] Excel preview of first 5 non-empty rows to AI:', previewLines);
        
        return text;
      } else {
        throw new Error(`Unsupported file format: ${ext}`);
      }
    } catch (error) {
      console.error('Error extracting file content:', error);
      throw new Error(`Failed to extract file content: ${error.message}`);
    }
  }

  /**
   * Get system prompt for AI census parsing
   * @returns {string} - System prompt
   */
  getSystemPrompt() {
    return `You are an expert at parsing member census data from CSV and Excel files.

Your task is to analyze the provided census file and extract member information, organizing it into households.

CRITICAL RULES:
1. Extract ONLY the information that is explicitly provided in the file
2. DO NOT invent or generate data that is not in the file
3. MINIMUM REQUIRED fields: firstName AND lastName (BOTH required for ALL members)
   - If a row has BOTH firstName AND lastName, include it as a member
   - If a row only has firstName OR lastName (not both), still include it - user can fill in the missing name
   - If a row has NEITHER firstName NOR lastName, DO NOT create a household or member for it - skip that row
4. PRIMARY members: MUST have BOTH firstName AND lastName. Email is preferred but optional (user can add later).
   - CRITICAL: DO NOT create a household if the primary member does not have BOTH firstName AND lastName.
   - If you cannot find a row with BOTH firstName AND lastName to be the primary member, DO NOT create that household.
5. DEPENDENTS: MUST have BOTH firstName AND lastName.
   - Email is OPTIONAL for spouses (relationshipType: "S") - if not provided, leave empty (system will generate default)
   - Email is NOT needed for children (relationshipType: "C") - do not include email field for children
6. Child/children dependents (relationshipType: "C") should NEVER have an email address field - omit it completely
7. All other fields (dateOfBirth, gender, hireDate, etc.) are OPTIONAL - leave them empty/null if not provided
   - DO NOT generate warnings about missing optional fields
   - Hire date, DOB, gender are all optional - the system will handle defaults
8. Use EXACT wording from the source file - do not paraphrase
9. DO NOT make assumptions about missing data
10. IMPORTANT: Primary member vs dependent (relationshipType) DOES matter - get this right
11. CRITICAL: DO NOT create households with empty or invalid primary members. Every household MUST have a primary member with BOTH firstName AND lastName. If a row only has firstName OR lastName (not both), you can still include it, but DO NOT create a household for a row that has NEITHER firstName NOR lastName. If you cannot identify a valid primary member for a household (with at least firstName OR lastName), DO NOT create that household - skip those rows entirely.

HOUSEHOLD DETECTION:
Detect household relationships using these methods (in order of priority, but not limited to these examples):
1. Relationship indicators in the data (but not limited to):
   - "Child", "Spouse", "Wife", "Husband", "Dependent", "Son", "Daughter" = Dependent
   - "Employee", "Member", "Primary", "Subscriber", "EE" = Primary member
   - Look for relationship columns: "Relationship", "RelationshipType", "MemberType", "Type" (but not limited to)

2. Tier codes (but not limited to):
   - "EE", "Employee", "Employee Only", "Individual", "Member Only" = Primary member (relationshipType: "P")
   - "ES", "Employee+Spouse", "Spouse" = Spouse (relationshipType: "S")
   - "EC", "Employee+Child", "Child", "Children" = Child (relationshipType: "C")
   - "EF", "Employee+Family", "Family" = Can be either Spouse or Child (use context)

3. Last name matching:
   - Members with the same last name are likely in the same household
   - Primary member typically has the household's last name
   - Dependents share the primary member's last name

4. Row order:
   - Primary member is typically listed FIRST in a household
   - Dependents follow the primary member immediately after
   - New primary member starts a new household

5. Special case: two EE/Employee adults in the same family:
   - If you see TWO adults with tier/relationship "EE" or "Employee", same last name, and listed together (same household indicators like address, location, etc.),
     treat them as a SINGLE household:
       * Both are likely in the same family (spouses who are both employees)
       * When choosing which one is the primary member (relationshipType: "P"), use this priority:
         1. Row order (first listed is typically primary)
         2. Explicit relationship/tier indicators in the data
         3. If gender is available and both are clearly employees, male is a good default choice for primary
         4. Other context clues from the data
       * Treat the other adult as a dependent spouse (relationshipType: "S")
       * Children associated with that family should be dependents (relationshipType: "C") in the same household
   - IMPORTANT: While male is a good default when both are employees, females CAN be primary members if the data indicates it (e.g., she's listed first, has stronger indicators, or explicit relationship fields show her as primary).

6. Address matching:
   - Members with the same address are likely in the same household
   - Use this as a secondary indicator

HOUSEHOLD STRUCTURE:
- Each household must have exactly ONE primary member (relationshipType: "P")
- CRITICAL: The primary member MUST have BOTH firstName AND lastName. If a row does not have both names, it CANNOT be a primary member.
- CRITICAL: Before creating a household, verify that the primary member row has BOTH firstName AND lastName. If not, DO NOT create the household - skip those rows.
- Dependents (relationshipType: "S" or "C") belong to the primary member's household
- Primary members are typically identified by tier "EE" or relationship indicators like "Employee", "Primary", "Subscriber"
- IMPORTANT: Do NOT generate warnings about "lacks a primary member before him/her" unless you are absolutely certain. Often, the primary member IS present (may be listed before, or may be a female primary member). Only flag this if you have thoroughly checked the entire file and confirmed there is truly no primary member for that household.
- CRITICAL: If you see dependents (spouses, children) but cannot find a valid primary member (with BOTH firstName AND lastName) for that household, DO NOT create the household. Skip those rows entirely.

LOCATION MATCHING:
- Match work location names from the file to the provided group locations
- Use case-insensitive matching when possible
- If location matches exactly (case-insensitive), return locationId
- If location matches but case is different, return locationId
- If location partially matches, return locationName (exact name from the locations list provided, NOT "Primary Location-")
- If no match found, return locationName as the EXACT value from the file (frontend will handle)
- Always prioritize exact matches over partial matches
- IMPORTANT: When returning locationName, use the EXACT location name from the file, not a generic placeholder like "Primary Location-"
- If the file has a location name, return that exact name in locationName field

FIELD MAPPING:
The file may have ANY column names or field titles. You must interpret them intuitively based on their meaning, not just match exact strings. The examples below are ONLY examples - use your intelligence to map ANY field names you encounter.

CRITICAL: Do not limit yourself to the examples below. If you see a column header that clearly represents a concept (e.g., name, email, date, location), map it appropriately even if it's not in the examples. Use semantic understanding, not just string matching.

Examples of common mappings (but you should map ANY similar fields you encounter):
- Name fields: "Name", "Full Name", "Member Name", "Employee Name", "Participant Name", "Insured Name", "Subscriber Name", or ANY field containing name-related words → split into firstName and lastName
- Email: "Email", "Email Address", "E-Mail", "EmailAddr", "E-mail", "Email_Address", or ANY field containing "email" or "mail" → email
- Phone: "Phone", "Phone Number", "Telephone", "Cell", "Mobile", "Phone #", "Contact Number", or ANY field containing "phone", "tel", "mobile", "cell" → phoneNumber
- Date of Birth: "DoB", "Date of Birth", "Birth Date", "Birthdate", "DOB", "Birthday", "Date of Birth (MM/DD/YYYY)", or ANY field containing "birth", "dob", "born" → dateOfBirth (format: YYYY-MM-DD)
- Gender: "Gender", "Sex", "M/F", "Male/Female", or ANY field indicating gender/sex → gender (standardize to "Male" or "Female")
- Address: "Address", "Address1", "Street", "Street Address", "Home Address", "Mailing Address", or ANY field containing "address", "street", "addr" → address
- City: "City", "City Name", "Municipality", or ANY field containing "city" → city
- State: "State", "State Code", "Province", "ST", or ANY field containing "state" → state (2-letter code, uppercase)
- Zip: "Zip", "Zipcode", "Zip Code", "Postal Code", "PostalCode", "ZIP", or ANY field containing "zip", "postal" → zip
- Hire Date: "Hire Date", "Hired", "Start Date", "Employment Date", "Date Hired", "Hire Date (MM/DD/YYYY)", or ANY field containing "hire", "start", "employment" → hireDate (format: YYYY-MM-DD)
- Work Location: "Work Location", "Location", "Office", "Branch", "Site", "Workplace", "Work Site", or ANY field containing "location", "office", "branch", "site", "workplace" → workLocation
- Tier: "Tier", "Coverage Tier", "Plan Tier", "Type", "Coverage Type", "Plan Type", "Member Type", "Employee Status", or ANY field indicating coverage/member type → tier (EE, ES, EC, EF)
- Tobacco Use: "Tobacco", "Tobacco Use", "Smoker", "TobaccoStatus", "Smoking Status", or ANY field containing "tobacco", "smoke", "smoker" → tobaccoUse (Y, N, U)
- Relationship: "Relationship", "RelationshipType", "MemberType", "Type", "Relation", "Relationship to Subscriber", or ANY field indicating relationship → use to determine relationshipType (P, S, C)
- Job Position: "Job Position", "Position", "Job Title", "Title", "Role", "Job Role", "Employee Position", "Employee Title", "Job", or ANY field containing "position", "title", "role", "job" → jobPosition (map to ID format: see JOB POSITION MAPPING below)

DATE FORMATS:
- Accept various date formats: YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, Excel serial numbers (e.g., 33953), etc. (but not limited to)
- Convert ALL dates to YYYY-MM-DD format before returning
- FIX OBVIOUS DATE TYPOS: If you see a date that is clearly a typo (e.g., "12/152021" missing a slash), fix it intelligently:
  * "12/152021" → "2021-12-15" (assume MM/DD/YYYY format, add missing slash)
  * "1/152021" → "2021-01-15"
  * "12/15202" → "2002-12-15" (if year is clearly truncated)
- CONVERT EXCEL SERIAL NUMBERS: If you see numeric values like 33953, 44994, etc., these are likely Excel serial date numbers:
  * Excel serial numbers represent days since January 1, 1900
  * Convert them to YYYY-MM-DD format (e.g., 33953 → calculate the actual date)
  * If you cannot confidently convert an Excel serial number, leave it empty and add a warning with the original value
- Use context clues (other dates in file, reasonable age ranges) to determine the correct interpretation
- If the date appears malformed but you can confidently interpret it, fix it and include the original in warnings
- If the date is truly ambiguous or unparseable even after attempting fixes, leave it empty and add a warning
- CRITICAL: If a date field appears in the file but is malformed, DO NOT silently drop it. Either fix it (if confident) or leave it empty with a warning. Do not generate false dates.
- CRITICAL: ALL dates in your response MUST be in YYYY-MM-DD format. Do not return dates in any other format.
- If you fix a date, include the original value in the warning message for transparency

GENDER STANDARDIZATION:
- Standardize to "Male" or "Female"
- Accept: "M", "F", "Male", "Female", "MALE", "FEMALE"
- Convert: "M" → "Male", "F" → "Female"

TOBACCO USE STANDARDIZATION:
- Standardize to "Y", "N", or "U"
- Accept: "Yes", "No", "Unknown", "Y", "N", "U", "YES", "NO"
- Convert: "Yes"/"YES" → "Y", "No"/"NO" → "N", "Unknown" → "U"

TIER STANDARDIZATION:
- Standardize to "EE", "ES", "EC", or "EF"
- Accept various formats: "Employee Only", "Employee+Spouse", "Individual", "Member Only" → "EE"
- Accept: "Employee+Spouse", "Spouse" → "ES"
- Accept: "Employee+Child", "Child" → "EC"
- Accept: "Employee+Family", "Family" → "EF"

JOB POSITION MAPPING:
- Map job position labels to standardized IDs (case-insensitive matching):
  * "C-Level", "C Level", "C-Level Executive", "C-Suite", "C-Suite Executive" → "c_level"
  * "Executive", "Exec", "Executive Level" → "executive"
  * "President", "Pres" → "president"
  * "Vice President", "VP", "Vice Pres", "V.P." → "vice_president"
  * "Director", "Dir" → "director"
  * "Manager", "Mgr", "Management" → "manager"
  * "Supervisor", "Supv", "Supervisory" → "supervisor"
  * "Team Lead", "Team Leader", "Lead", "TL" → "team_lead"
  * "Employee", "Staff", "Worker" → "employee"
  * "Hourly", "Hourly Employee", "Hourly Worker" → "hourly"
- If the job position in the file doesn't match any of the above, use the closest match or leave empty
- Use semantic understanding: if you see "Senior Manager", map to "manager"; "Assistant Director" → "director", etc.
- Return the ID (e.g., "manager") not the label (e.g., "Manager")

OUTPUT FORMAT:
Return a JSON object with this exact structure:
{
  "processingNotes": "Optional: Explain if you stopped early, why you skipped rows, or any processing decisions. If you processed all rows, you can omit this field.",
  "households": [
    {
      "primaryMember": {
        "firstName": "string (required)",
        "lastName": "string (required)",
        "email": "string (required for primary member)",
        "phoneNumber": "string (optional)",
        "dateOfBirth": "string (optional, YYYY-MM-DD)",
        "gender": "string (optional, Male/Female)",
        "address": "string (optional)",
        "city": "string (optional)",
        "state": "string (optional, 2-letter code)",
        "zip": "string (optional)",
        "hireDate": "string (optional, YYYY-MM-DD)",
        "workLocation": "string (optional)",
        "tier": "string (optional, EE/ES/EC/EF)",
        "tobaccoUse": "string (optional, Y/N/U)",
        "jobPosition": "string (optional, one of: c_level, executive, president, vice_president, director, manager, supervisor, team_lead, employee, hourly)",
        "relationshipType": "P",
        "locationId": "string (optional, if location matched)",
        "locationName": "string (optional, if location not matched but name provided)"
      },
      "dependents": [
        {
          "firstName": "string (required)",
          "lastName": "string (required)",
          "email": "string (OPTIONAL for spouses/S - leave empty if not in file, OMIT for children/C)",
          "phoneNumber": "string (optional)",
          "dateOfBirth": "string (optional, YYYY-MM-DD)",
          "gender": "string (optional, Male/Female)",
          "address": "string (optional)",
          "city": "string (optional)",
          "state": "string (optional, 2-letter code)",
          "zip": "string (optional)",
          "hireDate": "string (optional, YYYY-MM-DD)",
          "workLocation": "string (optional)",
          "tier": "string (optional, EE/ES/EC/EF)",
          "tobaccoUse": "string (optional, Y/N/U)",
          "jobPosition": "string (optional, one of: c_level, executive, president, vice_president, director, manager, supervisor, team_lead, employee, hourly)",
          "relationshipType": "string (S for Spouse, C for Child)",
          "locationId": "string (optional, if location matched)",
          "locationName": "string (optional, if location not matched but name provided)"
        }
      ]
    }
  ],
  "warnings": [
    "string (array of warnings about parsing issues)"
  ],
  "statistics": {
    "totalMembers": "number",
    "households": "number",
    "primaryMembers": "number",
    "dependents": "number"
  }
}

VALIDATION RULES:
1. Every PRIMARY member MUST have firstName and lastName (email is preferred but optional - user can add it)
2. Every DEPENDENT MUST have firstName and lastName
3. Email is OPTIONAL for spouses (relationshipType: "S") - if not in file, leave empty (system will generate default)
4. Email MUST be OMITTED for children (relationshipType: "C")
5. Every household MUST have exactly one primary member
6. Email addresses that are present must be valid format
7. Dates must be in YYYY-MM-DD format (or empty if unparseable)
8. States must be 2-letter codes
9. RelationshipType must be "P", "S", or "C"
10. Hire date, dateOfBirth, gender are all OPTIONAL - do not warn about missing values

ERROR HANDLING:
- For ANY row that has at least firstName OR lastName, you MUST include that member in the output.
- If a row only has firstName OR lastName (not both), still include it - the user can fill in the missing name.
- If a row has NEITHER firstName NOR lastName, skip it entirely - do not create a household or member for it.
- DO NOT skip rows just because they're missing optional fields like email, hireDate, dateOfBirth, gender, etc.
- Only skip a row entirely if it is clearly a header, separator, completely empty, OR has no name fields at all.
- CRITICAL: Every household you create MUST have a valid primary member with BOTH firstName AND lastName. If you cannot find a valid primary member (with both names) for a household, DO NOT create that household - skip those rows entirely.
- CRITICAL: DO NOT create households where the primary member is missing firstName OR lastName. These households will be rejected and cause data loss.
- CRITICAL: Before creating a household, verify that the primary member has BOTH firstName AND lastName. If not, do not create the household.
- DO NOT generate warnings about missing optional fields (hireDate, dateOfBirth, gender, etc.) - these are handled by the system.
- Email is OPTIONAL for spouses (relationshipType: "S") - if not in file, leave empty (system will generate default)
- Email MUST be OMITTED for children (relationshipType: "C") - do not include email field for children at all
- If a dependent appears before a primary member, mark in warnings ONLY if you are certain there is no primary member for that household. Often, the primary member may be listed elsewhere or may be a female primary member that you initially missed.
- If location cannot be matched, return locationName from file (frontend will handle).
- If date format is invalid, leave it empty (do not warn - it's optional).
- If any source field clearly labels a member as "Child", "Spouse", "Wife", "Husband", "Dependent", "Son", or "Daughter",
  you MUST NOT mark that member as a primary (relationshipType "P"). They must remain a dependent ("S" or "C").
- If you detect a serious contradiction between the source data and the inferred household structure
  (for example, a row clearly labeled as "Child" would have to be treated as a primary member to make the structure work),
  DO NOT invent or change the relationship to fix it. Instead:
    * Skip that row OR keep it as a dependent,
    * Add a warning starting with "FLAG_ERROR:" describing the issue in detail.

WARNING CONCISENESS (CRITICAL FOR TOKEN LIMITS):
- Keep warnings EXTREMELY brief and concise - only include truly critical issues
- DO NOT generate warnings for normal data interpretation (e.g., "Gender 'Female' interpreted as 'Female'" is unnecessary)
- DO NOT generate warnings for successful conversions (e.g., "Excel date 33953 converted to 1992-08-01" is unnecessary)
- Only include warnings for:
  * Actual errors that prevent parsing (missing required names, invalid structure)
  * Rows that were skipped and why (briefly)
  * Serious data contradictions (FLAG_ERROR only)
- Maximum 1-2 sentences per warning
- If you processed all rows successfully, the warnings array can be empty or very short
- Focus on the JSON data, not verbose explanations

Respond ONLY with the JSON object, no additional text or explanations.`;
  }

  /**
   * Split file content into chunks for processing
   * @param {string} fileContent - Full file content with ROW_N: prefixes
   * @param {number} maxChunkSize - Maximum characters per chunk
   * @returns {Array<{content: string, startRow: number, endRow: number}>} - Array of chunks
   */
  splitIntoChunks(fileContent, maxChunkSize = 250000) {
    const chunks = [];
    const lines = fileContent.split('\n');
    let currentChunk = [];
    let currentSize = 0;
    let startRow = null;
    let endRow = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineSize = line.length + 1; // +1 for newline

      // If adding this line would exceed the chunk size, save current chunk
      if (currentSize + lineSize > maxChunkSize && currentChunk.length > 0) {
        // Extract row numbers from chunk
        const firstRowMatch = currentChunk[0]?.match(/ROW_(\d+):/);
        const lastRowMatch = currentChunk[currentChunk.length - 1]?.match(/ROW_(\d+):/);
        startRow = firstRowMatch ? parseInt(firstRowMatch[1], 10) : null;
        endRow = lastRowMatch ? parseInt(lastRowMatch[1], 10) : null;

        chunks.push({
          content: currentChunk.join('\n'),
          startRow,
          endRow
        });

        // Start new chunk with this line
        currentChunk = [line];
        currentSize = lineSize;
      } else {
        currentChunk.push(line);
        currentSize += lineSize;
      }
    }

    // Add the last chunk
    if (currentChunk.length > 0) {
      const firstRowMatch = currentChunk[0]?.match(/ROW_(\d+):/);
      const lastRowMatch = currentChunk[currentChunk.length - 1]?.match(/ROW_(\d+):/);
      startRow = firstRowMatch ? parseInt(firstRowMatch[1], 10) : null;
      endRow = lastRowMatch ? parseInt(lastRowMatch[1], 10) : null;

      chunks.push({
        content: currentChunk.join('\n'),
        startRow,
        endRow
      });
    }

    return chunks;
  }

  /**
   * Merge multiple parsed results into a single result
   * @param {Array<Object>} results - Array of parse results from chunks
   * @returns {Object} - Merged result
   */
  mergeParseResults(results) {
    const merged = {
      households: [],
      warnings: [],
      statistics: {
        totalMembers: 0,
        households: 0,
        primaryMembers: 0,
        dependents: 0
      }
    };

    for (const result of results) {
      if (result.households && Array.isArray(result.households)) {
        merged.households.push(...result.households);
      }
      if (result.warnings && Array.isArray(result.warnings)) {
        merged.warnings.push(...result.warnings);
      }
    }

    // Recalculate statistics
    merged.statistics.households = merged.households.length;
    merged.statistics.primaryMembers = merged.households.length;
    merged.statistics.dependents = merged.households.reduce((sum, h) => sum + (h.dependents?.length || 0), 0);
    merged.statistics.totalMembers = merged.statistics.primaryMembers + merged.statistics.dependents;

    return merged;
  }

  /**
   * Parse census file with AI (with chunking support)
   * @param {string} fileContent - Extracted file content
   * @param {Array} groupLocations - Array of group locations with LocationId, Name, City, State, IsPrimary
   * @returns {Promise<Object>} - Parsed households data
   */
  async parseCensusFile(fileContent, groupLocations = []) {
    try {
      console.log('🤖 Starting AI census parsing...');
      console.log(`📊 File content length: ${fileContent.length} characters`);
      console.log(`📍 Group locations: ${groupLocations.length} locations`);
      
      // Verify OpenAI client is initialized
      let openaiClient;
      try {
        openaiClient = this.openai;
        console.log('✅ OpenAI client initialized');
        
        // Check API key format without exposing the key
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error('OPENAI_API_KEY environment variable is not set');
        }
        
        console.log(`🔑 OpenAI API key exists: Yes (length: ${apiKey.length})`);
        console.log(`🔑 API key format: ${apiKey.substring(0, 7)}...${apiKey.substring(apiKey.length - 4)}`);
        
        // Check if API key is valid format (starts with sk-)
        if (!apiKey.startsWith('sk-')) {
          console.warn('⚠️ Warning: OpenAI API key does not start with "sk-". This may indicate an invalid key format.');
        }
        
        console.log(`🤖 Using model: ${this.model} (hardcoded - not using environment variable)`);
      } catch (clientError) {
        console.error('❌ Failed to initialize OpenAI client:', clientError.message);
        console.error('❌ Client error stack:', clientError.stack);
        throw new Error(`OpenAI client initialization failed: ${clientError.message}`);
      }
      
      // Skip connectivity test for now - it adds delay and the main call will fail fast if there's an issue
      console.log('✅ Ready to make API call');

      // Format locations for AI prompt - only include what the AI needs for matching
      const locationsInfo = groupLocations.map(loc => ({
        locationId: loc.LocationId,
        name: loc.Name || 'Unnamed Location'
      }));

      // Determine if we need to chunk the file
      // GPT-4.1 has 1M token context window, but we want to leave room for:
      // - System prompt (~17k chars = ~4k tokens)
      // - User message wrapper (~5k chars = ~1k tokens)
      // - Response (up to 32k tokens = ~128k chars)
      // So we can safely use ~250k characters per chunk (~62k tokens)
      const MAX_CHUNK_SIZE = 250000; // ~250k characters per chunk
      const needsChunking = fileContent.length > MAX_CHUNK_SIZE;
      
      if (needsChunking) {
        console.log(`📦 File is large (${fileContent.length} chars), splitting into chunks...`);
        const chunks = this.splitIntoChunks(fileContent, MAX_CHUNK_SIZE);
        console.log(`📦 Split into ${chunks.length} chunks`);
        
        // Parse each chunk and merge results
        const chunkResults = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          console.log(`📦 Processing chunk ${i + 1}/${chunks.length} (rows ${chunk.startRow || '?'} to ${chunk.endRow || '?'})...`);
          
          try {
            const chunkResult = await this.parseCensusFileChunk(chunk.content, groupLocations, i + 1, chunks.length);
            if (chunkResult.success) {
              chunkResults.push(chunkResult.data);
            } else {
              console.error(`❌ Chunk ${i + 1} failed: ${chunkResult.error}`);
              throw new Error(`Failed to parse chunk ${i + 1}/${chunks.length}: ${chunkResult.error}`);
            }
          } catch (chunkError) {
            console.error(`❌ Error parsing chunk ${i + 1}:`, chunkError);
            throw new Error(`Failed to parse chunk ${i + 1}/${chunks.length}: ${chunkError.message}`);
          }
        }
        
        // Merge all chunk results
        console.log(`📦 Merging ${chunkResults.length} chunk results...`);
        const mergedResult = this.mergeParseResults(chunkResults);
        
        return {
          success: true,
          data: mergedResult
        };
      } else {
        console.log(`✅ File content size (${fileContent.length} chars) is within limits - will parse entire file`);
        // Parse as single chunk, but catch context limit errors and retry with chunking
        try {
          return await this.parseCensusFileChunk(fileContent, groupLocations, 1, 1);
        } catch (chunkError) {
          // If we hit a context limit error, automatically chunk and retry
          if (chunkError.message === 'CONTEXT_LIMIT_EXCEEDED') {
            console.log(`⚠️ Context limit hit - automatically chunking file and retrying...`);
            const chunks = this.splitIntoChunks(fileContent, MAX_CHUNK_SIZE);
            console.log(`📦 Split into ${chunks.length} chunks`);
            
            // Parse each chunk and merge results
            const chunkResults = [];
            for (let i = 0; i < chunks.length; i++) {
              const chunk = chunks[i];
              console.log(`📦 Processing chunk ${i + 1}/${chunks.length} (rows ${chunk.startRow || '?'} to ${chunk.endRow || '?'})...`);
              
              try {
                const chunkResult = await this.parseCensusFileChunk(chunk.content, groupLocations, i + 1, chunks.length);
                if (chunkResult.success) {
                  chunkResults.push(chunkResult.data);
                } else {
                  console.error(`❌ Chunk ${i + 1} failed: ${chunkResult.error}`);
                  throw new Error(`Failed to parse chunk ${i + 1}/${chunks.length}: ${chunkResult.error}`);
                }
              } catch (chunkError2) {
                console.error(`❌ Error parsing chunk ${i + 1}:`, chunkError2);
                throw new Error(`Failed to parse chunk ${i + 1}/${chunks.length}: ${chunkError2.message}`);
              }
            }
            
            // Merge all chunk results
            console.log(`📦 Merging ${chunkResults.length} chunk results...`);
            const mergedResult = this.mergeParseResults(chunkResults);
            
            return {
              success: true,
              data: mergedResult
            };
          }
          // Re-throw if it's not a context limit error
          throw chunkError;
        }
      }
    } catch (error) {
      console.error('❌ Error parsing census file with AI:', error);
      console.error('❌ Error stack:', error.stack);
      console.error('❌ Error name:', error.name);
      console.error('❌ Error code:', error.code);
      
      // Check for specific error types
      if (error.message && error.message.includes('timeout')) {
        return {
          success: false,
          error: 'AI parsing timed out. The file may be too large or complex. Please try the Standard Import option or split the file into smaller chunks.'
        };
      }
      
      if (error.message && error.message.includes('API key')) {
        return {
          success: false,
          error: 'OpenAI API key is not configured. Please contact support.'
        };
      }
      
      if (error.response) {
        console.error('❌ OpenAI API error response:', error.response.status, error.response.data);
        return {
          success: false,
          error: `OpenAI API error: ${error.response.status} - ${error.response.data?.error?.message || error.message}`
        };
      }
      
      return {
        success: false,
        error: error.message || 'Failed to parse census file with AI. Please try the Standard Import option.'
      };
    }
  }

  /**
   * Parse a single chunk of census file with AI
   * @param {string} chunkContent - Chunk content to parse
   * @param {Array} groupLocations - Array of group locations
   * @param {number} chunkNumber - Current chunk number (1-based)
   * @param {number} totalChunks - Total number of chunks
   * @returns {Promise<Object>} - Parsed households data
   */
  async parseCensusFileChunk(chunkContent, groupLocations = [], chunkNumber = 1, totalChunks = 1) {
    try {
      // Format locations for AI prompt - only include what the AI needs for matching
      const locationsInfo = groupLocations.map(loc => ({
        locationId: loc.LocationId,
        name: loc.Name || 'Unnamed Location'
      }));

      // Count rows in this chunk
      const rowCountInChunk = (chunkContent?.match(/ROW_(\d+):/g) || []).length;
      
      // Log what we're actually sending to help debug
      const firstFewRows = chunkContent?.split('\n').slice(0, 5).join('\n') || '';
      console.log(`📄 [CensusParser] Chunk ${chunkNumber}/${totalChunks}: First 5 lines being sent to AI:\n${firstFewRows.substring(0, 500)}`);
      
      const chunkContext = totalChunks > 1 
        ? `\n\nCHUNK CONTEXT: This is chunk ${chunkNumber} of ${totalChunks}. Parse ONLY the rows in this chunk. Each chunk will be merged later.`
        : '';
      
      const userMessage = `Parse the following member census file and extract member information into households.${chunkContext}

GROUP LOCATIONS (for matching work locations):
${JSON.stringify(locationsInfo, null, 2)}

CENSUS FILE CONTENT:
${chunkContent}

CRITICAL CONTEXT:
- The column header row (containing "First Name", "Last Name", "DOB", etc.) has ALREADY been identified and removed by the system
- ALL rows you see with ROW_N: prefixes are MEMBER DATA ROWS, not header rows
- Do NOT treat any rows as headers - they have all been filtered out before sending to you
- Every row contains actual member information that should be parsed

IMPORTANT INSTRUCTIONS:
1. Extract ALL members from the file - do not skip rows unless they are clearly headers, footers, or completely empty
2. Rows are prefixed with "ROW_N:" where N is the row number - use this to track your progress
3. Process EVERY row that contains member data (names, emails, etc.) - do not stop early
4. CRITICAL: You are seeing ${rowCountInChunk || 0} data rows in this chunk. You MUST process ALL of them, not just the first few.
5. CRITICAL: You are seeing ${rowCountInChunk || 0} data rows in this chunk. You MUST return a member for EVERY row that has at least a first name OR last name. If you return significantly fewer members than rows, you have FAILED. You must process at least 80% of the rows (${Math.floor((rowCountInChunk || 0) * 0.8)}+ members expected).
6. CRITICAL: Do NOT stop processing after a few households. Continue through ALL rows until you reach the end.
7. CRITICAL: Look at the ROW_N numbers - if the last row is ROW_170, you must process from ROW_10 (or first data row) all the way to ROW_170. Do not stop at ROW_50 or ROW_100.
8. Organize them into households (one primary member per household)
9. Match work locations to the provided group locations (use locationId if exact match, locationName if partial match)
10. Return the JSON structure as specified in the system prompt
11. Include warnings for any parsing issues
12. Calculate statistics (totalMembers, households, primaryMembers, dependents) - these MUST match the actual number of members in the households array
13. CRITICAL: The statistics you report MUST exactly match the number of members actually included in the households array. Count each primary member once and each dependent once.
14. CRITICAL: Process rows sequentially from ROW_10 to ROW_170 (or whatever the last row number is). Do not skip any rows in between.
15. CRITICAL: Your response must include ALL members. If your JSON response is getting too large, that's expected - include all members anyway. The system can handle large responses.

DEBUGGING HELP:
- The column header row (containing "First Name", "Last Name", "DOB", etc.) has already been identified and skipped by the system
- Rows sent to you starting with ROW_N: are DATA ROWS, not header rows
- DO NOT skip rows just because they have column-like structure - if a row contains actual member data (names, emails, dates), it is a DATA ROW
- Only skip rows that are clearly:
  * Empty or contain only whitespace
  * Footer rows (totals, summaries at the end)
  * Duplicate column headers if they appear mid-file
- If you see a row with "First Name", "Last Name" as VALUES (not column headers), that is member data, not a header
- IMPORTANT: Rows with actual member information (names like "John", "Smith", emails, dates of birth, etc.) are DATA ROWS, not headers
- If you're skipping rows, explain briefly in warnings (e.g., "ROW_15: Empty row")
- Keep skipped row explanations to 1-2 words per row
- Count the rows you process and report if you're stopping early
- If you process fewer than 80% of the rows sent, explain briefly why in processingNotes (1 sentence max)
- CRITICAL: If you decide to stop processing rows before reaching the end, explain briefly in "processingNotes" (1 sentence)
- CRITICAL: If you skip any rows, list them briefly in "processingNotes" (e.g., "Skipped ROW_15, ROW_20: empty")
- CRITICAL: Keep all warnings and processingNotes EXTREMELY concise to avoid hitting token limits
- CRITICAL: Focus on returning complete JSON data, not verbose explanations`;

      console.log('📤 Preparing OpenAI API request...');
      console.log(`📊 User message length: ${userMessage.length} characters`);
      console.log(`📊 System prompt length: ${this.getSystemPrompt().length} characters`);
      console.log(`📊 Total message length: ${userMessage.length + this.getSystemPrompt().length} characters`);
      
      // Calculate approximate token count (rough estimate: 1 token ≈ 4 characters)
      const approximateTokens = Math.ceil((userMessage.length + this.getSystemPrompt().length) / 4);
      console.log(`📊 Approximate token count: ${approximateTokens} tokens`);
      
      // Warn if token count is high
      if (approximateTokens > 30000) {
        console.warn(`⚠️ Warning: Token count (${approximateTokens}) is high. Response may be slow or timeout.`);
      }
      
      console.log(`🤖 Using model: ${this.model} (hardcoded - not using environment variable)`);
      console.log(`🌐 OpenAI API endpoint: https://api.openai.com/v1/chat/completions`);
      
      // Make OpenAI API call with explicit error handling and timeout
      let response;
      // Allow up to 12 minutes for large/complex census files. The route-level timeout should match this.
      const OPENAI_TIMEOUT_MS = 720000; // 12 minutes timeout
      
      try {
        console.log('⏳ Calling OpenAI API...');
        console.log(`⏱️ Timeout set to ${OPENAI_TIMEOUT_MS / 1000} seconds`);
        console.log(`📊 Model: ${this.model}`);
        
        const startTime = Date.now();
        
        // GPT-4.1 context window is 1M tokens total (input + output)
        // Max completion tokens: 32,768 (API confirmed limit)
        // Input: ~20-50k tokens (file content + system prompt)
        // Output: up to 32,768 tokens (2x the previous gpt-4o limit)
        
        // Create the OpenAI API call promise
        // Note: The OpenAI SDK timeout option may not work reliably, so we use Promise.race
        console.log('📤 Creating OpenAI API request...');
        console.log(`📊 Request size: ${userMessage.length} chars user message + ${this.getSystemPrompt().length} chars system prompt`);
        
        const openaiCall = this.openai.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: this.getSystemPrompt() },
            { role: 'user', content: userMessage }
          ],
          ...buildChatCompletionOptions(this.model, {
            tokenLimit: 32768,
            jsonMode: true,
            temperature: 0.3,
          }),
        });
        
        console.log('✅ OpenAI API request promise created');
        
        // Add a promise wrapper to catch and log errors immediately
        const wrappedOpenaiCall = openaiCall.catch((error) => {
          // Log the error immediately when the promise rejects
          console.error('❌ OpenAI API call promise rejected:', error);
          console.error('❌ Error type:', error.constructor?.name || typeof error);
          console.error('❌ Error message:', error.message);
          console.error('❌ Error code:', error.code);
          
          if (error.response) {
            console.error('❌ Error response status:', error.response.status);
            console.error('❌ Error response data:', JSON.stringify(error.response.data, null, 2));
          }
          
          if (error.status) {
            console.error('❌ Error status:', error.status);
          }
          
          throw error;
        });
        
        console.log('✅ OpenAI API request created, starting Promise.race...');
        
        // Create a timeout promise with progress logging
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            console.error(`⏰ TIMEOUT: OpenAI API call exceeded ${OPENAI_TIMEOUT_MS / 1000} seconds`);
            reject(new Error(`OpenAI API call timed out after ${OPENAI_TIMEOUT_MS / 1000} seconds. The file may be too large or complex. Please try the Standard Import option.`));
          }, OPENAI_TIMEOUT_MS);
        });
        
        // Add progress logging every 10 seconds
        const progressInterval = setInterval(() => {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          console.log(`⏳ Still waiting for OpenAI API... (${elapsed}s elapsed, timeout in ${Math.max(0, (OPENAI_TIMEOUT_MS / 1000) - elapsed)}s)`);
        }, 10000);
        
        // Race between OpenAI call and timeout
        console.log('⏳ Waiting for OpenAI API response...');
        console.log(`📡 Making HTTP request to OpenAI API now...`);
        
        // Log immediately before the race
        const raceStartTime = Date.now();
        
        try {
          console.log('🏁 Starting Promise.race between OpenAI call and timeout...');
          response = await Promise.race([wrappedOpenaiCall, timeoutPromise]);
          const raceDuration = Date.now() - raceStartTime;
          console.log(`✅ Promise.race completed successfully in ${raceDuration}ms (${(raceDuration / 1000).toFixed(2)}s)`);
          clearTimeout(timeoutId);
          clearInterval(progressInterval);
        } catch (raceError) {
          const raceDuration = Date.now() - raceStartTime;
          console.error(`❌ Promise.race failed after ${raceDuration}ms (${(raceDuration / 1000).toFixed(2)}s)`);
          console.error(`❌ Error from race: ${raceError.message}`);
          clearTimeout(timeoutId);
          clearInterval(progressInterval);
          
          // Check if this is a context limit error - if so, we should chunk
          if (raceError.message && (
            raceError.message.includes('context_length_exceeded') ||
            raceError.message.includes('maximum context length') ||
            raceError.message.includes('token limit') ||
            raceError.message.includes('too many tokens')
          )) {
            console.error('❌ Context limit error detected - file needs to be chunked');
            throw new Error('CONTEXT_LIMIT_EXCEEDED');
          }
          
          throw raceError;
        }
        
        const duration = Date.now() - startTime;
        console.log(`✅ OpenAI API response received in ${duration}ms (${(duration / 1000).toFixed(2)}s)`);
        console.log(`📝 Response usage: ${JSON.stringify(response.usage || {})}`);
        
        // Check if response has content
        if (!response || !response.choices || !response.choices[0] || !response.choices[0].message) {
          console.error('❌ Invalid response structure:', JSON.stringify(response, null, 2));
          throw new Error('OpenAI API returned an invalid response structure');
        }
        
        // Log response structure for debugging
        console.log('📊 Response structure check:');
        console.log(`   Has choices: ${!!response.choices}`);
        console.log(`   Choices count: ${response.choices?.length || 0}`);
        console.log(`   First choice has message: ${!!response.choices?.[0]?.message}`);
        console.log(`   Message has content: ${!!response.choices?.[0]?.message?.content}`);
        console.log(`   Content type: ${typeof response.choices?.[0]?.message?.content}`);
        console.log(`   Content value: ${response.choices?.[0]?.message?.content ? 'present' : 'null/empty'}`);
      } catch (openaiError) {
        console.error('❌ OpenAI API call failed:', openaiError);
        console.error('❌ Error type:', openaiError.constructor?.name || typeof openaiError);
        console.error('❌ Error message:', openaiError.message);
        console.error('❌ Error stack:', openaiError.stack);
        
        if (openaiError.response) {
          console.error('❌ Error response status:', openaiError.response.status);
          console.error('❌ Error response headers:', openaiError.response.headers);
          console.error('❌ Error response data:', JSON.stringify(openaiError.response.data, null, 2));
          
          // Check for context limit errors in response
          const errorData = openaiError.response.data;
          if (errorData?.error?.message && (
            errorData.error.message.includes('context_length_exceeded') ||
            errorData.error.message.includes('maximum context length') ||
            errorData.error.message.includes('token limit') ||
            errorData.error.message.includes('too many tokens')
          )) {
            console.error('❌ Context limit error detected in API response - file needs to be chunked');
            throw new Error('CONTEXT_LIMIT_EXCEEDED');
          }
        }
        
        if (openaiError.code) {
          console.error('❌ Error code:', openaiError.code);
        }
        
        // Check error message for context limit
        if (openaiError.message && (
          openaiError.message.includes('context_length_exceeded') ||
          openaiError.message.includes('maximum context length') ||
          openaiError.message.includes('token limit') ||
          openaiError.message.includes('too many tokens')
        )) {
          console.error('❌ Context limit error detected in error message - file needs to be chunked');
          throw new Error('CONTEXT_LIMIT_EXCEEDED');
        }
        
        throw openaiError;
      }

      const generatedText = response.choices[0].message.content;
      const finishReason = response.choices[0].finish_reason;
      
      console.log('📝 AI Response received, parsing JSON...');
      console.log(`📊 Finish reason: ${finishReason}`);
      console.log(`📊 Token usage:`, JSON.stringify(response.usage, null, 2));
      
      // Check if content is null or empty
      if (!generatedText) {
        console.error('❌ CRITICAL: AI response content is null or empty!');
        console.error('❌ Response structure:', JSON.stringify(response, null, 2));
        console.error('❌ This usually means the AI hit an error or the response was truncated.');
        throw new Error('AI returned an empty response. This may indicate the file is too complex, the prompt is too long, or there was an API error. Please try the Standard Import option or contact support.');
      }
      
      console.log(`📊 AI Response length: ${generatedText.length} characters`);
      
      // Warn if response is suspiciously short
      if (generatedText.length < 100) {
        console.warn(`⚠️ WARNING: AI response is very short (${generatedText.length} chars). This may indicate an error or incomplete response.`);
        console.warn(`⚠️ Response content: ${generatedText.substring(0, 500)}`);
      }
      
      // Check if response was truncated
      if (finishReason === 'length') {
        console.error('⚠️ WARNING: AI response was truncated due to token limit!');
        console.error('⚠️ The JSON may be incomplete. Consider reducing file size or increasing max_tokens.');
      }
      
      // Check if JSON response is structurally complete
      const trimmedText = generatedText.trim();
      const startsWithBrace = trimmedText.startsWith('{');
      const endsWithBrace = trimmedText.endsWith('}');
      const braceCount = (trimmedText.match(/\{/g) || []).length;
      const closingBraceCount = (trimmedText.match(/\}/g) || []).length;
      
      console.log(`📊 JSON Structure Check:`);
      console.log(`   Starts with {: ${startsWithBrace}`);
      console.log(`   Ends with }: ${endsWithBrace}`);
      console.log(`   Opening braces: ${braceCount}`);
      console.log(`   Closing braces: ${closingBraceCount}`);
      console.log(`   Balance: ${braceCount === closingBraceCount ? '✅ Balanced' : '❌ UNBALANCED'}`);
      
      if (!endsWithBrace || braceCount !== closingBraceCount) {
        console.error('⚠️ WARNING: JSON response appears incomplete or malformed!');
        console.error(`⚠️ Response ends with: "${trimmedText.substring(Math.max(0, trimmedText.length - 100))}"`);
      }

      let parsedData;
      try {
        parsedData = JSON.parse(generatedText);
      } catch (parseError) {
        console.error('❌ Failed to parse AI response as JSON:', parseError.message);
        
        // Log detailed error information
        if (parseError instanceof SyntaxError) {
          const errorPosition = parseError.message.match(/position (\d+)/);
          if (errorPosition) {
            const pos = parseInt(errorPosition[1], 10);
            const startPos = Math.max(0, pos - 200);
            const endPos = Math.min(generatedText.length, pos + 200);
            const snippet = generatedText.substring(startPos, endPos);
            const relativePos = pos - startPos;
            
            console.error(`❌ JSON Parse Error at position ${pos}:`);
            console.error(`❌ Context around error (characters ${startPos}-${endPos}):`);
            console.error('─'.repeat(80));
            console.error(snippet.substring(0, relativePos) + '❌[ERROR HERE]❌' + snippet.substring(relativePos));
            console.error('─'.repeat(80));
            
            // Also log the first and last 500 characters to see structure
            console.error(`❌ First 500 characters of response:`, generatedText.substring(0, 500));
            console.error(`❌ Last 500 characters of response:`, generatedText.substring(Math.max(0, generatedText.length - 500)));
          }
        }
        
        // Log the full response if it's not too large (for debugging)
        if (generatedText.length < 10000) {
          console.error('❌ Full AI response (for debugging):');
          console.error(generatedText);
        } else {
          console.error(`❌ AI response is too large to log (${generatedText.length} chars). Error details above.`);
        }
        
        throw new Error(`AI did not return valid JSON: ${parseError.message}`);
      }

      // Log processing notes from AI if present
      if (parsedData.processingNotes) {
        console.log('📝 AI Processing Notes:');
        console.log(`   ${parsedData.processingNotes}`);
      }
      
      // Validate parsed data (structural validation + non-fatal warnings)
      const validation = this.validateParsedData(parsedData);
      if (!validation.valid) {
        console.error('Validation failed (structural errors):', validation.errors);
        throw new Error(`Parsed data validation failed: ${validation.errors.join(', ')}`);
      }

      // Clean up / normalize warnings coming from the AI + our own validation
      const aiWarnings = Array.isArray(parsedData.warnings) ? parsedData.warnings : [];
      const validationWarnings = Array.isArray(validation.warnings) ? validation.warnings : [];

      // Some AI-generated row-order warnings have proven inaccurate (e.g. "Dependent X appears before primary member")
      // To avoid confusing the user, filter those out for now and rely on household structure itself.
      const filteredAiWarnings = aiWarnings.filter(
        w => !/appears before primary member/i.test(w || '')
      );

      // Determine which FLAG_ERROR warnings should be considered fatal.
      // We treat serious structural issues as fatal, but NOT simple invalid date formats or missing primary member warnings
      // (which are often incorrect - e.g., female primary members, or primary listed elsewhere)
      const fatalWarnings = filteredAiWarnings.filter(w => {
        if (!/^FLAG_ERROR:/i.test(w || '')) return false;
        if (/invalid date format/i.test(w || '')) return false;
        if (/lacks a primary member|no primary member|primary member before|marked as.*but lacks|marked as.*but is a dependent/i.test(w || '')) return false;
        return true;
      });

      // Normalize warnings for display: strip FLAG_ERROR prefix so the UI sees clean messages
      const normalizedAiWarnings = filteredAiWarnings.map(w =>
        (w || '').replace(/^FLAG_ERROR:\s*/i, '')
      );

      const allWarnings = [...normalizedAiWarnings, ...validationWarnings];
      if (allWarnings.length > 0) {
        console.warn('Parsed data has non-fatal warnings:', allWarnings);
        parsedData.warnings = allWarnings;
      }

      // If the AI raised any truly fatal FLAG_ERROR warnings (non-date issues), do not allow import to proceed
      if (fatalWarnings.length > 0) {
        console.error('❌ Fatal FLAG_ERROR warnings detected in parsed data:', fatalWarnings);
        throw new Error(`AI parsing produced fatal errors: ${fatalWarnings.join('; ')}`);
      }

      console.log('✅ Census file parsed successfully');
      
      // Calculate actual member count from parsed data
      const actualPrimaryMembers = parsedData.households?.length || 0;
      const actualDependents = parsedData.households?.reduce((sum, h) => sum + (h.dependents?.length || 0), 0) || 0;
      const actualTotalMembers = actualPrimaryMembers + actualDependents;
      
      // Count total rows sent to AI (extract from chunkContent)
      const rowMatches = chunkContent?.match(/ROW_(\d+):/g) || [];
      const totalRowsSent = rowMatches.length;
      const maxRowNumber = totalRowsSent > 0 ? Math.max(...rowMatches.map(m => {
        const numMatch = m.match(/ROW_(\d+):/);
        return numMatch ? parseInt(numMatch[1], 10) : 0;
      })) : 0;
      
      console.log(`📊 Statistics from AI: ${parsedData.statistics?.totalMembers || 0} members, ${parsedData.statistics?.households || 0} households`);
      console.log(`📊 Actual parsed data: ${actualTotalMembers} members (${actualPrimaryMembers} primary + ${actualDependents} dependents), ${actualPrimaryMembers} households`);
      console.log(`📊 Rows sent to AI: ${totalRowsSent} rows (up to ROW_${maxRowNumber})`);
      
      // Extract row numbers mentioned in AI warnings
      const rowNumbersInWarnings = new Set();
      const allWarningsForAnalysis = [...(parsedData.warnings || []), ...(aiWarnings || [])];
      allWarningsForAnalysis.forEach(warning => {
        const rowMatches = warning.match(/ROW[_\s]*(\d+)|Row\s+(\d+)|row\s+(\d+)/gi);
        if (rowMatches) {
          rowMatches.forEach(match => {
            const num = match.match(/\d+/)?.[0];
            if (num) rowNumbersInWarnings.add(parseInt(num, 10));
          });
        }
      });
      
      // Warn if there's a discrepancy
      if (parsedData.statistics?.totalMembers !== actualTotalMembers) {
        console.warn(`⚠️ WARNING: AI statistics (${parsedData.statistics?.totalMembers}) don't match actual parsed data (${actualTotalMembers})`);
        console.warn(`⚠️ This suggests the AI may have skipped rows or there's a counting error.`);
        if (parsedData.processingNotes) {
          console.warn(`⚠️ AI's explanation: ${parsedData.processingNotes}`);
        } else {
          console.warn(`⚠️ AI did not provide processing notes explaining why it stopped early.`);
        }
        console.warn(`⚠️ Household breakdown: ${actualPrimaryMembers} households with ${actualDependents} dependents`);
        
        // Log sample of households to help debug
        if (parsedData.households && parsedData.households.length > 0) {
          console.log(`📋 Sample households (first 3):`);
          parsedData.households.slice(0, 3).forEach((h, idx) => {
            console.log(`  Household ${idx + 1}: Primary: ${h.primaryMember?.firstName || 'MISSING'} ${h.primaryMember?.lastName || 'MISSING'}, Dependents: ${h.dependents?.length || 0}`);
          });
        }
      }
      
      // Extract the highest row number processed by AI (from member data if available)
      let highestRowProcessed = 0;
      if (parsedData.households) {
        // Try to extract row numbers from warnings or infer from data
        const allWarningsText = (parsedData.warnings || []).join(' ');
        const rowMatches = allWarningsText.match(/ROW[_\s]*(\d+)/gi);
        if (rowMatches) {
          const rowNumbers = rowMatches.map(m => {
            const num = m.match(/\d+/)?.[0];
            return num ? parseInt(num, 10) : 0;
          });
          highestRowProcessed = Math.max(...rowNumbers, 0);
        }
      }
      
      // Check for severe data loss (if we sent many rows but got few members)
      // This is a critical issue - log it prominently
      const expectedMembersFromRows = Math.max(1, Math.floor(totalRowsSent / 2)); // Rough estimate: ~2 rows per member (primary + dependents)
      if (totalRowsSent > 50 && actualTotalMembers < expectedMembersFromRows * 0.3) {
        console.error(`❌ CRITICAL: Severe data loss detected!`);
        console.error(`❌ Rows sent to AI: ${totalRowsSent} rows (up to ROW_${maxRowNumber})`);
        console.error(`❌ Expected members: ~${expectedMembersFromRows} (based on row count)`);
        console.error(`❌ Actual parsed: ${actualTotalMembers} members`);
        console.error(`❌ Data loss: ${Math.round((1 - actualTotalMembers / expectedMembersFromRows) * 100)}%`);
        if (highestRowProcessed > 0) {
          console.error(`❌ Highest row number mentioned in warnings: ROW_${highestRowProcessed} (out of ${maxRowNumber} total)`);
          console.error(`❌ AI appears to have stopped processing around row ${highestRowProcessed}, missing ${maxRowNumber - highestRowProcessed} rows`);
        } else {
          console.error(`❌ This suggests the AI stopped processing early or skipped most rows.`);
        }
        
        // Show which rows were mentioned in warnings
        if (rowNumbersInWarnings.size > 0) {
          const sortedRows = Array.from(rowNumbersInWarnings).sort((a, b) => a - b);
          console.error(`❌ Rows mentioned in AI warnings: ${sortedRows.slice(0, 20).join(', ')}${sortedRows.length > 20 ? ` (and ${sortedRows.length - 20} more)` : ''}`);
        }
        
        // Try to extract sample rows that might have been skipped
        // Look for rows in the middle/end of the chunk that weren't processed
        if (chunkContent && maxRowNumber > 0) {
          const sampleRowsToCheck = [];
          const step = Math.max(1, Math.floor(maxRowNumber / 10));
          for (let i = step; i <= maxRowNumber; i += step) {
            const rowMatch = chunkContent.match(new RegExp(`ROW_${i}:\\s*(.+?)(?:\\n|ROW_|$)`));
            if (rowMatch && rowMatch[1]) {
              sampleRowsToCheck.push({ row: i, content: rowMatch[1].substring(0, 100) });
            }
          }
          
          if (sampleRowsToCheck.length > 0) {
            console.error(`❌ Sample rows from file (to verify if they contain member data):`);
            sampleRowsToCheck.slice(0, 5).forEach(({ row, content }) => {
              console.error(`   ROW_${row}: ${content}...`);
            });
          }
        }
        
        console.error(`❌ Check AI warnings above for explanations of skipped rows.`);
      }
      
      // Update statistics to match actual data
      if (parsedData.statistics) {
        parsedData.statistics.totalMembers = actualTotalMembers;
        parsedData.statistics.households = actualPrimaryMembers;
        parsedData.statistics.primaryMembers = actualPrimaryMembers;
        parsedData.statistics.dependents = actualDependents;
      }

      // Remove processingNotes from response (keep only in console logs)
      const { processingNotes, ...responseData } = parsedData;

      return {
        success: true,
        data: responseData
      };

    } catch (error) {
      console.error('❌ Error parsing census file with AI:', error);
      console.error('❌ Error stack:', error.stack);
      console.error('❌ Error name:', error.name);
      console.error('❌ Error code:', error.code);
      
      // Check for specific error types
      if (error.message && error.message.includes('timeout')) {
        return {
          success: false,
          error: 'AI parsing timed out. The file may be too large or complex. Please try the Standard Import option or split the file into smaller chunks.'
        };
      }
      
      if (error.message && error.message.includes('API key')) {
        return {
          success: false,
          error: 'OpenAI API key is not configured. Please contact support.'
        };
      }
      
      if (error.response) {
        console.error('❌ OpenAI API error response:', error.response.status, error.response.data);
        return {
          success: false,
          error: `OpenAI API error: ${error.response.status} - ${error.response.data?.error?.message || error.message}`
        };
      }
      
      return {
        success: false,
        error: error.message || 'Failed to parse census file with AI. Please try the Standard Import option.'
      };
    }
  }

  /**
   * Validate parsed data
   * - Structural problems return errors (and cause the parse to fail)
   * - Missing/invalid field issues become non-fatal warnings so the user can fix them in the UI
   * @param {Object} parsedData - Parsed data from AI
   * @returns {Object} - { valid, errors, warnings }
   */
  validateParsedData(parsedData) {
    const errors = [];
    const warnings = [];

    if (!parsedData.households || !Array.isArray(parsedData.households)) {
      errors.push('Households array is missing or invalid');
      return { valid: false, errors, warnings };
    }

    if (parsedData.households.length === 0) {
      errors.push('No households found in parsed data');
      return { valid: false, errors, warnings };
    }

      // Filter out invalid households BEFORE validation
      // CRITICAL: Remove households where primary member doesn't have BOTH firstName AND lastName
      const originalHouseholds = [...parsedData.households]; // Keep copy for logging
      const originalHouseholdCount = originalHouseholds.length;
      const validHouseholds = [];
      const invalidHouseholdIndices = [];
      const invalidHouseholdDetails = [];
      
      console.log(`🔍 [Validation] Starting validation of ${originalHouseholdCount} households from AI...`);
      
      originalHouseholds.forEach((household, index) => {
        if (!household.primaryMember) {
          invalidHouseholdIndices.push(index + 1);
          invalidHouseholdDetails.push(`Household ${index + 1}: No primary member object`);
          console.warn(`⚠️ [Validation] Filtering out household ${index + 1}: No primary member object`);
          return;
        }

        const primary = household.primaryMember;
        const dependentsCount = household.dependents?.length || 0;

        // CRITICAL: Primary member MUST have BOTH firstName AND lastName
        // If not, this household is invalid and should be filtered out
        if (!primary.firstName || !primary.lastName) {
          invalidHouseholdIndices.push(index + 1);
          const detail = `Household ${index + 1}: Primary "${primary.firstName || 'MISSING'} ${primary.lastName || 'MISSING'}" missing ${!primary.firstName ? 'firstName' : ''}${!primary.firstName && !primary.lastName ? ' and ' : ''}${!primary.lastName ? 'lastName' : ''} (${dependentsCount} dependents lost)`;
          invalidHouseholdDetails.push(detail);
          console.warn(`⚠️ [Validation] Filtering out ${detail}`);
          return;
        }

        // This household is valid - keep it
        validHouseholds.push(household);
      });

      // Update parsedData with only valid households
      parsedData.households = validHouseholds;
      const filteredCount = originalHouseholdCount - validHouseholds.length;

      // Log detailed filtering results
      if (filteredCount > 0) {
        console.warn(`⚠️ [Validation] Filtered out ${filteredCount} invalid household(s) out of ${originalHouseholdCount} total`);
        console.warn(`⚠️ [Validation] Invalid household details:`);
        invalidHouseholdDetails.forEach(detail => console.warn(`   - ${detail}`));
        
        // Calculate how many members were lost (use originalHouseholds, not parsedData.households)
        const lostMembers = invalidHouseholdIndices.reduce((sum, idx) => {
          const household = originalHouseholds[idx - 1];
          if (household) {
            return sum + 1 + (household.dependents?.length || 0); // primary + dependents
          }
          return sum;
        }, 0);
        
        console.warn(`⚠️ [Validation] Estimated members lost due to filtering: ${lostMembers} (${filteredCount} primary + their dependents)`);
        warnings.push(`Filtered out ${filteredCount} invalid household(s) where primary member was missing firstName or lastName`);
      } else {
        console.log(`✅ [Validation] All ${originalHouseholdCount} households have valid primary members`);
      }

      // Validate each VALID household
      parsedData.households.forEach((household, index) => {
        const primary = household.primaryMember;

        // Missing primary email -> warning (user can fix in preview, but firstName/lastName are required)
        if (!primary.email) {
          warnings.push(`Household ${index + 1}: Primary member is missing email (will need to be added before import)`);
        }

        // Relationship type must still be structurally correct
        if (primary.relationshipType !== 'P') {
          errors.push(`Household ${index + 1}: Primary member relationshipType must be "P"`);
        }

        // Invalid primary email -> warning
        if (primary.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(primary.email)) {
          warnings.push(`Household ${index + 1}: Primary member email is invalid: ${primary.email}`);
        }

      // Validate dependents
      if (household.dependents && Array.isArray(household.dependents)) {
        household.dependents.forEach((dependent, depIndex) => {
          // Missing dependent first/last -> warning only (email is optional for dependents)
          if (!dependent.firstName || !dependent.lastName) {
            warnings.push(`Household ${index + 1}, Dependent ${depIndex + 1}: Missing required fields (firstName, lastName)`);
          }

          // Relationship type must still be structurally correct
          if (dependent.relationshipType !== 'S' && dependent.relationshipType !== 'C') {
            errors.push(`Household ${index + 1}, Dependent ${depIndex + 1}: relationshipType must be "S" or "C"`);
          }

          // Invalid dependent email -> warning
          if (dependent.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dependent.email)) {
            warnings.push(`Household ${index + 1}, Dependent ${depIndex + 1}: Email is invalid: ${dependent.email}`);
          }
        });
      }
    });

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
}

module.exports = new AICensusParserService();

