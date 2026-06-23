/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Open-Enroll Corporate Colors - Using CSS Variables for Dynamic Branding
        // These values are defaults that get overridden by BrandingContext at runtime
        'oe-primary': 'var(--oe-primary, #1f8dbf)',      // Sky Blue (Primary) - Dynamic via CSS var
        'oe-light': 'var(--oe-primary-light, #d6eef8)',  // Light Sky (Light Accent) - Dynamic via CSS var
        'oe-dark': 'var(--oe-primary-dark, #125e82)',    // Midnight Blue (Dark Accent) - Dynamic via CSS var
        'oe-neutral-light': 'var(--oe-neutral-light, #f7f9fa)', // Snow White (Neutral Light)
        'oe-neutral-dark': 'var(--oe-neutral-dark, #2b2b2b)',  // Slate Gray (Neutral Dark)
        'oe-success': 'var(--oe-success, #4caf50)',     // Green Light (Success)
        'oe-error': 'var(--oe-error, #e53935)',         // Alert Red (Error)
        'oe-warning': 'var(--oe-warning, #ffb300)',     // Gold Amber (Warning)
        
        // Semantic color mappings for component flexibility
        // These use CSS variables for dynamic branding support
        primary: {
          50: 'var(--oe-primary-light, #e8f4f9)',
          100: 'var(--oe-primary-light, #d6eef8)',
          200: '#a8d8ed',
          300: '#7ac1e1',
          400: '#4caad5',
          500: 'var(--oe-primary, #1f8dbf)',  // Primary - Dynamic via CSS var
          600: '#1a7299',
          700: '#156073',
          800: 'var(--oe-primary-dark, #125e82)',  // Dark - Dynamic via CSS var
          900: '#0d3e4d',
        },
        
        // Additional color variations for more flexibility
        'oe': {
          'primary': 'var(--oe-primary, #1f8dbf)',
          'primary-light': 'var(--oe-primary-light, #d6eef8)', 
          'primary-dark': 'var(--oe-primary-dark, #125e82)',
          'secondary': 'var(--oe-secondary, #6366F1)',  // Accent Indigo (fallback for brands without secondary)
          'light': 'var(--oe-primary-light, #d6eef8)',
          'dark': 'var(--oe-primary-dark, #125e82)',
          'neutral-light': 'var(--oe-neutral-light, #f7f9fa)',
          'neutral-dark': 'var(--oe-neutral-dark, #2b2b2b)',
          'success': 'var(--oe-success, #4caf50)',
          'error': 'var(--oe-error, #e53935)',
          'warning': 'var(--oe-warning, #ffb300)'
        }
      },
      
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      
      boxShadow: {
        'soft': '0 2px 4px rgba(0,0,0,0.06)',
        'medium': '0 4px 6px rgba(0,0,0,0.07)',
        'strong': '0 10px 15px rgba(0,0,0,0.1)',
        // Add shadows that match your theme.css
        'large': '0 10px 25px rgba(0, 0, 0, 0.1), 0 4px 6px rgba(0, 0, 0, 0.06)'
      },
      
      animation: {
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'slide-in': 'slideIn 0.3s ease-out',
        'fade-in-fast': 'fadeInFast 0.18s ease-out',
        'fade-up': 'fadeUp 0.25s ease-out',
        'shimmer': 'shimmer 1.4s ease-in-out infinite',
        'modal-pop': 'modalPop 0.18s ease-out',
        'backdrop-fade': 'backdropFade 0.2s ease-out',
      },

      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideIn: {
          '0%': { transform: 'translateX(-10px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        fadeInFast: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-450px 0' },
          '100%': { backgroundPosition: '450px 0' },
        },
        modalPop: {
          '0%': { opacity: '0', transform: 'scale(0.96) translateY(4px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        backdropFade: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [
    // Add the forms plugin since you have it in package.json
    // Uncomment this line after running: npm install @tailwindcss/forms
    // require('@tailwindcss/forms'),
  ],
}