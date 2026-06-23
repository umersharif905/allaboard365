// src/constants/branding.ts
// Default branding configuration (AllAboard365)

export const OPEN_ENROLL_BRANDING = {
  name: "AllAboard365",
  logoUrl: "/images/branding/allaboard365/allaboard365-logo-primary-transparent.png",
  logoAlt: "AllAboard365 Logo",
  primaryColor: "#1f6db0",
  secondaryColor: "#0f4c75", 
  backgroundUrl: "/api/placeholder/1920/1080",
  
  // Additional branding options
  tagline: "Insurance enrollment made simple",
  supportEmail: "improve@allaboard365.com",
  companyUrl: "https://allaboard365.com"
} as const;

// Export individual properties for convenience
export const { name, logoUrl, logoAlt, primaryColor, secondaryColor } = OPEN_ENROLL_BRANDING;
