import { AlertCircle, CheckCircle, ChevronLeft, ExternalLink, FileText, PenTool } from 'lucide-react';
import React from 'react';
import SignaturePad from '../enrollment-wizard/SignaturePad';

interface ContractInfo {
  digitalSignature: string;
  signatureDate: string;
  contractAccepted: boolean;
}

export interface AgentAgreementDocument {
  FileId: string;
  FileName: string;
  FilePath: string;
  FileSize: number;
  MimeType: string;
  Description: string;
  CreatedDate: string;
}

export interface ContractStepProps {
  data: ContractInfo;
  onChange: (data: ContractInfo) => void;
  onComplete: () => void;
  onPrev: () => void;
  contractUrl?: string;
  contractFileName?: string;
  agentAgreementDocuments?: AgentAgreementDocument[];
  disabled?: boolean;
  error?: string | null;
}

const ContractStep: React.FC<ContractStepProps> = ({
  data,
  onChange,
  onComplete,
  onPrev,
  contractUrl,
  contractFileName,
  agentAgreementDocuments = [],
  disabled = false,
  error = null
}) => {
  // Calculate validation state directly in render
  const hasSignature = data.digitalSignature && 
    (data.digitalSignature.length > 0) && 
    (data.digitalSignature !== '') &&
    (data.digitalSignature !== 'null');
  
  const isAccepted = data.contractAccepted;
  
  const isValid = isAccepted && hasSignature;

  const handleChange = (field: keyof ContractInfo, value: string | boolean) => {
    onChange({
      ...data,
      [field]: value
    });
  };


  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onComplete();
  };

  const isFormValid = () => {
    // Check if signature exists and is not empty
    const hasSignature = data.digitalSignature && 
      (data.digitalSignature.length > 0) && 
      (data.digitalSignature !== '') &&
      (data.digitalSignature !== 'null');
    
    // Check if contract is accepted
    const isAccepted = data.contractAccepted;
    
    console.log('🔍 Form validation:', {
      digitalSignature: data.digitalSignature ? `${data.digitalSignature.substring(0, 50)}...` : 'null',
      digitalSignatureLength: data.digitalSignature?.length || 0,
      contractAccepted: data.contractAccepted,
      hasSignature,
      isAccepted,
      isValid: isAccepted && hasSignature
    });
    
    return isAccepted && hasSignature;
  };


  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Contract & Signature</h2>
        <p className="text-gray-600">Review and sign the agent contract.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">

        {/* Contract Review */}
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
            <FileText className="w-5 h-5 mr-2 text-[#1f8dbf]" />
            Agent Agreement Documents
          </h3>
          
          {agentAgreementDocuments && agentAgreementDocuments.length > 0 ? (
            <div className="space-y-3">
              {agentAgreementDocuments.map((doc) => (
                <div key={doc.FileId} className="border border-gray-200 rounded-lg p-4 hover:border-[#1f8dbf] transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center">
                      <div className="w-10 h-10 bg-red-100 rounded-lg flex items-center justify-center mr-3">
                        <span className="text-red-600 text-xs font-semibold">
                          {doc.MimeType === 'application/pdf' ? 'PDF' : 'DOC'}
                        </span>
                      </div>
                      <div>
                        <div className="font-medium text-gray-900">{doc.FileName}</div>
                        <div className="text-sm text-gray-500">{doc.Description || 'Agent Agreement Document'}</div>
                        <div className="text-xs text-gray-400">
                          {(doc.FileSize / 1024).toFixed(1)} KB
                        </div>
                      </div>
                    </div>
                    <a
                      href={doc.FilePath}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-[#1f8dbf] rounded-lg hover:bg-[#1a7ba8] transition-colors"
                    >
                      <ExternalLink className="w-4 h-4 mr-2" />
                      View & Download
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
              <div className="text-center">
                <FileText className="w-12 h-12 text-gray-400 mx-auto mb-2" />
                <p className="text-gray-500">No agreement documents available</p>
              </div>
            </div>
          )}
        </div>

        {/* Contract Acceptance */}
        <div>
          <label className="flex items-start">
            <input
              type="checkbox"
              checked={data.contractAccepted}
              onChange={(e) => handleChange('contractAccepted', e.target.checked)}
              className="mt-1 rounded border-gray-300 text-[#1f8dbf] focus:ring-[#1f8dbf]"
              disabled={disabled}
            />
            <span className="ml-3 text-sm text-gray-700">
              I have read and agree to the terms and conditions of the agent contract. 
              I understand that by signing below, I am entering into a legally binding 
              agreement with the company.
            </span>
          </label>
        </div>

        {/* Digital Signature */}
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
            <PenTool className="w-5 h-5 mr-2 text-[#1f8dbf]" />
            Digital Signature
          </h3>
          
          <div className="border border-gray-200 rounded-lg p-6 bg-white">
            <SignaturePad
              onSignatureChange={(signature) => {
                if (signature) {
                  // Update both fields at once to avoid state batching issues
                  const newData = {
                    ...data,
                    digitalSignature: signature,
                    signatureDate: new Date().toISOString()
                  };
                  onChange(newData);
                } else {
                  // Clear both fields at once
                  const newData = {
                    ...data,
                    digitalSignature: '',
                    signatureDate: ''
                  };
                  onChange(newData);
                }
              }}
              isRequired={true}
              label="Your Digital Signature"
              placeholder="Click and drag to sign, or type your name below"
            />
          </div>
        </div>


        {/* Summary */}
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <CheckCircle className="h-5 w-5 text-green-400" />
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-green-800">Ready to Complete</h3>
              <div className="mt-2 text-sm text-green-700">
                <p>
                  Once you submit this form, your agent account will be created and you'll 
                  receive login credentials via email. You'll be able to access the agent 
                  portal immediately.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
            <div className="flex items-start">
              <AlertCircle className="w-5 h-5 text-red-600 mr-3 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="text-sm font-semibold text-red-900 mb-1">Unable to Complete Onboarding</h4>
                <p className="text-sm text-red-800">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Validation Status */}
        <div className="bg-gray-50 rounded-lg p-4 mb-4">
          <h4 className="text-sm font-medium text-gray-900 mb-2">Form Status</h4>
          <div className="space-y-1">
            <div className="flex items-center text-sm">
              {data.contractAccepted ? (
                <CheckCircle className="w-4 h-4 text-green-600 mr-2" />
              ) : (
                <div className="w-4 h-4 border-2 border-gray-300 rounded-full mr-2" />
              )}
              <span className={data.contractAccepted ? "text-green-600" : "text-gray-500"}>
                Contract Agreement {data.contractAccepted ? "Accepted" : "Required"}
              </span>
            </div>
            <div className="flex items-center text-sm">
              {data.digitalSignature && data.digitalSignature.length > 0 && data.digitalSignature !== 'null' ? (
                <CheckCircle className="w-4 h-4 text-green-600 mr-2" />
              ) : (
                <div className="w-4 h-4 border-2 border-gray-300 rounded-full mr-2" />
              )}
              <span className={data.digitalSignature && data.digitalSignature.length > 0 && data.digitalSignature !== 'null' ? "text-green-600" : "text-gray-500"}>
                Digital Signature {data.digitalSignature && data.digitalSignature.length > 0 && data.digitalSignature !== 'null' ? "Provided" : "Required"}
              </span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-gray-200">
          <button
            type="button"
            onClick={onPrev}
            disabled={disabled}
            className="inline-flex items-center px-6 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
          >
            <ChevronLeft className="w-4 h-4 mr-2" />
            Back to Banking Information
          </button>
          
          <button
            type="submit"
            disabled={!isValid || disabled}
            className="inline-flex items-center px-6 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#1a7ba8] transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
          >
            <CheckCircle className="w-4 h-4 mr-2" />
            Complete Onboarding
          </button>
        </div>
      </form>
    </div>
  );
};


export default ContractStep;


