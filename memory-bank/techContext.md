# Technology Context

## Tech Stack Overview

### Frontend Technologies
- **Core Framework**: React with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS
- **Data Fetching**: React Query
- **State Management**: React Context + React Query
- **Routing**: React Router
- **Form Handling**: Custom form components
- **Charts/Visualizations**: Recharts
- **Icons**: Lucide React

### Backend Technologies
- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: SQL-based (as inferred from SQL files)
- **Authentication**: JWT-based auth
- **Logging**: Custom logging middleware
- **Email Service**: Custom email service

### Testing Technologies
- **End-to-End Testing**: Cypress
- **Test Runner**: Vitest
- **Component Testing**: React Testing Library
- **Coverage**: @vitest/coverage-v8
- **Visual Testing**: Cypress screenshots

## Development Environment

### Prerequisites
- Node.js (latest LTS version)
- npm or yarn
- Git

### Project Structure
- `/frontend`: React application
- `/backend`: Express API server
- `/Project Docs`: Documentation and reference materials
- `/ai-context`: AI assistant context files
- `/memory-bank`: Memory bank for AI assistant

### Development Workflow
1. Frontend dev server: `npm run dev` in `/frontend`
2. Backend dev server: Custom script in `/kill-port.sh` or `/Project Docs/start-backend.ps1`
3. Testing: Various test scripts in `/Project Docs/`
4. End-to-End Testing: `npx cypress run` or `npx cypress open` in `/frontend`

## Technical Constraints

### Frontend Constraints
- **UI Framework Restrictions**: 
  - Must use only Tailwind CSS for styling (no Material-UI)
  - Must use Lucide React icons exclusively (no Material-UI icons)
  - Must use native HTML elements with Tailwind (no Material-UI components)

### Backend Constraints
- **API Structure**: RESTful API patterns
- **Authentication**: JWT-based authentication
- **Tenant Isolation**: Multi-tenant data isolation
- **Audit Requirements**: Comprehensive audit logging

### Cross-cutting Constraints
- **Performance**: Responsive UI, efficient API responses
- **Security**: Proper authentication and authorization
- **Scalability**: Support for multiple tenants and users
- **Testing**: Automated testing for critical user flows

## Dependencies and Integrations

### Frontend Dependencies
- React v18+
- TypeScript
- Vite
- Tailwind CSS
- React Router
- React Query
- Lucide React icons
- Recharts for data visualization
- Cypress for end-to-end testing

### Backend Dependencies
- Express.js
- JWT authentication
- SQL database drivers
- Email service libraries

### External Integrations
- Email delivery services
- Possibly payment gateways (inferred from accounting features)

## Tooling and Utilities

### Development Tools
- ESLint for code quality
- TypeScript for type safety
- Cypress for end-to-end testing
- Vitest for unit testing
- Various PowerShell and shell scripts for automation

### Build and Deployment
- Vite for frontend building
- Standard Node.js deployment for backend

### Testing Tools
- Cypress for end-to-end testing
- Vitest for unit and component tests
- Test fixtures for consistent test data
- Session-based authentication for tests

## Performance Considerations

### Frontend Performance
- Optimized image component (`OptimizedImage.tsx`)
- Performance utilities (`performance.utils.ts`)

### Backend Performance
- Database query optimization
- Proper indexing (inferred from SQL files)

## Security Considerations

### Authentication
- JWT-based auth system
- Protected routes
- Role-based access control
- Session-based authentication in tests

### Data Security
- Tenant isolation
- Proper authorization middleware

## Accessibility and Internationalization

### Accessibility
- Semantic HTML components
- ARIA attributes where necessary

### Internationalization
- Currently appears to be English-focused
- No obvious i18n libraries identified 