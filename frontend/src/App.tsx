// Message Center
import MessageCenterLayout from './components/layout/MessageCenterLayout';
import MessageAnalyticsPage from './pages/message-center/MessageAnalyticsPage';
import MessageHistoryPage from './pages/message-center/MessageHistoryPage';
import MessageQueuePage from './pages/message-center/MessageQueuePage';
import CampaignsPage from './pages/message-center/CampaignsPage';
import MessageTemplatesPage from './pages/message-center/MessageTemplatesPage';
import ProposalsPage from './pages/message-center/ProposalsPage';
import ScheduledMessagesPage from './pages/message-center/ScheduledMessagesPage';

// frontend/src/App.tsx
import { lazy, Suspense } from 'react';
import { Toaster } from 'react-hot-toast';
import { Navigate, Route, BrowserRouter as Router, Routes, useSearchParams, useLocation } from 'react-router-dom';
import * as Sentry from '@sentry/react';

// Wrap Routes with Sentry instrumentation for parameterized route transaction names.
// Only the TOP-LEVEL Routes should be wrapped — nested <Routes> stay as-is.
const SentryRoutes = Sentry.withSentryReactRouterV7Routing(Routes);
import ProtectedRoute from './components/auth/ProtectedRoute';
import ErrorBoundary from './components/common/ErrorBoundary';
import AuthLayout from './components/layout/AuthLayout'; // Import the new layout
import StyleGuide from './components/StyleGuide';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import TenantSharingDraftsPage from './pages/tenant-admin/TenantSharingDraftsPage';
import ForgotPassword from './pages/ForgotPassword';
import Login from './pages/login';
import ResetPassword from './pages/ResetPassword';
import TermsPage from './pages/TermsPage';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage';
import DeleteAccountPage from './pages/public/DeleteAccountPage';
import MarketingUnsubscribePage from './pages/public/MarketingUnsubscribePage';
import { resolvePostLoginPath } from './utils/postLoginRedirect';

// Admin Pages
import RevenuePage from './pages/admin/accounting';
import CommissionSystem from './pages/admin/CommissionSystem';
import AdminDashboard from './pages/admin/dashboard';
import GroupAdminDashboard from './pages/admin/GroupAdminDashboard';
import ProductMarketplace from './pages/admin/marketplace';
// import AdminMembers from './pages/admin/members'; // Replaced with shared MembersPage
import AdminTenants from './pages/admin/tenants';
import MarketingResourceCopy from './pages/admin/MarketingResourceCopy';
import Vendors from './pages/admin/Vendors';
import MigrationHub from './pages/admin/migration/MigrationHub';
import E123MigrationWizard from './pages/admin/migration/E123MigrationWizard';
import E123ProductMigrationWizard from './pages/admin/migration/E123ProductMigrationWizard';
import E123AgentMigrationWizard from './pages/admin/migration/E123AgentMigrationWizard';
import E123GroupMigrationWizard from './pages/admin/migration/E123GroupMigrationWizard';
import E123MigrationAdminGate from './pages/admin/migration/E123MigrationAdminGate';
import TenantE123MigrationLayout from './pages/tenant-admin/TenantE123MigrationLayout';
import VendorAdminDetailPage from './pages/admin/vendor-admin/VendorAdminDetailPage';
import GroupsPage from './pages/groups/GroupsPage';
import ProspectsPage from './pages/prospects/ProspectsPage';

// Agent Pages
import SubscriptionApprovals from './pages/admin/SubscriptionApprovals';
import { ToastContainer } from './components/common/Toast';
import AgentAccounting from './pages/agent/AgentAccounting';
import AgentBilling from './pages/agent/AgentBilling';
import AgentActivities from './pages/agent/AgentActivities';
import AgentCommissions from './pages/agent/AgentCommissions';
import AgentProducts from './pages/agent/AgentProducts';
import AgentReports from './pages/agent/AgentReports';
import AgentSalesPipeline from './pages/agent/AgentSalesPipeline';
import AgentTraining from './pages/agent/AgentTraining';
import AgentTrainingOld from './pages/agent/AgentTrainingOld';
import AgentSettings from './pages/agent/AgentSettings';
import AgentDashboard from './pages/agent/dashboard';

// Shared Components
import GroupDetails from './pages/groups/GroupDetails';
import MembersPage from './pages/members/MembersPage';

// Shared Enrollment Links Page
import EnrollmentLinkTemplates from './pages/enrollment-links/EnrollmentLinkTemplates';
import MarketingPage from './pages/marketing/MarketingPage';
import ResourceLibraryPage from './pages/marketing/ResourceLibraryPage';

// Enrollment Page
import EnrollmentPage from './pages/enrollment/EnrollmentPage';

// Test Pages
import ContributionTestPage from './pages/test/ContributionTestPage';

// Group Onboarding Page
import GroupOnboardingWizard from './components/group-onboarding/GroupOnboardingWizard';

// Agent Onboarding Page
import { ShortCodeResolver } from './components/ShortCodeResolver';
import OnboardingSuccess from './pages/agent/OnboardingSuccess';
import AgentOnboarding from './pages/public/AgentOnboarding';
import AgentVerification from './pages/public/AgentVerification';
import SignAcknowledgementsPage from './pages/public/SignAcknowledgementsPage';
import TenantAdminPasswordSetup from './pages/public/TenantAdminPasswordSetup';
import PublicFormPage from './pages/public/PublicFormPage';
import InvitationFormPage from './pages/public/InvitationFormPage';
import PublicSubmissionPage from './pages/public/PublicSubmissionPage';

// Password Setup Page
import PasswordSetup from './pages/PasswordSetup';

// Tenant Route Handler
import DomainTenantHandler from './components/DomainTenantHandler';
import TenantRouteHandler from './components/TenantRouteHandler';

// Group Admin Pages
import UserManagement from './components/user-management/UserManagement';

// Member Pages
import MemberDashboard from './pages/member/dashboard';
import Dependents from './pages/member/Dependents';
import Documents from './pages/member/Documents';
import IDCards from './pages/member/IDCards';
import Payments from './pages/member/Payments';
import PlansAndIdCards from './pages/member/PlansAndIdCards';
import ProductChangePage from './pages/member/ProductChangePage';
import ProductChangeWizard from './pages/member/ProductChangeWizard';
import PrintIDCards from './pages/shared/PrintIDCards';
import Settings from './pages/member/Settings';
import CommunicationPreferences from './pages/member/CommunicationPreferences';
import Telemedicine from './pages/member/Telemedicine';
import Training from './pages/member/Training';
import SharingRequests from './pages/member/SharingRequests';

// Lazy load layout components
const AdminLayout = lazy(() => import('./components/admin/AdminLayout'));
const AgentLayout = lazy(() => import('./components/agent/AgentLayout'));
const GroupAdminLayout = lazy(() => import('./components/group-admin/GroupAdminLayout'));
const MemberLayout = lazy(() => import('./components/member/MemberLayout'));
const VendorLayout = lazy(() => import('./components/vendor/VendorLayout'));

// Lazy load TenantAdmin components
const TenantAdminLayout = lazy(() => import('./components/tenant-admin/TenantAdminLayout'));
const TenantAdminDashboard = lazy(() => import('./pages/tenant-admin/TenantAdminDashboard'));

// Lazy load Vendor components
const VendorDashboard = lazy(() => import('./pages/vendor/VendorDashboard'));
const VendorProducts = lazy(() => import('./pages/vendor/VendorProducts'));
const VendorPayments = lazy(() => import('./pages/vendor/VendorPayments'));
const VendorResourceLibraryPage = lazy(() => import('./pages/vendor/VendorResourceLibraryPage'));
const VendorTraining = lazy(() => import('./pages/vendor/VendorTraining'));
const VendorUsers = lazy(() => import('./pages/vendor/VendorUsers'));
// Vendor portal settings now reuses the SysAdmin <Vendors /> detail workspace
// (portal='vendor' mode). See VendorSelfSettings for the vendorId resolver.
const VendorSelfSettings = lazy(() => import('./pages/vendor/VendorSelfSettings'));
const VendorImportPage = lazy(() => import('./pages/vendor/VendorImportPage'));
const VendorImportTenantsPage = lazy(() => import('./pages/vendor/VendorImportTenantsPage'));
const VendorInvoicesPage = lazy(() => import('./pages/vendor/VendorInvoicesPage'));

// Lazy load Share Request Management components (Vendor Portal)
const ShareRequestDashboard = lazy(() => import('./pages/vendor/ShareRequestDashboard'));
const CaseStudiesDashboard = lazy(() => import('./pages/vendor/CaseStudiesDashboard'));
const VendorMembersWorkspace = lazy(() => import('./pages/vendor/VendorMembersWorkspace'));
const VendorMessageCenterLayout = lazy(() => import('./components/layout/VendorMessageCenterLayout'));
const VendorCallCenter = lazy(() => import('./pages/vendor/VendorCallCenter'));
const VendorZoomSettings = lazy(() => import('./pages/vendor/VendorZoomSettings'));
const ShareRequestWorkspace = lazy(() => import('./pages/vendor/ShareRequestWorkspace'));
const ShareRequestNew = lazy(() => import('./pages/vendor/ShareRequestNew'));
const CaseWorkspace = lazy(() => import('./pages/vendor/CaseWorkspace'));
const ProcedurePricingPage = lazy(() => import('./pages/vendor/ProcedurePricingPage'));
const EncountersPage = lazy(() => import('./pages/vendor/EncountersPage'));
const InboxPage = lazy(() => import('./pages/vendor/InboxPage'));
const ProviderList = lazy(() => import('./pages/vendor/ProviderList'));
const ProviderProfile = lazy(() => import('./pages/vendor/ProviderProfile'));
const ProviderEdit = lazy(() => import('./pages/vendor/ProviderEdit'));
// const TenantGroups = lazy(() => import('./pages/tenant-admin/TenantGroups'));
// const TenantMembers = lazy(() => import('./pages/tenant-admin/TenantMembers'));
const TenantMarketplace = lazy(() => import('./pages/tenant-admin/TenantMarketplace'));
const TenantAccounting = lazy(() => import('./pages/tenant-admin/TenantAccounting'));
const TenantBilling = lazy(() => import('./pages/tenant-admin/TenantBilling'));
const AdminIntegrationErrors = lazy(() => import('./pages/admin/AdminIntegrationErrors'));
const AiInspectorReports = lazy(() => import('./pages/admin/AiInspectorReports'));
const PayoutSourceComparison = lazy(() => import('./pages/admin/PayoutSourceComparison'));
const BillingIntegrity = lazy(() => import('./pages/admin/BillingIntegrity'));
const SystemAudit = lazy(() => import('./pages/admin/SystemAudit'));
const TenantSettings = lazy(() => import('./pages/tenant-admin/TenantSettings'));
const TenantAdminProducts = lazy(() => import('./pages/tenant-admin/TenantAdminProducts'));
const TenantCommissions = lazy(() => import('./pages/tenant-admin/TenantCommissions'));
const TenantAgentTraining = lazy(() => import('./pages/tenant-admin/TenantAgentTraining'));

// Lazy load shared Agents page
const AgentsPage = lazy(() => import('./components/agents/AgentsPage'));
const TenantAgentDetails = lazy(() => import('./pages/tenant-admin/TenantAgentDetails'));
const OnboardingLinks = lazy(() => import('./components/onboarding-links/OnboardingLinksPage'));
const MessageBlastPage = lazy(() => import('./pages/tenant-admin/MessageBlastPage'));
const TenantSharingFormsLayout = lazy(() => import('./pages/tenant-admin/TenantSharingFormsLayout'));
const TenantSharingFormsPage = lazy(() => import('./pages/tenant-admin/TenantSharingFormsPage'));
const TenantSharingSubmissionsPage = lazy(() => import('./pages/tenant-admin/TenantSharingSubmissionsPage'));
const TenantSharingFormEditorPage = lazy(() => import('./pages/tenant-admin/TenantSharingFormEditorPage'));
const TenantSharingSubmissionDetailPage = lazy(() => import('./pages/tenant-admin/TenantSharingSubmissionDetailPage'));
const TenantSharingFormPreviewPage = lazy(() => import('./pages/tenant-admin/TenantSharingFormPreviewPage'));
const TenantTemplateInvitationsPage = lazy(() => import('./pages/tenant-admin/TenantTemplateInvitationsPage'));
const AdminGroupTypeChangeRequestsPage = lazy(() => import('./pages/admin/GroupTypeChangeRequests'));
const GroupTypeChangeWizard = lazy(() => import('./pages/groups/GroupTypeChangeWizard'));

// Simple inline loader component
const PageLoader = () => (
  <div className="flex items-center justify-center h-screen">
    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
  </div>
);

// Helper function to determine the redirect path based on user role
const getRedirectPath = (role: string | null | undefined): string => {
  switch (role) {
    case 'SysAdmin':
      return '/admin/dashboard';
    case 'TenantAdmin':
      return '/tenant-admin/dashboard';
    case 'VendorAdmin':
    case 'VendorAgent':
      return '/vendor/dashboard';
    case 'Agent':
      return '/agent/dashboard';
    case 'GroupAdmin':
      return '/group-admin/dashboard';
    case 'Member':
    default:
      return '/member/dashboard';
  }
};

// Root redirect component - handles logged-in users (moved inside AuthenticatedApp)

function App() {
  return (
    <ErrorBoundary>
      <ToastContainer />
      <div className="min-h-screen bg-oe-neutral-light">
        <Router>
          <SentryRoutes>
            {/* PUBLIC ROUTES - Enrollment routes must be first - NO AUTH PROVIDER */}
            {/* CRITICAL: These routes must be defined BEFORE /:tenantPath to prevent route conflicts */}
            <Route path="/enroll-now/:shortCode" element={<ShortCodeResolver />} />
            <Route path="/enroll/*" element={<EnrollmentPage />} />
            <Route path="/forms/submissions/:token" element={<PublicSubmissionPage />} />
            {/* Invitation flow — wraps in AuthProvider because authenticated-mode
                invitations need to inspect the current Member session. The page
                itself decides whether to redirect to /login. */}
            <Route path="/forms/i/:token" element={
              <AuthProvider>
                <InvitationFormPage />
              </AuthProvider>
            } />
            {/* Wrapped in AuthProvider so a signed-in member is detected for
                autofill; anonymous visitors are a no-op (no token = no fetch). */}
            <Route path="/forms/:formId" element={
              <AuthProvider>
                <PublicFormPage />
              </AuthProvider>
            } />
            <Route path="/sign-acknowledgements/:token" element={<SignAcknowledgementsPage />} />
            <Route path="/group-onboarding/:linkToken" element={<GroupOnboardingWizard />} />
            <Route path="/agent-onboarding/:linkToken" element={<AgentOnboarding />} />
            <Route path="/public/agent-verification" element={<AgentVerification />} />
            <Route path="/tenant-admin/setup-password" element={<TenantAdminPasswordSetup />} />
            <Route path="/agent/onboarding-success" element={<OnboardingSuccess />} />
            <Route path="/print-id-cards" element={
              <AuthProvider>
                <ProtectedRoute
                  requiredRole={[
                    'SysAdmin',
                    'TenantAdmin',
                    'VendorAdmin',
                    'VendorAgent',
                    'Agent',
                    'GroupAdmin',
                    'Member',
                  ]}
                >
                  <PrintIDCards />
                </ProtectedRoute>
              </AuthProvider>
            } />
            <Route path="/print-id-cards/:enrollmentId" element={
              <AuthProvider>
                <ProtectedRoute
                  requiredRole={[
                    'SysAdmin',
                    'TenantAdmin',
                    'VendorAdmin',
                    'VendorAgent',
                    'Agent',
                    'GroupAdmin',
                    'Member',
                  ]}
                >
                  <PrintIDCards />
                </ProtectedRoute>
              </AuthProvider>
            } />
            <Route path="/setup-password/:token" element={<PasswordSetup />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password/:token" element={<ResetPassword />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
            <Route path="/delete-account" element={<DeleteAccountPage />} />
            <Route path="/unsubscribe" element={<MarketingUnsubscribePage />} />
            <Route path="/test/contribution" element={<ContributionTestPage />} />
            
            {/* AUTHENTICATION ROUTES - Must be before tenant routes */}
            <Route path="/login" element={
              <AuthProvider>
                <LoginRoute />
              </AuthProvider>
            } />
            
            {/* TENANT-SPECIFIC ROUTES - Must be after all specific public routes */}
            {/* NOTE: TenantRouteHandler checks roleBasedRoutes and returns null for routes like /enroll-now */}
            <Route path="/:tenantPath" element={
              <AuthProvider>
                <TenantRouteHandler />
              </AuthProvider>
            } />
            <Route path="/:tenantPath/setup-password/:token" element={<PasswordSetup />} />
            
            {/* ALL OTHER ROUTES - WRAPPED IN AUTH PROVIDER */}
            <Route path="/*" element={
              <AuthProvider>
                <AuthenticatedApp />
              </AuthProvider>
            } />
          </SentryRoutes>

          <Toaster position="top-center" />
        </Router>
      </div>
    </ErrorBoundary>
  );
}

// Login route component - handles redirect if already logged in
const LoginRoute = () => {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const location = useLocation();

  if (user) {
    // Use currentRole if available, otherwise fall back to first role
    const roleToUse = user.currentRole || (user.roles && user.roles.length > 0 ? user.roles[0] : user.userType);
    const roleDefault = getRedirectPath(roleToUse);
    const target = resolvePostLoginPath({
      searchParams,
      routerState: location.state,
      roleDefault
    });
    console.log(
      `[Auth] User is already logged in. Redirecting to ${target} (currentRole: ${user.currentRole}, roles: ${JSON.stringify(user.roles)}, using: ${roleToUse})`
    );
    return <Navigate to={target} replace />;
  }

  // If not logged in, show login page (Login component will read tenant info from localStorage)
  return <Login />;
};

// Root redirect component - handles logged-in users
const RootRedirect = () => {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  console.log('🔍 RootRedirect - Auth state:', {
    hasUser: !!user,
    isLoading,
    userObject: user,
    hasAccessToken: !!localStorage.getItem('accessToken'),
    hasRefreshToken: !!localStorage.getItem('refreshToken'),
    hasUserId: !!localStorage.getItem('userId'),
    roles: localStorage.getItem('roles')
  });

  if (isLoading) {
    console.log('🔍 RootRedirect - Still loading, showing loader');
    return <PageLoader />;
  }

  if (user) {
    // Use currentRole if available, otherwise fall back to first role
    const roleToUse = user.currentRole || (user.roles && user.roles.length > 0 ? user.roles[0] : user.userType);
    const redirectPath = getRedirectPath(roleToUse);
    console.log(`✅ RootRedirect - User is logged in. Redirecting to ${redirectPath} (currentRole: ${user.currentRole}, roles: ${JSON.stringify(user.roles)}, using: ${roleToUse})`);
    return <Navigate to={redirectPath} replace />;
  }

  // If not logged in, go to login — preserve intended deep link in location.state for after auth
  console.log('🚫 RootRedirect - No user found, redirecting to login');
  return <Navigate to="/login" state={{ from: location }} replace />;
};

// Separate component for authenticated routes
function AuthenticatedApp() {
  const { user, isLoading } = useAuth();

  console.log('🔍 AuthenticatedApp component - Auth state:', {
    hasUser: !!user,
    isLoading,
    userObject: user,
    hasAccessToken: !!localStorage.getItem('accessToken'),
    hasRefreshToken: !!localStorage.getItem('refreshToken'),
    hasUserId: !!localStorage.getItem('userId'),
    roles: localStorage.getItem('roles'),
    currentRole: localStorage.getItem('currentRole')
  });

  if (isLoading) {
    console.log('🔍 AuthenticatedApp component - Still loading, showing PageLoader');
    return <PageLoader />;
  }

  return (
    <Routes>
      {/* ROOT ROUTE - Must be last to avoid catching other routes */}
      <Route path="/" element={<RootRedirect />} />

      {/* PROTECTED ROUTES */}
      <Route element={<AuthLayout />}>

        {/* E123 migration — TenantAdmin is redirected to tenant portal from /admin/migration */}
        <Route path="/admin/migration" element={<E123MigrationAdminGate />}>
          <Route
            element={
              <ProtectedRoute requiredRole="SysAdmin">
                <Suspense fallback={<PageLoader />}>
                  <AdminLayout />
                </Suspense>
              </ProtectedRoute>
            }
          >
            <Route index element={<MigrationHub />} />
            <Route path="import" element={<E123MigrationWizard />} />
            <Route path="import/:batchId" element={<E123MigrationWizard />} />
            <Route path="products" element={<E123ProductMigrationWizard />} />
            <Route path="agents" element={<E123AgentMigrationWizard />} />
            <Route path="agents/:batchId" element={<E123AgentMigrationWizard />} />
            <Route path="groups" element={<E123GroupMigrationWizard />} />
            <Route path="groups/:batchId" element={<E123GroupMigrationWizard />} />
          </Route>
        </Route>

        {/* ADMIN ROUTES */}
        <Route
          path="/admin/*"
          element={<ProtectedRoute requiredRole="SysAdmin"><Suspense fallback={<PageLoader />}><AdminLayout /></Suspense></ProtectedRoute>}
        >
          <Route index element={<AdminDashboard />} />
          <Route path="dashboard" element={<AdminDashboard />} />
          <Route path="marketplace" element={<ProductMarketplace />} />
          <Route path="subscription-approvals" element={<SubscriptionApprovals />} />
          <Route path="enrollment-links" element={<EnrollmentLinkTemplates />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="members/:memberId/modify-plan" element={<ProductChangeWizard />} />
          <Route path="tenants" element={<AdminTenants />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="vendors" element={<Vendors />} />
          <Route path="vendors/:vendorId" element={<VendorAdminDetailPage />} />
          <Route path="users" element={<UserManagement />} />
          <Route path="groups" element={<GroupsPage />} />
          <Route path="groups/:identifier" element={<GroupDetails hideBackButton={false} />} />
          <Route path="groups/:identifier/type-change/wizard" element={<GroupTypeChangeWizard />} />
          <Route path="prospects" element={<ProspectsPage />} />
          <Route path="enrollments" element={<AdminDashboard />} />
          <Route path="commissions" element={<CommissionSystem />} />
          <Route path="marketing-resources" element={<ResourceLibraryPage />} />
          <Route path="marketing-resources/copy" element={<MarketingResourceCopy />} />
          <Route path="accounting" element={<RevenuePage />} />
          <Route path="billing" element={<TenantBilling />} />
          <Route path="group-type-change-requests" element={<AdminGroupTypeChangeRequestsPage />} />
          <Route path="system-audit" element={<SystemAudit />}>
            <Route index element={<Navigate to="integration-errors" replace />} />
            <Route path="integration-errors" element={<AdminIntegrationErrors />} />
            <Route path="payout-source-comparison" element={<PayoutSourceComparison />} />
            <Route path="billing-integrity" element={<BillingIntegrity />} />
            <Route path="ai-inspector" element={<AiInspectorReports />} />
          </Route>
          {/* Backwards-compatible redirects from old flat routes into the System Audit hub */}
          <Route path="integration-errors" element={<Navigate to="/admin/system-audit/integration-errors" replace />} />
          <Route path="payout-source-comparison" element={<Navigate to="/admin/system-audit/payout-source-comparison" replace />} />
          <Route path="ai-inspector" element={<Navigate to="/admin/system-audit/ai-inspector" replace />} />
          <Route path="settings" element={<AdminDashboard />} />
          <Route path="message-center" element={<MessageCenterLayout />}>
            <Route index element={<Navigate to="blast" replace />} />
            <Route path="blast" element={<MessageBlastPage />} />
            <Route path="templates" element={<MessageTemplatesPage />} />
            <Route path="campaigns" element={<CampaignsPage />} />
            <Route path="proposals" element={<ProposalsPage />} />
            <Route path="scheduled" element={<ScheduledMessagesPage />} />
            <Route path="queue" element={<MessageQueuePage />} />
            <Route path="history" element={<MessageHistoryPage />} />
            <Route path="analytics" element={<MessageAnalyticsPage />} />
          </Route>
        </Route>

        {/** GROUP ADMIN ROUTES */}
        {/* Exact match for /group-admin - redirects to dashboard */}
        <Route
          path="/group-admin"
          element={<ProtectedRoute requiredRole="GroupAdmin"><Navigate to="/group-admin/dashboard" replace /></ProtectedRoute>}
        />
        {/* Wildcard route for all /group-admin/* paths */}
        <Route
          path="/group-admin/*"
          element={<ProtectedRoute requiredRole="GroupAdmin"><Suspense fallback={<PageLoader />}><GroupAdminLayout /></Suspense></ProtectedRoute>}
        >
          {/* Index route (for /group-admin/) also redirects to dashboard as fallback */}
          <Route index element={<Navigate to="/group-admin/dashboard" replace />} />
          <Route path="dashboard" element={<GroupAdminDashboard />} />
          <Route path="users" element={<UserManagement />} />
          <Route path="groups/:identifier" element={<GroupDetails hideBackButton={true} />} />
          {/* Route for member plan modification - to be implemented later */}
          <Route path="members/:memberId/modify-plan" element={<ProductChangeWizard />} />
          {/* <Route path="reports" element={<AgentReports />} /> */}
        </Route>

        {/* AGENT ROUTES */}
        <Route
          path="/agent/*"
          element={<ProtectedRoute requiredRole="Agent"><Suspense fallback={<PageLoader />}><AgentLayout /></Suspense></ProtectedRoute>}
        >
          <Route index element={<AgentDashboard />} />
          <Route path="dashboard" element={<AgentDashboard />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="members/:memberId/modify-plan" element={<ProductChangeWizard />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="groups" element={<GroupsPage />} />
          <Route path="groups/:identifier" element={<GroupDetails />} />
          <Route path="groups/:identifier/type-change/wizard" element={<GroupTypeChangeWizard />} />
          <Route path="prospects" element={<ProspectsPage />} />
          <Route path="products" element={<AgentProducts />} />
          <Route path="enrollment-link-templates" element={<EnrollmentLinkTemplates />} />
          <Route path="enrollment-links" element={<EnrollmentLinkTemplates />} />
          <Route path="marketing" element={<MarketingPage />} />
          <Route path="resource-library" element={<ResourceLibraryPage />} />
          <Route path="onboarding-links" element={<OnboardingLinks />} />
          <Route path="pipeline" element={<AgentSalesPipeline />} />
          <Route path="activities" element={<AgentActivities />} />
          <Route path="commissions" element={<AgentCommissions />} />
          <Route path="billing" element={<AgentBilling />} />
          <Route path="training" element={<AgentTraining />} />
          <Route path="training/certificates" element={<AgentTraining />} />
          <Route path="training-old" element={<AgentTrainingOld />} />
          <Route path="reports" element={<AgentReports />} />
          <Route path="settings" element={<AgentSettings />} />
          <Route path="accounting" element={<AgentAccounting />} />
        </Route>

        {/* MEMBER ROUTES */}
        <Route
          path="/member/*"
          element={<ProtectedRoute requiredRole="Member"><Suspense fallback={<PageLoader />}><MemberLayout /></Suspense></ProtectedRoute>}
        >
          <Route index element={<MemberDashboard />} />
          <Route path="dashboard" element={<MemberDashboard />} />
          <Route path="plans" element={<PlansAndIdCards />} />
          <Route path="id-cards" element={<IDCards />} />
          <Route path="payments" element={<Payments />} />
          <Route path="product-change" element={<ProductChangePage />} />
          <Route path="product-change-wizard" element={<ProductChangeWizard />} />
          <Route path="sharing-requests" element={<SharingRequests />} />
          <Route path="dependents" element={<Dependents />} />
          <Route path="documents" element={<Documents />} />
          <Route path="telemedicine" element={<Telemedicine />} />
          <Route path="training" element={<Training />} />
          <Route path="settings" element={<Settings />} />
          <Route path="communication-preferences" element={<CommunicationPreferences />} />
        </Route>

        {/* TENANT ADMIN ROUTES */}
        <Route
          path="/tenant-admin/*"
          element={<ProtectedRoute requiredRole="TenantAdmin">
            <Suspense fallback={<PageLoader />}>
              <TenantAdminLayout />
            </Suspense>
          </ProtectedRoute>}
        >
          <Route index element={<TenantAdminDashboard />} />
          <Route path="dashboard" element={<TenantAdminDashboard />} />
          <Route path="groups" element={<GroupsPage />} />
          <Route path="groups/:identifier" element={<GroupDetails />} />
          <Route path="groups/:identifier/type-change/wizard" element={<GroupTypeChangeWizard />} />
          <Route path="prospects" element={<ProspectsPage />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="members/:memberId/modify-plan" element={<ProductChangeWizard />} />
          <Route path="enrollment-links" element={<EnrollmentLinkTemplates />} />
          <Route path="marketing" element={<MarketingPage />} />
          <Route path="resource-library" element={<ResourceLibraryPage />} />
          <Route path="message-blast" element={<MessageBlastPage />} />
          <Route path="sharing-forms" element={<TenantSharingFormsPage />} />
          <Route path="message-center" element={<MessageCenterLayout />}>
            <Route index element={<Navigate to="blast" replace />} />
            <Route path="blast" element={<MessageBlastPage />} />
            <Route path="templates" element={<MessageTemplatesPage />} />
            <Route path="campaigns" element={<CampaignsPage />} />
            <Route path="proposals" element={<ProposalsPage />} />
            <Route path="scheduled" element={<ScheduledMessagesPage />} />
            <Route path="queue" element={<MessageQueuePage />} />
            <Route path="history" element={<MessageHistoryPage />} />
            <Route path="analytics" element={<MessageAnalyticsPage />} />
          </Route>
          <Route path="sharing-forms/template/:formTemplateId" element={<TenantSharingFormEditorPage />} />
          <Route path="sharing-forms/template/:formTemplateId/preview" element={<TenantSharingFormPreviewPage />} />
          <Route path="sharing-forms/template/:formTemplateId/invitations" element={<TenantTemplateInvitationsPage />} />
          <Route path="sharing-forms" element={<TenantSharingFormsLayout />}>
            <Route index element={<TenantSharingFormsPage />} />
            <Route path="submissions" element={<TenantSharingSubmissionsPage />} />
            <Route path="submissions/:submissionId" element={<TenantSharingSubmissionDetailPage />} />
            <Route path="drafts" element={<TenantSharingDraftsPage />} />
          </Route>
          <Route path="marketplace" element={<TenantMarketplace />} />
          <Route path="accounting" element={<TenantAccounting />} />
          <Route path="billing" element={<TenantBilling />} />
          <Route path="settings" element={<TenantSettings />} />
          <Route path="products" element={<TenantAdminProducts />} />
          <Route path="commissions" element={<TenantCommissions />} />
          <Route path="training" element={<TenantAgentTraining />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/:agentId" element={<TenantAgentDetails />} />
          <Route path="onboarding-links" element={<OnboardingLinks />} />
          <Route path="users" element={<UserManagement />} />
          <Route path="user-management" element={<UserManagement />} />
          <Route
            path="group-type-change-requests"
            element={<Navigate to="/tenant-admin/groups?changeRequests=open" replace />}
          />
          <Route path="migration" element={<TenantE123MigrationLayout />}>
            <Route index element={<MigrationHub />} />
            <Route path="import" element={<E123MigrationWizard />} />
            <Route path="import/:batchId" element={<E123MigrationWizard />} />
            <Route path="products" element={<E123ProductMigrationWizard />} />
            <Route path="agents" element={<E123AgentMigrationWizard />} />
            <Route path="agents/:batchId" element={<E123AgentMigrationWizard />} />
            <Route path="groups" element={<E123GroupMigrationWizard />} />
            <Route path="groups/:batchId" element={<E123GroupMigrationWizard />} />
          </Route>
        </Route>

        {/* VENDOR ROUTES */}
        <Route
          path="/vendor/*"
          element={<ProtectedRoute requiredRole={['VendorAdmin', 'VendorAgent']}>
            <Suspense fallback={<PageLoader />}>
              <VendorLayout />
            </Suspense>
          </ProtectedRoute>}
        >
          <Route index element={<VendorDashboard />} />
          <Route path="dashboard" element={<VendorDashboard />} />
          <Route path="profile" element={<Navigate to="/vendor/settings" replace />} />
          <Route path="products" element={<VendorProducts />} />
          <Route path="payments" element={<VendorPayments />} />
          <Route path="resource-library" element={<VendorResourceLibraryPage />} />
          <Route path="documents" element={<Navigate to="/vendor/resource-library" replace />} />
          <Route path="training" element={<VendorTraining />} />
          <Route path="users" element={
            <ProtectedRoute requiredRole={['VendorAdmin']}>
              <VendorUsers />
            </ProtectedRoute>
          } />
          <Route path="settings" element={
            <ProtectedRoute requiredRole={['VendorAdmin']}>
              <VendorSelfSettings />
            </ProtectedRoute>
          } />
          <Route path="zoom-settings" element={
            <ProtectedRoute requiredRole={['VendorAdmin']}>
              <VendorZoomSettings />
            </ProtectedRoute>
          } />
          <Route path="import" element={
            <ProtectedRoute requiredRole={['VendorAdmin']}>
              <VendorImportPage />
            </ProtectedRoute>
          } />
          <Route path="tenants" element={
            <ProtectedRoute requiredRole={['VendorAdmin']}>
              <VendorImportTenantsPage />
            </ProtectedRoute>
          } />
          <Route path="invoices" element={
            <ProtectedRoute requiredRole={['VendorAdmin']}>
              <VendorInvoicesPage />
            </ProtectedRoute>
          } />
          
          {/* Share Request Management Routes.
              `share-requests` and `share-requests/:id` both render the workspace
              so the rail stays visible and the empty-state with the "New share
              request" button shows when nothing is selected — same as Cases.
              Stats dashboard kept at `/dashboard` for direct access. */}
          <Route path="share-requests" element={<ShareRequestWorkspace />} />
          <Route path="share-requests/new" element={<ShareRequestNew />} />
          <Route path="share-requests/dashboard" element={<ShareRequestDashboard />} />
          <Route path="share-requests/:id" element={<ShareRequestWorkspace />} />
          {/* Procedure Pricing — standalone Medicare-rate / hospital-price lookup. */}
          <Route path="procedure-pricing" element={<ProcedurePricingPage />} />
          {/* Cases (back-office, vendor-scoped). Single workspace handles
              list-only, list+detail, and the VendorAdmin-only taxonomy
              settings view. */}
          <Route path="cases" element={<CaseWorkspace />} />
          <Route path="cases/settings" element={<CaseWorkspace />} />
          <Route path="cases/:id" element={<CaseWorkspace />} />
          {/* Encounters (back-office, vendor-scoped). Same rail+detail
              shape as Cases. Spec: docs/superpowers/specs/2026-05-15-encounters-design.md */}
          <Route path="encounters" element={<EncountersPage />} />
          <Route path="encounters/:id" element={<EncountersPage />} />
          {/* Back Office email inbox. Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md
              Open to the whole vendor team (VendorAdmin + VendorAgent). */}
          <Route path="inbox" element={
            <ProtectedRoute requiredRole={['VendorAdmin', 'VendorAgent']}>
              <InboxPage />
            </ProtectedRoute>
          } />
          <Route path="inbox/:id" element={
            <ProtectedRoute requiredRole={['VendorAdmin', 'VendorAgent']}>
              <InboxPage />
            </ProtectedRoute>
          } />
          <Route path="providers" element={<ProviderList />} />
          <Route path="providers/:providerId/edit" element={<ProviderEdit />} />
          <Route path="providers/:providerId" element={<ProviderProfile />} />
          <Route path="members" element={<VendorMembersWorkspace />} />
          <Route path="members/:id" element={<VendorMembersWorkspace />} />
          <Route path="messaging" element={<VendorMessageCenterLayout />}>
            <Route index element={<Navigate to="templates" replace />} />
            <Route path="templates" element={<MessageTemplatesPage />} />
            <Route path="blast" element={<MessageBlastPage />} />
            <Route path="campaigns" element={<CampaignsPage />} />
          </Route>
          <Route path="case-studies" element={<CaseStudiesDashboard />} />
          <Route path="call-center" element={<VendorCallCenter />} />

          {/* Forms (mirrors tenant-admin sharing-forms; backed by /api/me/vendor/public-forms) */}
          <Route path="sharing-forms/template/:formTemplateId" element={<TenantSharingFormEditorPage />} />
          <Route path="sharing-forms/template/:formTemplateId/preview" element={<TenantSharingFormPreviewPage />} />
          <Route path="sharing-forms/template/:formTemplateId/invitations" element={<TenantTemplateInvitationsPage />} />
          <Route path="sharing-forms" element={<TenantSharingFormsLayout />}>
            <Route index element={<TenantSharingFormsPage />} />
            <Route path="submissions" element={<TenantSharingSubmissionsPage />} />
            <Route path="submissions/:submissionId" element={<TenantSharingSubmissionDetailPage />} />
            <Route path="drafts" element={<TenantSharingDraftsPage />} />
          </Route>
        </Route>

      </Route>


      {/* CUSTOM DOMAIN ROUTES - Must be last to catch custom domains */}
      <Route path="/*" element={<DomainTenantHandler />} />

      {/* STYLE GUIDE & CATCH-ALL */}
      <Route path="/style-guide" element={<StyleGuide />} />
      <Route path="*" element={<Navigate to="/login" />} />
    </Routes>
  );
}

export default App;
