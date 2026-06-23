import React, { useState, useRef, useEffect } from 'react';
import { Key, Eye, EyeOff, CheckCircle, XCircle, ChevronRight, ChevronLeft } from 'lucide-react';

interface PasswordInfo {
  password: string;
  confirmPassword: string;
}

interface PasswordStepProps {
  data: PasswordInfo;
  onChange: (data: PasswordInfo) => void;
  onComplete: () => void;
  onPrev: () => void;
  disabled?: boolean;
}

const PasswordStep: React.FC<PasswordStepProps> = ({
  data,
  onChange,
  onComplete,
  onPrev,
  disabled = false
}) => {
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on password input when component mounts
  useEffect(() => {
    if (passwordInputRef.current) {
      setTimeout(() => {
        if (passwordInputRef.current) {
          passwordInputRef.current.focus();
          console.log('🎯 Focused password input');
        }
      }, 100);
    }
  }, []);

  const handleChange = (field: keyof PasswordInfo, value: string) => {
    onChange({
      ...data,
      [field]: value
    });
  };

  const isPasswordValid = (password: string): boolean => {
    return password.length >= 8 &&
           /[A-Z]/.test(password) &&
           /[a-z]/.test(password) &&
           /[0-9]/.test(password) &&
           /[^A-Za-z0-9]/.test(password);
  };

  const passwordsMatch = data.password === data.confirmPassword;
  const isFormValid = isPasswordValid(data.password) && passwordsMatch && data.password.length > 0;

  const passwordRequirements = [
    { text: 'At least 8 characters', met: data.password.length >= 8 },
    { text: 'One uppercase letter', met: /[A-Z]/.test(data.password) },
    { text: 'One lowercase letter', met: /[a-z]/.test(data.password) },
    { text: 'One number', met: /[0-9]/.test(data.password) },
    { text: 'One special character (not a letter or number)', met: /[^A-Za-z0-9]/.test(data.password) },
    { text: 'Passwords match', met: passwordsMatch && data.confirmPassword.length > 0 }
  ];

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isFormValid && !disabled) {
      e.preventDefault();
      onComplete();
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="bg-white rounded-lg border border-gray-200">
        {/* Header */}
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center mb-2">
            <Key className="w-6 h-6 text-[#1f8dbf] mr-3" />
            <h2 className="text-2xl font-semibold text-gray-900">Create Password</h2>
          </div>
          <p className="text-gray-600">
            Set up a secure password for your agent account. You'll use this to log in to the system.
          </p>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Password Field */}
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Password *
            </label>
            <div className="relative">
              <input
                ref={passwordInputRef}
                type={showPassword ? 'text' : 'password'}
                id="password"
                value={data.password}
                onChange={(e) => handleChange('password', e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                placeholder="Enter your password"
                required
                disabled={disabled}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
                disabled={disabled}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {/* Confirm Password Field */}
          <div>
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
              Confirm Password *
            </label>
            <div className="relative">
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                id="confirmPassword"
                value={data.confirmPassword}
                onChange={(e) => handleChange('confirmPassword', e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                placeholder="Confirm your password"
                required
                disabled={disabled}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
                disabled={disabled}
              >
                {showConfirmPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {/* Password Requirements */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-900 mb-3">Password Requirements</h3>
            <div className="space-y-2">
              {passwordRequirements.map((requirement, index) => (
                <div key={index} className="flex items-center">
                  {requirement.met ? (
                    <CheckCircle className="h-4 w-4 text-green-500 mr-2" />
                  ) : (
                    <XCircle className="h-4 w-4 text-gray-400 mr-2" />
                  )}
                  <span className={`text-sm ${requirement.met ? 'text-green-700' : 'text-gray-600'}`}>
                    {requirement.text}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Security Notice */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex">
              <Key className="h-5 w-5 text-blue-500 mr-2 mt-0.5" />
              <div className="text-sm text-oe-primary-dark">
                <p className="font-medium mb-1">Security Notice</p>
                <p>
                  Your password is encrypted and stored securely. We recommend using a unique password 
                  that you don't use for other accounts.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-between">
          <button
            onClick={onPrev}
            disabled={disabled}
            className="flex items-center px-4 py-2 text-gray-600 hover:text-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back
          </button>
          
          <button
            onClick={onComplete}
            disabled={!isFormValid || disabled}
            className={`flex items-center px-6 py-2 rounded-lg font-medium transition-colors ${
              isFormValid && !disabled
                ? 'bg-[#1f8dbf] text-white hover:bg-[#1a7ba8]'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            Complete Onboarding
            <ChevronRight className="w-4 h-4 ml-1" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default PasswordStep;
