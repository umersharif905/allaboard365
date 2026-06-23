const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TXT = 'text/plain';

async function extractText(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) throw new Error('extractText: buffer required');
  switch (mimeType) {
    case PDF: {
      // pdf-parse (which uses PDF.js v1.10.100 internally) requires a Uint8Array
      // or ArrayBuffer — passing a Node Buffer directly causes "bad XRef entry".
      const parsed = await pdfParse(new Uint8Array(buffer));
      return parsed.text || '';
    }
    case DOCX: {
      const { value } = await mammoth.extractRawText({ buffer });
      return value || '';
    }
    case TXT:
      return buffer.toString('utf8');
    default:
      throw new Error(`Unsupported file type: ${mimeType}`);
  }
}

module.exports = { extractText };
