import { CheckCircle, MessageCircle, X } from 'lucide-react';
import React, { useState, useEffect, useRef } from 'react';

interface AskAgentQuestionModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentName: string;
  currentFirstName?: string;
  currentLastName?: string;
  currentEmail?: string;
  currentPhone?: string;
  onSubmit: (question: string, contactInfo: { firstName?: string; lastName?: string; email?: string; phone?: string }) => Promise<{ success: boolean; message?: string }>;
}

const AskAgentQuestionModal: React.FC<AskAgentQuestionModalProps> = ({
  isOpen,
  onClose,
  agentName,
  currentFirstName,
  currentLastName,
  currentEmail,
  currentPhone,
  onSubmit
}) => {
  const [question, setQuestion] = useState('');
  const [firstName, setFirstName] = useState(currentFirstName || '');
  const [lastName, setLastName] = useState(currentLastName || '');
  const [email, setEmail] = useState(currentEmail || '');
  const [phone, setPhone] = useState(currentPhone || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const previousIsOpenRef = useRef(false);

  // Check if we need to collect name
  const needsName = !currentFirstName || !currentLastName;
  // Check if we need to collect contact info
  const needsContactInfo = !currentEmail && !currentPhone;

  // Update fields only when modal first opens (not when props change after submission)
  useEffect(() => {
    // Only reset when modal transitions from closed to open
    if (isOpen && !previousIsOpenRef.current) {
      setFirstName(currentFirstName || '');
      setLastName(currentLastName || '');
      setEmail(currentEmail || '');
      setPhone(currentPhone || '');
      setQuestion('');
      setError(null);
      setSubmitted(false);
    }
    previousIsOpenRef.current = isOpen;
  }, [isOpen, currentFirstName, currentLastName, currentEmail, currentPhone]);

  const handleSubmit = async () => {
    if (!question.trim()) {
      setError('Please enter your question');
      return;
    }

    // Validate name if needed
    if (needsName) {
      if (!firstName.trim()) {
        setError('Please enter your first name');
        return;
      }
      if (!lastName.trim()) {
        setError('Please enter your last name');
        return;
      }
    }

    // Validate contact info if needed
    if (needsContactInfo) {
      if (!email.trim() && !phone.trim()) {
        setError('Please provide at least an email address or phone number so the agent can respond to you.');
        return;
      }

      // Basic email validation if email is provided
      if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        setError('Please enter a valid email address');
        return;
      }

      // Basic phone validation if phone is provided (at least 10 digits)
      if (phone.trim() && phone.replace(/\D/g, '').length < 10) {
        setError('Please enter a valid phone number');
        return;
      }
    }

    try {
      setLoading(true);
      setError(null);

      const contactInfo = {
        firstName: firstName.trim() || currentFirstName || undefined,
        lastName: lastName.trim() || currentLastName || undefined,
        email: email.trim() || currentEmail || undefined,
        phone: phone.trim() || currentPhone || undefined
      };

      const result = await onSubmit(question.trim(), contactInfo);

      if (result.success) {
        setSubmitted(true);
        setQuestion('');
        setFirstName('');
        setLastName('');
        setEmail('');
        setPhone('');
      } else {
        setError(result.message || 'Failed to send your question. Please try again.');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to send your question. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setQuestion('');
    setFirstName(currentFirstName || '');
    setLastName(currentLastName || '');
    setEmail(currentEmail || '');
    setPhone(currentPhone || '');
    setError(null);
    setSubmitted(false);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center">
            <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center mr-3">
              <MessageCircle className="h-5 w-5 text-oe-primary" />
            </div>
            <h2 className="text-xl font-semibold text-gray-900">Ask {agentName} a Question</h2>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {submitted ? (
            // Success State
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 bg-green-50 rounded-full mb-4">
                <CheckCircle className="h-8 w-8 text-green-600" />
              </div>
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                Question Sent!
              </h3>
              <p className="text-gray-600 mb-6">
                Your question has been sent to {agentName}. You can expect to hear back from them soon via phone or email.
              </p>
              <button
                onClick={handleClose}
                className="w-full bg-oe-primary text-white py-3 px-6 rounded-lg hover:bg-oe-primary-dark transition-colors font-medium"
              >
                Close
              </button>
            </div>
          ) : (
            // Form State
            <>
              {/* Name Section - Show if we need to collect it */}
              {needsName && (
                <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm font-medium text-gray-900 mb-3">
                    Your Name <span className="text-red-500">*</span>
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        First Name
                      </label>
                      <input
                        type="text"
                        value={firstName}
                        onChange={(e) => {
                          setFirstName(e.target.value);
                          setError(null);
                        }}
                        placeholder="First Name"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        autoFocus={needsName}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Last Name
                      </label>
                      <input
                        type="text"
                        value={lastName}
                        onChange={(e) => {
                          setLastName(e.target.value);
                          setError(null);
                        }}
                        placeholder="Last Name"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Your Question <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={question}
                  onChange={(e) => {
                    setQuestion(e.target.value);
                    setError(null);
                  }}
                  placeholder="Type your question here..."
                  rows={6}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary resize-none"
                  autoFocus={!needsName}
                />
              </div>

              {/* Contact Info Section - Show if we need to collect it */}
              {needsContactInfo && (
                <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm font-medium text-gray-900 mb-3">
                    Contact Information <span className="text-red-500">*</span>
                  </p>
                  <p className="text-xs text-gray-600 mb-4">
                    Please provide at least one way for {agentName} to reach you:
                  </p>
                  
                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Email Address
                      </label>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          setError(null);
                        }}
                        placeholder="your.email@example.com"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Phone Number
                      </label>
                      <input
                        type="tel"
                        value={phone}
                        onChange={(e) => {
                          setPhone(e.target.value);
                          setError(null);
                        }}
                        placeholder="(555) 123-4567"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Show current contact info if we have it */}
              {!needsContactInfo && (
                <div className="mb-6 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                  <p className="text-xs text-gray-600">
                    {agentName} will respond to you at {currentEmail && <span className="font-medium">{currentEmail}</span>}
                    {currentEmail && currentPhone && ' or '}
                    {currentPhone && <span className="font-medium">{currentPhone}</span>}
                  </p>
                </div>
              )}

              {/* Show current name if we have it */}
              {!needsName && (currentFirstName || currentLastName) && (
                <div className="mb-6 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                  <p className="text-xs text-gray-600">
                    Sending as: <span className="font-medium">{currentFirstName} {currentLastName}</span>
                  </p>
                </div>
              )}

              {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
                  {error}
                </div>
              )}

              <div className="flex space-x-3">
                <button
                  onClick={handleClose}
                  className="flex-1 border border-gray-300 text-gray-700 py-3 px-6 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={loading || !question.trim() || (needsName && (!firstName.trim() || !lastName.trim())) || (needsContactInfo && !email.trim() && !phone.trim())}
                  className="flex-1 bg-oe-primary text-white py-3 px-6 rounded-lg hover:bg-oe-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                >
                  {loading ? 'Sending...' : 'Send Question'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default AskAgentQuestionModal;

