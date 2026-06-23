import { CheckCircle, CreditCard, Download, X } from 'lucide-react';
import React from 'react';

interface PaymentReceiptData {
  transactionId: string;
  amount: number;
  processingFee?: number;
  totalAmount?: number;
  status: string;
  paymentDate: string;
  paymentMethod: {
    type: string;
    last4: string;
    brand: string;
  };
  memberInfo: {
    name: string;
    email: string;
  };
  tenantName: string;
  products: Array<{
    productName: string;
    amount: number;
  }>;
  agreementsPdfUrl?: string | null;
}

interface PaymentReceiptModalProps {
  isOpen: boolean;
  onClose: () => void;
  receiptData: PaymentReceiptData | null;
  onContinue: () => void;
}

const PaymentReceiptModal: React.FC<PaymentReceiptModalProps> = ({ 
  isOpen, 
  onClose, 
  receiptData,
  onContinue 
}) => {
  if (!isOpen || !receiptData) return null;

  const handlePrint = () => {
    window.print();
  };

  const handleDownload = () => {
    // Create a printable receipt HTML for PDF generation
    const receiptHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Payment Receipt - ${receiptData.transactionId}</title>
          <style>
            @media print {
              body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            }
            body { 
              font-family: Arial, sans-serif; 
              max-width: 800px; 
              margin: 0 auto; 
              padding: 40px; 
              background: white;
            }
            .header { 
              text-align: center; 
              border-bottom: 3px solid #2563eb; 
              padding-bottom: 20px; 
              margin-bottom: 30px; 
            }
            .header h1 { color: #1e40af; margin: 0 0 10px 0; }
            .section { margin-bottom: 25px; padding: 15px; background: #f9fafb; border-radius: 8px; }
            .section h3 { color: #1f2937; margin: 0 0 15px 0; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
            .row { display: flex; justify-between; padding: 8px 0; }
            .label { font-weight: 600; color: #4b5563; }
            .value { color: #111827; }
            .line-item { display: flex; justify-between; padding: 12px 0; border-bottom: 1px solid #e5e7eb; }
            .total-section { background: #dbeafe; padding: 15px; border-radius: 8px; margin-top: 10px; }
            .total { font-size: 20px; font-weight: bold; display: flex; justify-between; align-items: center; }
            .total .amount { color: #2563eb; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>Payment Receipt</h1>
            <p style="font-size: 18px; color: #4b5563; margin: 0;">${receiptData.tenantName}</p>
          </div>
          
          <div class="section">
            <h3>Transaction Details</h3>
            <div class="row">
              <span class="label">Transaction ID: </span>
              <span class="value">${receiptData.transactionId || 'N/A'}</span>
            </div>
            <div class="row">
              <span class="label">Date: </span>
              <span class="value">${new Date(receiptData.paymentDate).toLocaleString()}</span>
            </div>
            <div class="row">
              <span class="label">Status: </span>
              <span class="value" style="color: #16a34a; font-weight: 600;">APPROVED</span>
            </div>
          </div>
          
          <div class="section">
            <h3>Member Information</h3>
            <div class="row">
              <span class="label">Name: </span>
              <span class="value">${receiptData.memberInfo.name}</span>
            </div>
            <div class="row">
              <span class="label">Email: </span>
              <span class="value">${receiptData.memberInfo.email}</span>
            </div>
            <div class="row">
              <span class="label">Company: </span>
              <span class="value">${receiptData.tenantName}</span>
            </div>
          </div>
          
          <div class="section">
            <h3>Payment Method</h3>
            <div class="row">
              <span class="label">Type: </span>
              <span class="value">${receiptData.paymentMethod.brand}</span>
            </div>
            <div class="row">
              <span class="label">Card Number: </span>
              <span class="value">****${receiptData.paymentMethod.last4}</span>
            </div>
          </div>
          
          <div class="section">
            <h3>Products Enrolled</h3>
            ${receiptData.products.map(product => `
              <div class="line-item">
                <span class="label">${product.productName}</span>
                <span class="value">$${product.amount.toFixed(2)}/mo</span>
              </div>
            `).join('')}
            <div style="margin-top: 10px; padding: 10px 0; border-top: 1px solid #e5e7eb;">
              <div class="row">
                <span class="label">Subtotal (Monthly Premium):</span>
                <span class="value">$${receiptData.amount.toFixed(2)}</span>
              </div>
              ${receiptData.processingFee && receiptData.processingFee > 0 ? `
                <div class="row">
                  <span class="label">Processing Fee:</span>
                  <span class="value">$${receiptData.processingFee.toFixed(2)}</span>
                </div>
              ` : ''}
            </div>
            <div class="total-section">
              <div class="total">
                <span>Total Charged: </span>
                <span class="amount">$${(receiptData.totalAmount || receiptData.amount).toFixed(2)}</span>
              </div>
            </div>
          </div>
          
          <div style="text-align: center; margin-top: 40px; padding-top: 20px; border-top: 2px solid #e5e7eb; color: #6b7280; font-size: 12px;">
            <p>Thank you for your enrollment!</p>
            <p>If you have questions, please contact your agent or our support team.</p>
          </div>
        </body>
      </html>
    `;
    
    // Open the receipt in a new window and trigger print dialog for PDF export
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(receiptHtml);
      printWindow.document.close();
      setTimeout(() => {
        printWindow.print();
      }, 250);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center">
            <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center mr-3">
              <CheckCircle className="h-6 w-6 text-green-600" />
            </div>
            <h2 className="text-2xl font-semibold text-gray-900">Payment Receipt</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Receipt Content */}
        <div className="px-6 py-6">
          {/* Success Message */}
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
            <div className="flex items-start">
              <CheckCircle className="h-5 w-5 text-green-600 mr-3 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="text-lg font-semibold text-green-900 mb-1">
                  Payment Successful!
                </h3>
                <p className="text-sm text-green-800">
                  Your enrollment has been processed and payment has been collected.
                </p>
              </div>
            </div>
          </div>

          {/* Transaction Details */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Transaction Details</h3>
            <div className="bg-gray-50 rounded-lg p-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-600">Transaction ID: </span>
                <span className="font-mono text-sm text-gray-900">{receiptData.transactionId || 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Date: </span>
                <span className="text-gray-900">
                  {new Date(receiptData.paymentDate).toLocaleString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Status: </span>
                <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                  APPROVED
                </span>
              </div>
            </div>
          </div>

          {/* Member Information */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Member Information</h3>
            <div className="bg-gray-50 rounded-lg p-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-600">Name: </span>
                <span className="text-gray-900">{receiptData.memberInfo.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Email: </span>
                <span className="text-gray-900">{receiptData.memberInfo.email}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Company: </span>
                <span className="text-gray-900">{receiptData.tenantName}</span>
              </div>
            </div>
          </div>

          {/* Payment Method */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Payment Method</h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center">
                <CreditCard className="h-5 w-5 text-gray-600 mr-3" />
                <div className="flex-1">
                  <div className="flex justify-between items-center">
                    <span className="text-gray-900 font-medium">
                      {receiptData.paymentMethod.type === 'Card' ? receiptData.paymentMethod.brand : 'Bank Account'}
                    </span>
                    <span className="text-gray-600">****{receiptData.paymentMethod.last4}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Products Enrolled */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Products Enrolled</h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="space-y-3">
                {receiptData.products.map((product, index) => (
                  <div key={index} className="flex justify-between items-center">
                    <span className="text-gray-700">{product.productName}</span>
                    <span className="text-gray-900 font-medium">${product.amount.toFixed(2)}/mo</span>
                  </div>
                ))}
                
                {/* Subtotal and Processing Fee */}
                <div className="pt-3 border-t border-gray-300 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-gray-700">Subtotal (Monthly Premium):</span>
                    <span className="text-gray-900 font-medium">
                      ${receiptData.amount.toFixed(2)}
                    </span>
                  </div>
                  {receiptData.processingFee && receiptData.processingFee > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-gray-700">Processing Fee:</span>
                      <span className="text-gray-900 font-medium">
                        ${receiptData.processingFee.toFixed(2)}
                      </span>
                    </div>
                  )}
                </div>
                
                {/* Total */}
                <div className="pt-3 border-t-2 border-gray-300">
                  <div className="flex justify-between items-center">
                    <span className="text-lg font-semibold text-gray-900">Total Charged Today: </span>
                    <span className="text-2xl font-bold text-oe-primary">
                      ${(receiptData.totalAmount || receiptData.amount).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 px-6 py-4">
          <div className="flex flex-col sm:flex-row gap-3 justify-between items-center">
            <div className="flex gap-3">
              <button
                onClick={handleDownload}
                className="flex items-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <Download className="h-4 w-4 mr-2" />
                Download Receipt
              </button>
              
              {receiptData.agreementsPdfUrl && (
                <a
                  href={receiptData.agreementsPdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download Signed Agreements
                </a>
              )}
            </div>
            
            <button
              onClick={() => {
                onClose();
                onContinue();
              }}
              className="btn-primary px-6 py-2 w-full sm:w-auto"
            >
              Continue to Password Setup
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PaymentReceiptModal;

