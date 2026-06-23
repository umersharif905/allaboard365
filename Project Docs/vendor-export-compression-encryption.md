# Vendor Export - File Compression & Encryption

## Current Status
✅ **UI Added**: Toggle switches for compression and encryption in the Integration Settings tab  
⏳ **Implementation Needed**: The actual compression and encryption logic needs to be built

## How It Should Work

### 1. File Compression (ZIP)

**Purpose**: Reduce file size for faster transfers and storage savings

**Implementation**:
- When `ExportCompressionEnabled = true`, the export file should be compressed into a ZIP archive
- Use Node.js library: `archiver` or `adm-zip`
- File naming: If original file is `vendor-export-2025-01-11.csv`, compressed file becomes `vendor-export-2025-01-11.csv.zip`

**Example Flow**:
```
1. Generate export file (CSV/JSON/XML) → vendor-export-2025-01-11.csv
2. If compression enabled:
   - Create ZIP archive
   - Add CSV file to archive
   - Result: vendor-export-2025-01-11.csv.zip
3. Upload ZIP file to SFTP or send via API
```

**Code Example** (to be implemented):
```javascript
const archiver = require('archiver');
const fs = require('fs');

async function compressFile(filePath, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => resolve(outputPath));
    archive.on('error', reject);
    
    archive.pipe(output);
    archive.file(filePath, { name: path.basename(filePath) });
    archive.finalize();
  });
}
```

### 2. File Encryption

**Purpose**: Protect sensitive data in transit and at rest

**Implementation Options**:

#### Option A: Use Existing Encryption Service
- The system already has `encryptionService.js` for encrypting sensitive data fields
- This uses AES-256-GCM encryption
- **Note**: This is designed for encrypting strings/data fields, not entire files

#### Option B: File-Level Encryption (Recommended)
- Use a library like `crypto` (built-in) or `node-forge` for file encryption
- Encrypt the entire file content before sending
- Use AES-256-CBC or AES-256-GCM for file encryption
- Generate a unique encryption key per export (or use vendor-specific key)

**Example Flow**:
```
1. Generate export file → vendor-export-2025-01-11.csv
2. If encryption enabled:
   - Generate encryption key (or use vendor's encryption key)
   - Encrypt file content using AES-256
   - Result: vendor-export-2025-01-11.csv.encrypted
3. Upload encrypted file to SFTP or send via API
4. Vendor decrypts using shared key/password
```

**Code Example** (to be implemented):
```javascript
const crypto = require('crypto');
const fs = require('fs');

async function encryptFile(filePath, outputPath, password) {
  const algorithm = 'aes-256-gcm';
  const key = crypto.scryptSync(password, 'salt', 32);
  const iv = crypto.randomBytes(16);
  
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const input = fs.createReadStream(filePath);
  const output = fs.createWriteStream(outputPath);
  
  // Write IV first
  output.write(iv);
  
  input.pipe(cipher).pipe(output);
  
  return new Promise((resolve, reject) => {
    output.on('finish', () => resolve(outputPath));
    output.on('error', reject);
  });
}
```

### 3. Combined Compression + Encryption

**Order of Operations**:
1. Generate export file (CSV/JSON/XML)
2. **If compression enabled**: Compress to ZIP
3. **If encryption enabled**: Encrypt the file (compressed or original)
4. Upload to SFTP or send via API

**Example**:
- Original: `vendor-export-2025-01-11.csv`
- Compressed: `vendor-export-2025-01-11.csv.zip`
- Encrypted: `vendor-export-2025-01-11.csv.zip.encrypted`

## Database Storage

The settings are stored in `oe.Vendors` table:
- `ExportCompressionEnabled` (BIT) - Whether to compress files
- `ExportEncryptionEnabled` (BIT) - Whether to encrypt files

## Implementation Requirements

### 1. Install Dependencies
```bash
npm install archiver  # For ZIP compression
# OR
npm install adm-zip   # Alternative ZIP library
```

### 2. Create Export Service
Create `backend/services/vendorExportService.js` that:
- Reads vendor export settings from database
- Generates export file in specified format (CSV/JSON/XML)
- Applies compression if enabled
- Applies encryption if enabled
- Uploads to SFTP or sends via API

### 3. Encryption Key Management
- **Option 1**: Generate unique key per export, encrypt with vendor's public key
- **Option 2**: Use vendor-specific encryption password (stored encrypted in database)
- **Option 3**: Use shared secret key (vendor provides, stored encrypted)

### 4. Vendor Decryption
- Vendor needs to know how to decrypt files
- May need to provide decryption instructions or tool
- Consider providing decryption key/password separately (not in same file)

## Security Considerations

1. **Encryption Keys**: Never store encryption keys in plain text
2. **Key Exchange**: Use secure method to share encryption keys with vendors
3. **Key Rotation**: Consider key rotation policies
4. **File Naming**: Encrypted files should have clear extension (`.encrypted` or `.enc`)
5. **Compression**: ZIP files can be password-protected (additional security layer)

## Next Steps

1. ✅ UI toggles added
2. ✅ Database columns added
3. ⏳ Implement compression logic
4. ⏳ Implement encryption logic
5. ⏳ Create export service that uses these settings
6. ⏳ Add encryption key management
7. ⏳ Test with actual exports
