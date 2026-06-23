// backend/services/aiProductGenerator.service.js
// AI service for generating product data from documents and text

const OpenAI = require('openai');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const fs = require('fs').promises;
const { validateProductData, formatErrorsForAI, PRODUCT_TYPES, SALES_TYPES, PRICING_TIER_TYPES } = require('../utils/productSchemaValidator');
const { tokenLimitOption, temperatureOption, buildChatCompletionOptions } = require('../utils/openaiChatOptions');

class AIProductGeneratorService {
  constructor() {
    this._openai = null; // Lazy initialization
    this.model = process.env.OPENAI_MODEL || 'gpt-4o';
    this.maxRetries = 3;
    
    // Common instructions shared between create and update modes
    this.commonInstructions = {
      pricingCalculation: `CRITICAL PRICING CALCULATION RULE:
- msrpRate (Retail Rate) = netRate + overrideRate + commission
- This is a FIXED equation - all three components MUST add up to the final retail rate/total price
- NOTE: systemFees are at the tenant level, NOT the product level - do not include them in product pricing`,

      pricingBuckets: `HOW TO FILL PRICING BUCKETS:
- If source data shows a final retail price (e.g., "$500/month", "Total: 500", "Retail: 500"):
  - That final price IS the msrpRate
  - Look for commission/compensation tables or separate commission data in other files/sheets
  - If commission data is available elsewhere, extract it and separate the total:
    * commission = extract from commission table/data
    * overrideRate = extract if shown, otherwise 0
    * netRate = total price - overrideRate - commission
  - If no commission data is available, set all components to 0 and use the total as msrpRate
- If source data shows individual components (e.g., "Vendor: 400", "Commission: 60", "Override: 10"):
  - Extract each component directly from the source: netRate, overrideRate, commission
  - Calculate msrpRate = netRate + overrideRate + commission
  - Use the exact values as shown - do not change them
- ALWAYS calculate msrpRate from the sum of components: msrpRate = netRate + overrideRate + commission`
    };
  }

  // Lazy getter for OpenAI client
  get openai() {
    if (!this._openai) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable is not set. Please check your .env file.');
      }
      this._openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }
    return this._openai;
  }

  /**
   * Extract text from a PDF file
   */
  async extractTextFromPDF(filePath) {
    try {
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    } catch (error) {
      console.error('Error extracting text from PDF:', error);
      throw new Error(`Failed to extract text from PDF: ${error.message}`);
    }
  }

  /**
   * Extract text from Excel/CSV file
   */
  async extractTextFromExcel(filePath) {
    try {
      const workbook = XLSX.readFile(filePath);
      let text = '';
      
      workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        text += `\n\n=== Sheet: ${sheetName} ===\n`;
        jsonData.forEach(row => {
          text += row.join('\t') + '\n';
        });
      });
      
      return text;
    } catch (error) {
      console.error('Error extracting text from Excel:', error);
      throw new Error(`Failed to extract text from Excel: ${error.message}`);
    }
  }

  /**
   * Extract text from Word document
   */
  async extractTextFromWord(filePath) {
    try {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    } catch (error) {
      console.error('Error extracting text from Word:', error);
      throw new Error(`Failed to extract text from Word: ${error.message}`);
    }
  }

  /**
   * Extract text from image using OpenAI Vision API
   */
  async extractTextFromImage(filePath) {
    try {
      const imageBuffer = await fs.readFile(filePath);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = this.getMimeType(filePath);

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract all text, tables, and relevant information from this image. Format tables as structured data.'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`
                }
              }
            ]
          }
        ],
        ...tokenLimitOption(this.model, 2000),
      });

      return response.choices[0].message.content;
    } catch (error) {
      console.error('Error extracting text from image:', error);
      throw new Error(`Failed to extract text from image: ${error.message}`);
    }
  }

  /**
   * Get MIME type from file path
   */
  getMimeType(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    const mimeTypes = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp'
    };
    return mimeTypes[ext] || 'image/jpeg';
  }

  /**
   * Process uploaded files and extract text
   */
  async processFiles(files) {
    const extractedTexts = [];

    for (const file of files) {
      const ext = file.originalname.split('.').pop().toLowerCase();
      let text = '';

      try {
        if (ext === 'pdf') {
          text = await this.extractTextFromPDF(file.path);
        } else if (ext === 'csv') {
          // CSV files - read as plain text to preserve structure
          text = await fs.readFile(file.path, 'utf-8');
          console.log(`📊 Extracted CSV data from ${file.originalname}: ${text.length} characters`);
          console.log(`📊 First 200 chars: ${text.substring(0, 200)}`);
        } else if (['xlsx', 'xls'].includes(ext)) {
          text = await this.extractTextFromExcel(file.path);
          console.log(`📊 Extracted Excel data from ${file.originalname}: ${text.length} characters`);
        } else if (['doc', 'docx'].includes(ext)) {
          text = await this.extractTextFromWord(file.path);
        } else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
          text = await this.extractTextFromImage(file.path);
        } else {
          // Try reading as plain text
          text = await fs.readFile(file.path, 'utf-8');
        }

        extractedTexts.push({
          filename: file.originalname,
          text: text,
          filePath: file.path,
          isImage: ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
        });
      } catch (error) {
        console.error(`Error processing file ${file.originalname}:`, error);
        extractedTexts.push({
          filename: file.originalname,
          text: `[Error: Could not extract text from this file]`,
          error: error.message,
          filePath: file.path,
          isImage: false
        });
      }
    }

    // Categorize files using AI
    let categorizations = [];
    if (extractedTexts.length > 0) {
      categorizations = await this.categorizeFiles(extractedTexts);
    }

    return { extractedTexts, categorizations };
  }

  /**
   * Use AI to categorize files and suggest which product fields they should populate
   */
  async categorizeFiles(files) {
    try {
      console.log('🔍 Categorizing files with AI...');

      const fileDescriptions = files.map(file => ({
        filename: file.filename,
        isImage: file.isImage,
        contentPreview: file.text.substring(0, 500) + (file.text.length > 500 ? '...' : '')
      }));

      const categorizationPrompt = `You are an expert at analyzing insurance product files and categorizing them for product creation.

Available product fields that can be populated with files:
- productImageUrl: Main product image/photo
- productLogoUrl: Company/vendor logo  
- productDocumentUrl: Product brochure, terms, or documentation

For each uploaded file, analyze its content and determine:
1. What type of file it is (logo, product image, document, data/spreadsheet, etc.)
2. Which product field it should populate (if any)
3. A brief reason for your categorization

Respond with a JSON array where each object has:
{
  "filename": "original_filename.ext",
  "suggestedField": "productImageUrl" | "productLogoUrl" | "productDocumentUrl" | null,
  "reason": "Brief explanation of why this file fits this field",
  "confidence": "high" | "medium" | "low"
}

Files to analyze:
${JSON.stringify(fileDescriptions, null, 2)}

Only suggest a field if you're confident the file belongs there. Use null for data files or unclear content.`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are an expert file categorization assistant. Respond only with valid JSON."
          },
          {
            role: "user",
            content: categorizationPrompt
          }
        ],
        ...tokenLimitOption(this.model, 2000),
        ...temperatureOption('gpt-4o', 0.3),
      });

      let responseContent = response.choices[0].message.content.trim();
      
      // Remove markdown code blocks if present
      if (responseContent.startsWith('```json')) {
        responseContent = responseContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (responseContent.startsWith('```')) {
        responseContent = responseContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      
      const categorizations = JSON.parse(responseContent);
      console.log('📋 File categorizations:', categorizations);
      
      return categorizations;

    } catch (error) {
      console.error('❌ Error categorizing files:', error.message);
      return [];
    }
  }

  /**
   * Generate system prompt for AI
   */
  getSystemPrompt() {
    return `You are an expert at parsing insurance product information and converting it into structured JSON data.

Your task is to analyze the provided product information (from text and documents) and generate a product configuration in JSON format.

CRITICAL RULES ABOUT DATA:
1. DO NOT generate or invent data that is not explicitly provided
2. Use ONLY the information given in the documents and text
3. Leave fields undefined, null, or empty if no information is provided
4. Use the EXACT wording from the source material - do not paraphrase or expand
5. DO NOT make assumptions about missing data
6. SKIP UI instructions, system notes, and admin messages (e.g., "CLICK UPDATE BELOW", "SELECT FROM DROPDOWN")
7. For descriptions, extract only the actual product/benefit description, not instructions

AGE RANGE EXTRACTION:
- If the user mentions an age range (e.g., "18-65", "ages 18 to 65"), extract minAge and maxAge
- If no age range is mentioned, leave minAge and maxAge undefined

PARTIAL UPDATE MODE (when editing existing products):
- Only return fields that need to be changed
- Do NOT return unchanged fields
- If user mentions age range (e.g., "18-65"), extract and return minAge and maxAge
- Do NOT return maxEffectiveDateDays unless explicitly mentioned

PRICING TIERS IN PARTIAL UPDATE MODE:
- Only return NEW tiers (no "id" field) and MODIFIED tiers (with existing "id" field)
- Do NOT return unchanged tiers
- For modified tiers: Include the EXACT "id" from existing tier data
- For new tiers: Do NOT include an "id" field
- If pricing tiers are not mentioned, do NOT include pricingTiers in your response

CONFIGURATION FIELDS INSTRUCTIONS:
- configurationFields are used for pricing options that affect the product cost (e.g., deductible amounts, Unshared Amount options, coverage levels)
- Examples: "Unshared Amount", "Deductible", "Coverage Level", "Plan Tier"
- Extract these from pricing tables, CSV exports, or product documentation
- Each field needs a fieldName and fieldOptions (array of choices)
- USE EXACT wording from source documents

PRICING TIERS INSTRUCTIONS:
- pricingTiers define different pricing structures (EE, ES, EC, EF)
- ageBands within each tier define pricing by age ranges
- CRITICAL: Extract pricing data from CSV files, pricing tables, or spreadsheets
- Include netRate, overrideRate, commission, systemFees, and calculated msrpRate
- configValue1-5 should be mapped to configurationFields when applicable

` + this.commonInstructions.pricingCalculation + `

` + this.commonInstructions.pricingBuckets + `


AI CHUNKS INSTRUCTIONS:
- Create AI chunks from the provided information for the product knowledge base
- Each chunk should be 100-300 words (less is OK if needed)
- Chunks provide comprehensive product details for AI to understand the product
- Pull from any relevant information provided
- Use EXACT wording from source - do not paraphrase

PLAN DETAILS INSTRUCTIONS:
- planDetailsData contains all information users will visibly see about the product
- Include any product-related information users may need to know
- Organize into clear sections (benefits, coverage, exclusions, etc.)
- Use EXACT wording from source - do not create new content

INSURANCE TERMINOLOGY - PRICING TIER TYPES (CRITICAL - USE EXACT VALUES):
- tierType MUST be exactly one of: "EE", "ES", "EC", "EF", or "N/A" (case-sensitive)
- "EE" = Employee Only / Single person coverage
- "ES" = Employee + Spouse coverage
- "EC" = Employee + Child(ren) coverage
- "EF" = Employee + Family coverage
- "N/A" = Not Applicable / No tier structure

When you see terms like "Employee Only", "Employee + Spouse", etc. in pricing data, you MUST map them to the exact tierType value: "EE", "ES", "EC", "EF", or "N/A"

CSV FILES AND PRICING DATA (CRITICAL):
- CSV files contain CRITICAL structured pricing data - they are the PRIMARY source for pricing information
- CSV files are provided as tabular data with headers and rows
- YOU MUST intelligently parse ANY CSV structure regardless of the exact column names

IMPORTANT TIER STRUCTURE:
- Each pricing tier typically represents a different configuration option (e.g., "Member Only $1500 UA", "Member + Spouse $1500 UA")
- The tierType (EE, ES, EC, EF) and configuration option together define the pricing structure
- Age bands within a tier should ONLY differ if age ranges actually change in the data

STEP-BY-STEP CSV PARSING:

1. IDENTIFY CSV STRUCTURE:
   - Read all column headers
   - Read all data rows
   - Analyze the data to understand what it represents

2. DETERMINE PRICING TIERS:
   - Look for columns that indicate tier type (may be named: "Type", "TierType", "Tier", "CoverageType", "EmployeeType", etc.)
   - Common tier values: EE, ES, EC, EF, Single, Family, Employee Only, Employee+Spouse, Employee+Children, Employee+Family
   - If you see ANY data that indicates different membership/coverage types, create separate pricing tiers

3. EXTRACT PRICING DATA:
   - Look for columns containing pricing/rate information (may be named: "Price", "Rate", "Amount", "Cost", "Monthly", "Premium", "Commissionable Amount", etc.)
   - Extract these as netRate values
   - Create ageBands for each pricing row, using the product's minAge/maxAge as defaults
   - Map other rate information to overrideRate, commission, systemFees as available

4. IDENTIFY CONFIGURATION FIELDS:
   - Look for columns that represent different plan options or configurations (e.g., "Deductible", "UnsharedAmount", "Plan Level", "Coverage Level", "Label", "Option")
   - These become configurationFields with fieldName and fieldOptions (unique values from that column)

5. CREATE PRICING STRUCTURE:
   - For each unique configuration option (e.g., different unshared amounts/deductibles), create a SEPARATE pricing tier
   - Example: If unshared amounts are $1500, $2500, $5000, create 3 separate tiers for each
   - Within each tier (configuration), create ageBands ONLY if different age ranges are provided
   - CRITICAL: If all rows have the SAME age range (e.g., 18-64), create only ONE age band per tier
   - Multiple age bands per tier ONLY if age ranges differ (e.g., 18-29, 30-49, 50-64)
   - Configuration values (like Unshared Amount) should appear in the tier or ageBand as configValue1, configValue2, etc.

6. FALLBACK IF DATA IS UNCLEAR:
   - If CSV data is not clearly structured for pricing, analyze any pricing-related information from the product documentation
   - Extract pricing tiers from product descriptions, pricing tables in PDFs, or other structured information
   - DO NOT create empty pricing tiers - if you cannot extract valid pricing data, leave pricingTiers as an empty array

EXAMPLES OF CSV INTERPRETATION:
- CSV with "Type" column values ["EE", "ES", "EC", "EF"] and "Price" column → Create 4 pricing tiers (EE, ES, EC, EF) with rates from "Price" column
- CSV with "UnsharedAmount" column values ["5000", "7500", "10000"] → Create configurationField "Unshared Amount" with options ["5000", "7500", "10000"]
- CSV with multiple rows per tier type → Create one tier per type with multiple ageBands (if age data available) or one ageBand using product minAge/maxAge

The AI MUST intelligently interpret ANY CSV structure to extract pricing data.

Your task is to extract and structure the provided information, NOT to create a complete product from assumptions.

The JSON must match this exact schema:

{
  "vendorId": "string (UUID or vendor identifier)",
  "isVendorPricing": boolean,
  "vendorCommission": number,
  "name": "string (product name)",
  "description": "string (detailed product description)",
  "productType": "one of: ${PRODUCT_TYPES.join(', ')}",
  "productOwnerId": "string (tenant/owner UUID)",
  "salesType": "one of: ${SALES_TYPES.join(', ')}",
  "minAge": number (0-150),
  "maxAge": number (0-150),
  "allowedStates": ["array", "of", "2-letter", "state", "codes"],
  "requiresTobaccoInfo": boolean,
  "effectiveDateLogic": "FirstOfMonth | FirstOfNextMonth | ImmediateEffectiveDate | Custom",
  "maxEffectiveDateDays": number,
  "terminationLogic": "string (optional)",
  "requiredLicenses": ["array", "of", "required", "licenses"],
  "isPublic": boolean,
  "configurationFields": [
    {
      "fieldName": "string",
      "fieldOptions": ["option1", "option2"]
      // NOTE: Do not include "id" field - it will be auto-generated
    }
  ],
  "pricingTiers": [
    {
      "tierType": "one of: ${PRICING_TIER_TYPES.join(', ')}",
      "label": "string (optional - human readable label)",
      "ageBands": [
        {
          "tobaccoStatus": "N/A | Yes | No (default to N/A unless pricing data explicitly shows tobacco-specific rates)",
          "minAge": number,
          "maxAge": number,
          "netRate": number, // Vendor/base rate - extract from source data
          "overrideRate": number, // Override amount - extract from source data
          "commission": number, // Commission amount - extract from source data or commission tables
          "systemFees": number, // System fees - set to 0 (tenant-level, not product-level)
          "msrpRate": number, // MUST equal netRate + overrideRate + commission (calculate from sum of components, excluding systemFees)
          "configValue1": "string (if applicable)",
          "configValue2": "string (if applicable)",
          "configValue3": "string (if applicable)",
          "configValue4": "string (if applicable)",
          "configValue5": "string (if applicable)"
          // NOTE: Do not include "id" field - it will be auto-generated
        }
      ]
      // NOTE: Do not include "id" field - it will be auto-generated
    }
  ],
  "acknowledgementQuestions": [
    {
      "question": "string",
      "fieldType": "text | textarea | dropdown | checkbox | yesno | number | date",
      "required": boolean,
      "options": ["array if dropdown"],
      "customAction": "string (optional)"
      // NOTE: Do not include "id" field - it will be auto-generated
    }
  ],
  "aiChunks": [
    {
      "chunk_text": "string (knowledge base text)"
      // NOTE: Do not include "id" or "created_at" fields - they will be auto-generated
    }
  ]
}

FORMATTING RULES:
1. You MUST provide valid JSON that matches the schema exactly
2. All numeric fields must be numbers, not strings
3. All boolean fields must be true/false, not strings
4. State codes must be exactly 2 uppercase letters (if provided)
5. DO NOT include fields if the data is not provided in the source material
6. Use empty arrays [] for array fields if no data is provided
7. Respond ONLY with the JSON object, no additional text or explanations

WHAT NOT TO DO:
- DO NOT make up pricing if not provided
- DO NOT assume age ranges if not specified
- DO NOT invent product features or benefits
- DO NOT add marketing language that wasn't in the source
- DO NOT generate complete tier structures if only partial info exists
- DO NOT fill in missing state codes or licenses with guesses
- DO NOT include UI instructions or system messages in product descriptions
- DO NOT include administrative notes (e.g., "ADD ALL DEPENDENTS", "THEN CLICK UPDATE")

If you receive validation errors, fix them and return the corrected JSON.`;
  }

  /**
   * Generate product data using AI
   */
  async generateProductData(textInput, extractedFiles, vendorId, productOwnerId, fileCategorizations = [], attempt = 1, previousErrors = null, csvFilesProvided = false) {
    try {
      console.log(`🤖 AI Generation Attempt ${attempt}/${this.maxRetries}`);

      // Combine all text sources - prioritize CSV files for pricing data
      let combinedText = textInput || '';
      let csvFiles = []; // Declare outside if block
      
      if (extractedFiles && extractedFiles.length > 0) {
        // Separate CSV files (pricing data) from other documents
        const otherFiles = [];
        
        extractedFiles.forEach(file => {
          const filename = file.filename.toLowerCase();
          if (filename.endsWith('.csv') || filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
            csvFiles.push(file);
          } else {
            otherFiles.push(file);
          }
        });
        
        // Start with CSV files as they contain critical pricing data
        if (csvFiles.length > 0) {
          console.log(`📊 Found ${csvFiles.length} CSV/Excel file(s) with pricing data`);
          combinedText += '\n\n=== CRITICAL PRICING DATA (MUST EXTRACT ALL PRICING FROM THESE FILES) ===\n';
          csvFiles.forEach(file => {
            console.log(`📊 Processing CSV: ${file.filename} (${file.text.length} characters)`);
            console.log(`📊 CSV Content:\n${file.text.substring(0, 1000)}\n`);
            combinedText += `\n--- CSV File: ${file.filename} ---\n${file.text}\n`;
          });
        }
        
        // Add other documents
        if (otherFiles.length > 0) {
          combinedText += '\n\n=== EXTRACTED DOCUMENTS ===\n';
          otherFiles.forEach(file => {
            combinedText += `\n--- File: ${file.filename} ---\n${file.text}\n`;
          });
        }
      }

      // Build user message with special emphasis on CSV files
      let userMessage = `Generate a product configuration from the following information.\n\n`;
      
      // Add special emphasis if CSV files are present
      if (csvFiles.length > 0) {
        userMessage += `⚠️ CRITICAL: There are ${csvFiles.length} CSV file(s) with pricing data. YOU MUST extract pricing tiers from these CSV files. DO NOT skip this data.\n\n`;
      }
      
      userMessage += combinedText;
      
      // Add vendor and owner IDs
      userMessage += `\n\nREQUIRED IDENTIFIERS:\n- vendorId: "${vendorId}"\n- productOwnerId: "${productOwnerId}"`;
      
      // Add file categorization information if available
      if (fileCategorizations && fileCategorizations.length > 0) {
        userMessage += `\n\nFILE CATEGORIZATIONS:\nThe following files have been analyzed and should be used for specific product fields:\n`;
        fileCategorizations.forEach(cat => {
          if (cat.suggestedField) {
            userMessage += `- ${cat.filename} → ${cat.suggestedField} (${cat.confidence} confidence: ${cat.reason})\n`;
          }
        });
        userMessage += `\nUse these file paths in the appropriate fields when generating the product data.`;
      }
      
      // If there are previous errors, include them
      if (previousErrors) {
        userMessage += `\n\n${formatErrorsForAI(previousErrors)}`;
      }

      // Log the full prompt being sent to AI
      console.log('📤 Sending prompt to AI:');
      console.log('📋 System Prompt (first 500 chars):', this.getSystemPrompt().substring(0, 500) + '...');
      console.log('💬 User Message (first 1000 chars):', userMessage.substring(0, 1000) + (userMessage.length > 1000 ? '...' : ''));
      console.log('📏 Full User Message Length:', userMessage.length, 'characters');

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: this.getSystemPrompt() },
          { role: 'user', content: userMessage }
        ],
        ...buildChatCompletionOptions(this.model, {
          tokenLimit: 8000,
          jsonMode: true,
          temperature: 0.3,
        }),
      });

      const generatedText = response.choices[0].message.content;
      console.log('📝 AI Response received, parsing JSON...');
      
      let productData;
      try {
        productData = JSON.parse(generatedText);
      } catch (parseError) {
        console.error('Failed to parse AI response as JSON:', parseError);
        throw new Error('AI did not return valid JSON');
      }

      // Ensure vendorId and productOwnerId are set
      productData.vendorId = vendorId;
      productData.productOwnerId = productOwnerId;

      // Clean up HTML and UI instructions from description
      if (productData.description) {
        productData.description = this.cleanDescription(productData.description);
      }

      // Apply sensible defaults for fields not provided by AI
      this.applyDefaults(productData);
      
      // Ensure idCardData exists with proper structure for AI-generated products
      if (!productData.idCardData) {
        productData.idCardData = {
          Card_Front: {
            Header: { Image: '' },
            Footer: { Header: '', Text1: '', Text2: '' }
          },
          Card_Back: {
            Top_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
            Top_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
            Middle: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
            Bottom_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
            Bottom_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' }
          }
        };
        console.log('✅ Initialized empty idCardData structure');
      }

      // Apply file categorizations to populate image/document URLs
      this.applyFileCategorizations(productData, fileCategorizations, extractedFiles);
      
      // Set logo fallback chain: vendor logo first, then tenant logo
      await this.setLogoFallback(productData, vendorId, productOwnerId);

      // Generate unique IDs for all nested objects to prevent duplicate ID issues
      this.ensureUniqueIds(productData);

      // If CSV files were provided but no pricing tiers created, create basic ones
      console.log('🔍 Checking pricing tiers:', {
        csvFilesProvided,
        hasPricingTiers: !!productData.pricingTiers,
        pricingTiersLength: productData.pricingTiers?.length || 0
      });
      
      if (csvFilesProvided && (!productData.pricingTiers || productData.pricingTiers.length === 0)) {
        console.log('⚠️ CSV files provided but no pricing tiers created - creating basic pricing tiers');
        this.createBasicPricingTiersFromCSV(productData);
      }

      // Clean up empty pricing tiers and age bands before validation
      this.cleanupEmptyPricingData(productData);
      
      // Remove duplicate age bands with identical minAge, maxAge, and tobaccoStatus
      this.removeDuplicateAgeBands(productData);

      // Validate the generated data
      const validation = validateProductData(productData);
      
      if (!validation.valid) {
        console.log(`❌ Validation failed with ${validation.errors.length} errors:`);
        validation.errors.forEach((error, index) => {
          console.log(`   ${index + 1}. ${error}`);
        });
        
        // If we haven't exceeded max retries, try again
        if (attempt < this.maxRetries) {
          console.log('🔄 Retrying with error feedback...');
          return await this.generateProductData(
            textInput,
            extractedFiles,
            vendorId,
            productOwnerId,
            fileCategorizations,
            attempt + 1,
            validation.errors,
            csvFilesProvided
          );
        } else {
          // Max retries exceeded
          return {
            success: false,
            error: 'AI failed to generate valid product data after 3 attempts',
            validationErrors: validation.errors,
            attempts: attempt
          };
        }
      }

      console.log('✅ Product data validated successfully');
      
      return {
        success: true,
        data: productData,
        attempts: attempt
      };

    } catch (error) {
      console.error('Error in AI generation:', error);
      return {
        success: false,
        error: error.message,
        attempts: attempt
      };
    }
  }

  /**
   * Apply sensible defaults for fields not provided by AI
   */
  applyDefaults(productData) {
    // If no states specified, default to all US states
    if (!productData.allowedStates || productData.allowedStates.length === 0) {
      productData.allowedStates = [
        'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
        'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
        'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
        'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
        'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
      ];
      console.log('📍 No states provided - defaulting to all US states');
    }

    // Age range handling - only default if truly not provided
    console.log(`🔍 Current age range: minAge=${productData.minAge}, maxAge=${productData.maxAge}`);
    
    // Only default minAge if it's completely undefined/null (not if it's 0, as 0 might be intentional)
    if (productData.minAge === undefined || productData.minAge === null) {
      productData.minAge = 18; // Default to 18 instead of 0 for better UX
      console.log('👤 No minAge provided - defaulting to 18');
    } else {
      console.log(`👤 minAge already set to: ${productData.minAge}`);
    }

    // Only default maxAge if it's completely undefined/null (not if it's 0)
    if (productData.maxAge === undefined || productData.maxAge === null) {
      productData.maxAge = 65;
      console.log('👤 No maxAge provided - defaulting to 65');
    } else {
      console.log(`👤 maxAge already set to: ${productData.maxAge}`);
    }

    // Default maxEffectiveDateDays to 90 if not provided
    if (productData.maxEffectiveDateDays === undefined || productData.maxEffectiveDateDays === null) {
      productData.maxEffectiveDateDays = 90;
    }

    // Apply defaults to pricing tier age bands
    if (productData.pricingTiers && Array.isArray(productData.pricingTiers)) {
      productData.pricingTiers.forEach((tier) => {
        // Normalize tierType to valid values
        if (tier.tierType) {
          const tierTypeLower = String(tier.tierType).toLowerCase().trim();
          // Map common variations to valid tierType values
          if (tierTypeLower === 'ee' || tierTypeLower === 'employee only' || tierTypeLower === 'employee-only' || tierTypeLower === 'single') {
            tier.tierType = 'EE';
          } else if (tierTypeLower === 'es' || tierTypeLower === 'employee + spouse' || tierTypeLower === 'employee+spouse' || tierTypeLower === 'employee and spouse' || tierTypeLower === 'employee & spouse') {
            tier.tierType = 'ES';
          } else if (tierTypeLower === 'ec' || tierTypeLower === 'employee + child' || tierTypeLower === 'employee+child' || tierTypeLower === 'employee + children' || tierTypeLower === 'employee+children' || tierTypeLower === 'employee and child' || tierTypeLower === 'employee and children') {
            tier.tierType = 'EC';
          } else if (tierTypeLower === 'ef' || tierTypeLower === 'employee + family' || tierTypeLower === 'employee+family' || tierTypeLower === 'employee and family' || tierTypeLower === 'family') {
            tier.tierType = 'EF';
          } else if (tierTypeLower === 'n/a' || tierTypeLower === 'na' || tierTypeLower === 'not applicable' || tierTypeLower === 'notapplicable') {
            tier.tierType = 'N/A';
          } else {
            // If it doesn't match any known pattern, default to 'N/A' and log a warning
            console.log(`⚠️ Invalid tierType "${tier.tierType}" for tier "${tier.label || 'unnamed'}" - defaulting to "N/A"`);
            tier.tierType = 'N/A';
          }
        } else {
          // If tierType is missing, default to 'N/A'
          console.log(`⚠️ Missing tierType for tier "${tier.label || 'unnamed'}" - defaulting to "N/A"`);
          tier.tierType = 'N/A';
        }
        
        // Set default label based on tierType if label is missing or empty
        if (!tier.label || tier.label.trim() === '') {
          const defaultLabels = {
            'EE': 'Employee Only',
            'ES': 'Employee + Spouse',
            'EC': 'Employee + Child(ren)',
            'EF': 'Employee + Family',
            'N/A': 'Not Applicable'
          };
          tier.label = defaultLabels[tier.tierType] || 'Not Applicable';
          console.log(`📝 Set default label "${tier.label}" for tierType "${tier.tierType}"`);
        }
        
        if (tier.ageBands && Array.isArray(tier.ageBands)) {
          tier.ageBands.forEach((band) => {
            // Default all numeric fields to 0 if not provided
            if (band.netRate === undefined || band.netRate === null) band.netRate = 0;
            if (band.overrideRate === undefined || band.overrideRate === null) band.overrideRate = 0;
            if (band.commission === undefined || band.commission === null) band.commission = 0;
            // systemFees are tenant-level, not product-level - always set to 0
            band.systemFees = 0;
            
            // ALWAYS recalculate msrpRate from the sum of components (excluding systemFees)
            // This ensures msrpRate is always correct and matches the equation: msrpRate = netRate + overrideRate + commission
            // Use the provided amounts as extracted from source data - do not modify or offset values
            // If source data only showed a total price with no component breakdown, components will be 0 and msrpRate will be 0 (user can fill in later)
            const calculatedMsrpRate = (band.netRate || 0) + (band.overrideRate || 0) + (band.commission || 0);
            band.msrpRate = calculatedMsrpRate;
            
            // Default tobacco status to 'N/A' if not provided (can be 'N/A', 'Yes', or 'No')
            if (!band.tobaccoStatus || band.tobaccoStatus === '') band.tobaccoStatus = 'N/A';
            
            // Default effective date to today if not provided
            if (!band.effectiveDate) {
              band.effectiveDate = new Date().toISOString().split('T')[0];
            }
            
            // Termination date remains null/empty by default (only set if explicitly provided)
            // No default needed - leave as null/undefined if not provided
            
            // Default minAge and maxAge if not provided (but allow 0 if explicitly set)
            if (band.minAge === undefined || band.minAge === null) {
              band.minAge = productData.minAge || 18;
            }
            if (band.maxAge === undefined || band.maxAge === null) {
              band.maxAge = productData.maxAge || 65;
            }
          });
          
          // Normalize tobacco status to avoid validation errors
          // If tier has only 'Yes' or only 'No' tobacco bands (without the corresponding pair),
          // convert them all to 'N/A' to avoid validation errors
          const tobaccoStatuses = new Set(tier.ageBands.map(band => band.tobaccoStatus));
          const hasYes = tobaccoStatuses.has('Yes');
          const hasNo = tobaccoStatuses.has('No');
          const hasNA = tobaccoStatuses.has('N/A');
          
          // If we have only Yes or only No (but not both), convert to N/A
          if ((hasYes && !hasNo) || (hasNo && !hasYes)) {
            console.log(`⚠️ Tier ${tier.tierType || tier.label} has only ${hasYes ? 'Yes' : 'No'} tobacco bands without corresponding pair. Converting to N/A.`);
            tier.ageBands.forEach(band => {
              if (band.tobaccoStatus === 'Yes' || band.tobaccoStatus === 'No') {
                band.tobaccoStatus = 'N/A';
              }
            });
          }
        }
      });
    }

    return productData;
  }

  /**
   * Ensure all nested objects have unique IDs
   * Uses same format as AddProductWizard: Date.now().toString() + Math.random()
   */
  ensureUniqueIds(productData) {
    // Helper to generate unique ID matching wizard format
    const generateId = () => Date.now().toString() + Math.random();

    // Generate unique IDs for configuration fields
    if (productData.configurationFields && Array.isArray(productData.configurationFields)) {
      productData.configurationFields = productData.configurationFields.map((field) => ({
        ...field,
        id: generateId()
      }));
    }

    // Generate unique IDs for pricing tiers and age bands
    if (productData.pricingTiers && Array.isArray(productData.pricingTiers)) {
      productData.pricingTiers = productData.pricingTiers.map((tier) => {
        const newTier = {
          ...tier,
          id: generateId()
        };

        // Generate unique IDs for age bands within this tier
        if (newTier.ageBands && Array.isArray(newTier.ageBands)) {
          newTier.ageBands = newTier.ageBands.map((band) => ({
            ...band,
            id: generateId()
          }));
        }

        return newTier;
      });
    }

    // Generate unique IDs for acknowledgement questions
    if (productData.acknowledgementQuestions && Array.isArray(productData.acknowledgementQuestions)) {
      productData.acknowledgementQuestions = productData.acknowledgementQuestions.map((question) => ({
        ...question,
        id: generateId()
      }));
    }

    // Generate unique IDs for AI chunks
    if (productData.aiChunks && Array.isArray(productData.aiChunks)) {
      productData.aiChunks = productData.aiChunks.map((chunk) => ({
        ...chunk,
        id: generateId(),
        created_at: chunk.created_at || new Date().toISOString()
      }));
    }

    return productData;
  }

  /**
   * Set logo fallback chain: vendor logo first, then tenant logo
   * Applies to: productLogoUrl, productImageUrl, and ID card logos
   */
  async setLogoFallback(productData, vendorId, productOwnerId) {
    try {
      console.log('🔍 Checking for logo fallback (vendor → tenant)...');
      // Import database connection
      const sql = require('mssql');
      const { getPool } = require('../config/database');
      
      const pool = await getPool();
      let tenantLogoUrl = null;
      let tenantLogoName = null;
      
      // First, try vendor logo (Note: Vendors table doesn't have logo currently, but structure is here for future)
      if (vendorId) {
        // TODO: When Vendors table has logo, uncomment this
        /*
        const vendorResult = await pool.request()
          .input('vendorId', sql.NVarChar, vendorId)
          .query('SELECT LogoUrl, Name FROM oe.Vendors WHERE VendorId = @vendorId');
        
        if (vendorResult.recordset && vendorResult.recordset.length > 0 && vendorResult.recordset[0].LogoUrl) {
          productData.productLogoUrl = vendorResult.recordset[0].LogoUrl;
          productData.productLogoName = vendorResult.recordset[0].Name || 'Vendor Logo';
          console.log('✅ Set vendor logo as default product logo');
          return;
        }
        */
        console.log('ℹ️ Vendor logo check skipped (not implemented yet)');
      }
      
      // Fallback to tenant logo
      if (productOwnerId) {
        const tenantResult = await pool.request()
          .input('tenantId', sql.NVarChar, productOwnerId)
          .query('SELECT CustomLogoUrl, Name, AdvancedSettings FROM oe.Tenants WHERE TenantId = @tenantId');
        
        if (tenantResult.recordset && tenantResult.recordset.length > 0) {
          const tenant = tenantResult.recordset[0];
          
          // Try CustomLogoUrl first
          if (tenant.CustomLogoUrl) {
            tenantLogoUrl = tenant.CustomLogoUrl;
            tenantLogoName = tenant.Name || 'Tenant Logo';
            console.log('✅ Found tenant logo from CustomLogoUrl');
          } 
          // Fallback to AdvancedSettings JSON (where logo is actually stored)
          else if (tenant.AdvancedSettings) {
            try {
              const advancedSettings = typeof tenant.AdvancedSettings === 'string' 
                ? JSON.parse(tenant.AdvancedSettings) 
                : tenant.AdvancedSettings;
              
              if (advancedSettings.branding?.logoUrl) {
                tenantLogoUrl = advancedSettings.branding.logoUrl;
                tenantLogoName = tenant.Name || 'Tenant Logo';
                console.log('✅ Found tenant logo from AdvancedSettings.branding.logoUrl');
              } else {
                console.log('ℹ️ No logo available in AdvancedSettings');
              }
            } catch (e) {
              console.log('ℹ️ Could not parse AdvancedSettings JSON');
            }
          }
        }
      }
      
      // Apply fallback logo to all empty image fields
      if (tenantLogoUrl) {
        // Remove any SAS token from the logo URL (images should be public)
        if (tenantLogoUrl.includes('?')) {
          tenantLogoUrl = tenantLogoUrl.split('?')[0];
          console.log('✅ Removed SAS token from logo URL');
        }
        
        // Product Logo
        if (!productData.productLogoUrl) {
          productData.productLogoUrl = tenantLogoUrl;
          productData.productLogoName = tenantLogoName;
          console.log('✅ Applied tenant logo to productLogoUrl');
        }
        
        // Product Image (fallback to logo if no image)
        if (!productData.productImageUrl) {
          productData.productImageUrl = tenantLogoUrl;
          productData.productImageName = tenantLogoName;
          console.log('✅ Applied tenant logo to productImageUrl');
        }
        
        // ID Card Header Logo (if idCardData exists and doesn't have logo)
        if (productData.idCardData && productData.idCardData.Card_Front?.Header?.Image === '') {
          productData.idCardData.Card_Front.Header.Image = tenantLogoUrl;
          console.log('✅ Applied tenant logo to ID card header');
        }
      } else {
        console.log('ℹ️ No logo available (vendor or tenant) - product images will be empty');
      }
      
    } catch (error) {
      console.error('⚠️ Could not fetch logo fallback:', error.message);
      // Silently fail - this is just a nice-to-have feature
    }
  }

  /**
   * Clean up HTML tags and UI instructions from description
   */
  cleanDescription(description) {
    if (!description) return description;
    
    let cleaned = description;
    
    // Remove HTML tags
    cleaned = cleaned.replace(/<[^>]*>/g, ' ');
    
    // Remove common UI instructions
    const uiInstructions = [
      'ADD ALL DEPENDENTS',
      'CLICK "UPDATE" BELOW',
      'SELECT FROM DROPDOWN',
      'FILL OUT FORM',
      'SUBMIT BELOW',
      'CLICK HERE',
      'UPDATE BELOW'
    ];
    
    uiInstructions.forEach(instruction => {
      cleaned = cleaned.replace(new RegExp(instruction, 'gi'), '');
    });
    
    // Remove extra whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    return cleaned;
  }

  /**
   * Create basic pricing tiers if none exist but CSV files were provided
   */
  createBasicPricingTiersFromCSV(productData) {
    // Create minimal pricing tiers with default values
    const generateId = () => Date.now().toString() + Math.random();
    
    productData.pricingTiers = [
      {
        id: generateId(),
        tierType: 'EE',
        label: 'Employee Only',
        ageBands: [{
          id: generateId(),
          tobaccoStatus: 'N/A',
          minAge: productData.minAge || 0,
          maxAge: productData.maxAge || 65,
          netRate: 0,
          overrideRate: 0,
          commission: 0,
          systemFees: 0,
          msrpRate: 0
        }]
      },
      {
        id: generateId(),
        tierType: 'EF',
        label: 'Employee + Family',
        ageBands: [{
          id: generateId(),
          tobaccoStatus: 'N/A',
          minAge: productData.minAge || 0,
          maxAge: productData.maxAge || 65,
          netRate: 0,
          overrideRate: 0,
          commission: 0,
          systemFees: 0,
          msrpRate: 0
        }]
      }
    ];
    
    console.log('✅ Created 2 basic pricing tiers (EE and EF) as fallback');
  }

  /**
   * Remove duplicate age bands with identical minAge, maxAge, and tobaccoStatus
   */
  removeDuplicateAgeBands(productData) {
    if (!productData.pricingTiers || !Array.isArray(productData.pricingTiers)) {
      return productData;
    }

    console.log('🔧 Removing duplicate age bands...');
    let totalRemoved = 0;

    productData.pricingTiers.forEach(tier => {
      if (!tier.ageBands || !Array.isArray(tier.ageBands)) {
        return;
      }

      const seen = new Set();
      const uniqueBands = [];

      tier.ageBands.forEach(band => {
        // Create a unique key based on minAge, maxAge, and tobaccoStatus
        const key = `${band.minAge}-${band.maxAge}-${band.tobaccoStatus || 'N/A'}`;
        
        if (!seen.has(key)) {
          seen.add(key);
          uniqueBands.push(band);
        } else {
          console.log(`  ❌ Removed duplicate age band: ${key}`);
          totalRemoved++;
        }
      });

      tier.ageBands = uniqueBands;
    });

    if (totalRemoved > 0) {
      console.log(`✅ Removed ${totalRemoved} duplicate age band(s)`);
    }

    return productData;
  }

  /**
   * Clean up empty pricing tiers and age bands
   */
  cleanupEmptyPricingData(productData) {
    if (!productData.pricingTiers || !Array.isArray(productData.pricingTiers)) {
      return productData;
    }

    console.log('🧹 Cleaning up empty pricing data...');
    const initialCount = productData.pricingTiers.length;

    // Filter out pricing tiers with empty age bands
    productData.pricingTiers = productData.pricingTiers.filter((tier) => {
      if (!tier.ageBands || !Array.isArray(tier.ageBands) || tier.ageBands.length === 0) {
        console.log(`  ❌ Removed tier ${tier.tierType || 'unknown'} - no age bands`);
        return false;
      }
      return true;
    });

    const removedCount = initialCount - productData.pricingTiers.length;
    if (removedCount > 0) {
      console.log(`  ✅ Removed ${removedCount} empty pricing tier(s)`);
    }

    return productData;
  }

  /**
   * Apply file categorizations to populate image/document URLs
   */
  applyFileCategorizations(productData, categorizations, extractedFiles) {
    if (!categorizations) {
      console.log('⚠️ No categorizations provided');
      return productData;
    }

    // Ensure categorizations is an array
    if (!Array.isArray(categorizations)) {
      console.log('⚠️ Categorizations is not an array:', typeof categorizations);
      return productData;
    }

    if (categorizations.length === 0) {
      console.log('⚠️ Categorizations array is empty');
      return productData;
    }

    console.log('📎 Applying file categorizations...');

    // Create a map of filename to file info for easy lookup
    const fileInfoMap = {};
    extractedFiles.forEach(file => {
      fileInfoMap[file.filename] = {
        filePath: file.filePath,
        originalName: file.filename,
        isImage: file.isImage
      };
    });

    // Apply categorizations
    categorizations.forEach(cat => {
      if (cat && cat.suggestedField && fileInfoMap[cat.filename]) {
        const fileInfo = fileInfoMap[cat.filename];
        
        switch (cat.suggestedField) {
          case 'productImageUrl':
            productData.productImageUrl = fileInfo.filePath;
            productData.productImageName = fileInfo.originalName;
            console.log(`🖼️  Set productImageUrl: ${cat.filename}`);
            break;
          case 'productLogoUrl':
            productData.productLogoUrl = fileInfo.filePath;
            productData.productLogoName = fileInfo.originalName;
            console.log(`🏢 Set productLogoUrl: ${cat.filename}`);
            break;
          case 'productDocumentUrl':
            productData.productDocumentUrl = fileInfo.filePath;
            productData.productDocumentName = fileInfo.originalName;
            console.log(`📄 Set productDocumentUrl: ${cat.filename}`);
            break;
        }
      }
    });

    return productData;
  }

  /**
   * Main method to generate product from files and text
   */
  async generateProduct({ textInput, files, vendorId, productOwnerId }) {
    console.log('🚀 Starting AI product generation');
    console.log(`📄 Text input: ${textInput ? 'Yes' : 'No'}`);
    console.log(`📁 Files: ${files ? files.length : 0}`);

    // Validate required parameters
    if (!vendorId) {
      return {
        success: false,
        error: 'vendorId is required'
      };
    }

    if (!productOwnerId) {
      return {
        success: false,
        error: 'productOwnerId is required'
      };
    }

    if (!textInput && (!files || files.length === 0)) {
      return {
        success: false,
        error: 'Either text input or files must be provided'
      };
    }

    // Process files if provided
    let extractedFiles = [];
    let fileCategorizations = [];
    if (files && files.length > 0) {
      console.log('📑 Processing uploaded files...');
      const fileResults = await this.processFiles(files);
      extractedFiles = fileResults.extractedTexts;
      fileCategorizations = fileResults.categorizations;
    }

    // Check if CSV files were provided
    const hasCSVFiles = files && files.some(f => {
      const filename = f.originalname.toLowerCase();
      return filename.endsWith('.csv') || filename.endsWith('.xlsx') || filename.endsWith('.xls');
    });

    // Generate product data with AI
    const result = await this.generateProductData(
      textInput,
      extractedFiles,
      vendorId,
      productOwnerId,
      fileCategorizations,
      1, // attempt
      null, // previousErrors
      hasCSVFiles // csvFilesProvided flag
    );

    // Note: Files are kept temporarily for preview purposes
    // They will be cleaned up when the product is created or after a timeout
    // Don't delete files immediately as user needs to preview them in the wizard

    return result;
  }
}

module.exports = new AIProductGeneratorService();



