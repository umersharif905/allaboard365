// Centralized password requirements for the application
// Location: backend/constants/password-requirements.js
// Used by backend API validation

/**
 * Password Requirements Configuration
 * HIPAA compliant password requirements
 */
// Special = any character that is not an ASCII letter or digit (punctuation, symbols, space, unicode, etc.)
const REGEX_MIN_10 = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{10,}$/;
const REGEX_MIN_8 = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

const PASSWORD_REQUIREMENTS = {
  // Minimum password length
  minLength: 10,
  
  // Regex pattern for password validation (10+ chars; any non-alphanumeric counts as special)
  regexPattern: REGEX_MIN_10,
  
  // Error messages
  messages: {
    minLength: 'Password must be at least 10 characters long',
    uppercase: 'Password must contain at least one uppercase letter',
    lowercase: 'Password must contain at least one lowercase letter',
    number: 'Password must contain at least one number',
    specialChar: 'Password must contain at least one special character (any character that is not a letter or number)',
    match: 'Passwords do not match',
    full: 'Password must be at least 10 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character (any non-letter, non-digit character)',
    fullMin8: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character (any non-letter, non-digit character)'
  },
  
  // Help text for UI
  helpText: 'Must be at least 10 characters with uppercase, lowercase, number, and special character'
};

/**
 * Validate password against requirements
 * @param {string} password - Password to validate
 * @returns {Object} Object with isValid boolean and error message if invalid
 */
const validatePassword = (password) => {
  if (!password || password.length < PASSWORD_REQUIREMENTS.minLength) {
    return { isValid: false, error: PASSWORD_REQUIREMENTS.messages.minLength };
  }
  
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecialChar = /[^A-Za-z0-9]/.test(password);
  
  if (!hasUpperCase) {
    return { isValid: false, error: PASSWORD_REQUIREMENTS.messages.uppercase };
  }
  if (!hasLowerCase) {
    return { isValid: false, error: PASSWORD_REQUIREMENTS.messages.lowercase };
  }
  if (!hasNumber) {
    return { isValid: false, error: PASSWORD_REQUIREMENTS.messages.number };
  }
  if (!hasSpecialChar) {
    return { isValid: false, error: PASSWORD_REQUIREMENTS.messages.specialChar };
  }
  
  return { isValid: true, error: null };
};

/**
 * Get password regex pattern
 * @returns {RegExp} Regex pattern
 */
const getPasswordRegex = () => {
  return PASSWORD_REQUIREMENTS.regexPattern;
};

const getPasswordRegexMin8 = () => REGEX_MIN_8;

/**
 * Get password validation error message
 * @returns {string} Error message string
 */
const getPasswordErrorMessage = () => {
  return PASSWORD_REQUIREMENTS.messages.full;
};

module.exports = {
  PASSWORD_REQUIREMENTS,
  validatePassword,
  getPasswordRegex,
  getPasswordRegexMin8,
  getPasswordErrorMessage
};

