// backend/utils/pdfGenerator.js

/**
 * UNIFIED PDF GENERATOR
 * Used by both EnrollmentWizard and ProductChangePage for consistent document generation
 * 
 * @param {Array} acknowledgements - Product acknowledgements with proper structure
 * @param {string} digitalSignature - Digital signature (base64 data URL or text)
 * @param {Object} memberInfo - Member information (firstName, lastName, email, phone, dateOfBirth, address, city, state, zip)
 * @param {Array} productSelections - Selected products with proper structure
 * @returns {Promise<string>} - Base64 encoded PDF
 */
async function generateAgreementsPDF(acknowledgements, digitalSignature, memberInfo, productSelections) {
    console.log('🚀 PDF Generator - Starting');
    return new Promise((resolve, reject) => {
        try {
            // Log metadata only; full acknowledgement/question text is enormous and unhelpful in logs.
            console.log('🔍 PDF Generator - Input:', {
                acknowledgements: acknowledgements ? acknowledgements.length : 0,
                digitalSignature: digitalSignature ? 'Present' : 'Missing',
                memberInfo: memberInfo ? 'Present' : 'Missing',
                productSelections: productSelections ? productSelections.length : 0
            });
            
            const PDFDocument = require('pdfkit');
            const doc = new PDFDocument({
                size: 'A4',
                margins: {
                    top: 50,
                    bottom: 50,
                    left: 50,
                    right: 50
                }
            });

            const chunks = [];
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => {
                try {
                    const result = Buffer.concat(chunks);
                    resolve(result.toString('base64'));
                } catch (error) {
                    reject(error);
                }
            });
            doc.on('error', reject);

            // Add header
            doc.fontSize(20)
               .font('Helvetica-Bold')
               .text('ENROLLMENT AGREEMENTS & ACKNOWLEDGEMENTS', { align: 'center' });
            
            doc.moveDown(0.5);
            doc.fontSize(12)
               .font('Helvetica')
               .text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
            
            doc.moveDown(2);

            // Add member information (simplified - no tobacco use, gender, or household info)
            doc.fontSize(16)
               .font('Helvetica-Bold')
               .text('MEMBER INFORMATION');
            
            doc.moveDown(0.5);
            doc.fontSize(12)
               .font('Helvetica')
               .text(`Name: ${memberInfo.firstName || 'Not provided'} ${memberInfo.lastName || 'Not provided'}`)
               .text(`Phone: ${memberInfo.phone || 'Not provided'}`)
               .text(`Email: ${memberInfo.email || 'Not provided'}`)
               .text(`Date of Birth: ${memberInfo.dateOfBirth || 'Not provided'}`);
            
            if (memberInfo.address) {
                doc.text(`Address: ${memberInfo.address}`);
                if (memberInfo.city && memberInfo.state && memberInfo.zip) {
                    doc.text(`Location: ${memberInfo.city}, ${memberInfo.state} ${memberInfo.zip}`);
                }
            }
            
            doc.moveDown(1);

            // Add product selections with proper data handling and validation
            if (productSelections && productSelections.length > 0) {
                doc.fontSize(16)
                   .font('Helvetica-Bold')
                   .text('SELECTED PRODUCTS');
                
                doc.moveDown(0.5);
                doc.fontSize(12)
                   .font('Helvetica');
                
                productSelections.forEach((product, index) => {
                    // Try multiple possible field names for product name
                    const productName = product.name || 
                                      product.productName || 
                                      product.title ||
                                      product.displayName ||
                                      `Product ${product.productId || index + 1}`;
                    
                    // Validate that we have a meaningful name
                    if (productName === 'Unknown Product' || !productName || productName.trim() === '') {
                        console.warn(`⚠️ PDF Generator - No valid product name found for product ${index + 1}:`, product);
                    }
                    
                    doc.text(`${index + 1}. ${productName}`);
                    
                    // If it's a bundle, list the included products
                    if (product.isBundle && product.bundleComponents && product.bundleComponents.length > 0) {
                        doc.moveDown(0.3);
                        doc.fontSize(11)
                           .font('Helvetica')
                           .text('   Includes:', { indent: 20 });
                        
                        product.bundleComponents.forEach((component, compIndex) => {
                            const componentName = component.IncludedProductName || component.name || `Component ${compIndex + 1}`;
                            doc.text(`   • ${componentName}`, { indent: 30 });
                        });
                        
                        doc.fontSize(12).font('Helvetica');
                        doc.moveDown(0.3);
                    }
                });
                
                doc.moveDown(1);
            } else {
                console.warn('⚠️ PDF Generator - No product selections provided');
            }

            // Add acknowledgements with proper data handling and validation
            if (acknowledgements && acknowledgements.length > 0) {
                doc.fontSize(16)
                   .font('Helvetica-Bold')
                   .text('PRODUCT ACKNOWLEDGEMENTS');
                
                doc.moveDown(0.5);
                doc.fontSize(12)
                   .font('Helvetica');
                
                // Handle different possible acknowledgement structures
                let acknowledgementsToProcess = acknowledgements;
                
                // If acknowledgements is an array of objects with nested acknowledgements arrays
                if (acknowledgements.length > 0 && acknowledgements[0].acknowledgements) {
                    console.log('🔍 Flattening nested acknowledgements structure');
                    acknowledgementsToProcess = acknowledgements.flatMap(item => item.acknowledgements || []);
                }
                
                console.log(`🔍 Processing ${acknowledgementsToProcess.length} acknowledgements for PDF...`);
                
                acknowledgementsToProcess.forEach((ack, index) => {
                    // Try multiple possible field names for question text
                    const questionText = ack.question || 
                                       ack.questionText || 
                                       ack.text ||
                                       ack.description ||
                                       ack.label ||
                                       `Question ${index + 1}`;
                    
                    // Only warn when the question couldn't be resolved; skip logging full text otherwise.
                    if (questionText === `Question ${index + 1}` || !questionText || questionText.trim() === '') {
                        console.warn(`⚠️ PDF Generator - No valid question text found for acknowledgement ${index + 1}, fields:`, Object.keys(ack));
                    }
                    
                    const response = ack.response;
                    
                    doc.fontSize(14)
                       .font('Helvetica-Bold')
                       .text(`${index + 1}. ${questionText}`);
                    
                    doc.moveDown(0.2);
                    
                    // Format response with checkmark and "Agreed" text
                    if (response === 'true' || response === true) {
                        doc.fontSize(12)
                           .font('Helvetica')
                           .text(`✓ Agreed`, { color: 'green' });
                    } else if (response === 'false' || response === false) {
                        doc.fontSize(12)
                           .font('Helvetica')
                           .text(`✗ Declined`, { color: 'red' });
                    } else if (response && response.trim()) {
                        // Custom response text
                        doc.fontSize(12)
                           .font('Helvetica')
                           .text(`Response: ${response}`);
                    } else {
                        doc.fontSize(12)
                           .font('Helvetica')
                           .text(`No response provided`, { color: 'gray' });
                    }
                    
                    doc.moveDown(0.5);
                });
                
                doc.moveDown(1);
            } else {
                console.warn('⚠️ PDF Generator - No acknowledgements provided');
            }

            // Add digital signature
            doc.fontSize(16)
               .font('Helvetica-Bold')
               .text('DIGITAL SIGNATURE');
            
            doc.moveDown(0.5);
            doc.fontSize(12)
               .font('Helvetica')
               .text('I acknowledge that I have read and understand the terms and conditions of the selected products.');
            
            doc.moveDown(1);
            
            if (digitalSignature) {
                doc.text('Digital Signature:')
                   .moveDown(0.5);
                
                // Check if it's a base64 data URL
                if (digitalSignature.startsWith('data:image/')) {
                    try {
                        // Extract base64 data from data URL
                        const base64Data = digitalSignature.split(',')[1];
                        const imageBuffer = Buffer.from(base64Data, 'base64');
                        
                        // Add the signature image
                        doc.image(imageBuffer, {
                            fit: [400, 100], // Width: 400px, Height: 100px
                            align: 'left'
                        });
                    } catch (error) {
                        console.warn('Failed to process signature image:', error.message);
                        doc.text('Signature: [Image processing failed]', { indent: 20 });
                    }
                } else {
                    // Handle typed signature (plain text)
                    doc.text(digitalSignature, { indent: 20 });
                }
            } else {
                doc.text('Digital Signature: [Not provided]');
            }
            
            doc.moveDown(1);
            
            // Add signature line with today's date
            const today = new Date().toLocaleDateString();
            doc.text('Signature: _________________________')
               .text(`Date: ${today}`);

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Generate PDF for decline coverage acknowledgment
 * @param {Object} data - Decline acknowledgment data
 * @param {Object} data.memberInfo - Member information
 * @param {Array} data.declineReasons - Selected decline reasons
 * @param {string} data.digitalSignature - Digital signature
 * @param {Date} data.signedDate - Date of signing
 * @param {string} data.linkToken - Enrollment link token
 * @returns {Promise<Buffer>} - PDF buffer
 */
async function generateDeclineAcknowledgmentPDF(data) {
    console.log('🚀 PDF Generator - Starting decline acknowledgment PDF generation...');
    return new Promise((resolve, reject) => {
        try {
            const PDFDocument = require('pdfkit');
            const doc = new PDFDocument({
                size: 'A4',
                margins: {
                    top: 50,
                    bottom: 50,
                    left: 50,
                    right: 50
                }
            });

            const chunks = [];
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => {
                try {
                    const result = Buffer.concat(chunks);
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            doc.on('error', reject);

            // Header
            doc.fontSize(20)
               .font('Helvetica-Bold')
               .text('ACKNOWLEDGEMENTS', { align: 'center' });
            
            doc.moveDown(0.5);
            doc.fontSize(12)
               .font('Helvetica')
               .text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
            
            doc.moveDown(2);

            // Decline Company Offered Benefits - Acknowledgment Section
            doc.fontSize(16)
               .font('Helvetica-Bold')
               .text('Decline Company Offered Benefits - Acknowledgment');
            
            doc.moveDown(0.5);
            doc.fontSize(12)
               .font('Helvetica')
               .text('I, the undersigned, have been offered participation in the company-sponsored healthcare benefits plan. After reviewing the plan details and understanding my eligibility, I have decided to decline participation in the healthcare benefits plan.');
            
            doc.moveDown(1.5);

            // Reason for Declining Section
            doc.fontSize(14)
               .font('Helvetica-Bold')
               .text('Reason for Declining *');
            
            doc.moveDown(0.5);
            doc.fontSize(12)
               .font('Helvetica');

            // Map decline reasons to display text
            const reasonMap = {
                'coverage-through-spouse': 'Coverage through spouse/partner',
                'coverage-through-parents': 'Coverage through parents',
                'coverage-through-other': 'Coverage through other plan',
                'cost-of-plan': 'Cost of plan',
                'other': 'Other'
            };

            data.declineReasons.forEach((reason, index) => {
                const displayText = reasonMap[reason] || reason;
                doc.text(`✓ ${displayText}`);
            });

            doc.moveDown(1.5);

            // Decline Signature Section
            doc.fontSize(14)
               .font('Helvetica-Bold')
               .text('Decline Signature *');
            
            doc.moveDown(0.5);
            doc.fontSize(12)
               .font('Helvetica')
               .text('Digital Signature:');
            
            doc.moveDown(0.5);
            
            if (data.digitalSignature) {
                // Check if it's a base64 data URL
                if (data.digitalSignature.startsWith('data:image/')) {
                    try {
                        // Extract base64 data from data URL
                        const base64Data = data.digitalSignature.split(',')[1];
                        const imageBuffer = Buffer.from(base64Data, 'base64');
                        
                        // Add the signature image
                        doc.image(imageBuffer, {
                            fit: [400, 100], // Width: 400px, Height: 100px
                            align: 'left'
                        });
                    } catch (error) {
                        console.warn('Failed to process signature image:', error.message);
                        doc.text('Signature: [Image processing failed]', { indent: 20 });
                    }
                } else {
                    // Handle typed signature (plain text)
                    doc.text(data.digitalSignature, { indent: 20 });
                }
            } else {
                doc.text('Digital Signature: [Not provided]');
            }

            doc.moveDown(1);

            // Member Information
            doc.fontSize(14)
               .font('Helvetica-Bold')
               .text('Member Information');
            
            doc.moveDown(0.5);
            doc.fontSize(12)
               .font('Helvetica')
               .text(`Name: ${data.memberInfo.firstName} ${data.memberInfo.lastName}`)
               .text(`Email: ${data.memberInfo.email || 'Not provided'}`)
               .text(`Date: ${data.signedDate.toLocaleDateString()}`)
               .text(`Enrollment Link: ${data.linkToken}`);

            doc.moveDown(1);

            // Signature line
            doc.text('Signature: _________________________')
               .text(`Date: ${data.signedDate.toLocaleDateString()}`);

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

module.exports = { generateAgreementsPDF, generateDeclineAcknowledgmentPDF };