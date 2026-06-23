import { Link } from 'react-router-dom';
import { useCustomDomainTenantBranding } from '../hooks/useCustomDomainTenantBranding';

const LAST_UPDATED = 'March 2, 2026';

const PrivacyPolicyPage: React.FC = () => {
  const { logoUrl, brandName, loading } = useCustomDomainTenantBranding();

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        {/* Logo (primary version with text, larger) */}
        <div className="flex justify-center mb-8">
          <img
            src={logoUrl}
            alt={brandName}
            className={`h-24 sm:h-28 md:h-32 w-auto max-w-full transition-opacity ${loading ? 'opacity-60' : 'opacity-100'}`}
          />
        </div>

        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h1 className="text-2xl font-semibold text-gray-900">Privacy Policy</h1>
            <p className="mt-1 text-sm text-gray-500">Last updated: {LAST_UPDATED}</p>
          </div>

          <div className="p-6 space-y-8">
            <section>
              <p className="text-gray-600">
                This Privacy Policy explains how AllAboard365 (“we”, “our”, or “us”) collects, uses, discloses, and protects your information when you use our platform, enrollment tools, and related services, including communications sent via SMS and email. By using our service, you agree to the collection and use of information in accordance with this policy.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">1. Information We Collect</h2>
              <p className="text-gray-600 mb-2 font-medium">A. Personal Information</p>
              <p className="text-gray-600 mb-2">
                When you use our service, we may collect: name, email address, phone number, date of birth, gender, member ID and plan information, profile or ID card images (if uploaded), contact details submitted via support or forms, and device identifiers used for notifications.
              </p>
              <p className="text-gray-600 mb-2 font-medium">B. Communications Data (SMS and Email)</p>
              <p className="text-gray-600 mb-2">
                We use third-party providers (Twilio for SMS and SendGrid for email) to send you enrollment reminders, account notifications, and service-related messages. We collect and process your phone number and email address to deliver these communications. Message delivery status and related technical data may be processed by our providers in accordance with their privacy practices.
              </p>
              <p className="text-gray-600 mb-2 font-medium">C. Technical Data</p>
              <p className="text-gray-600">
                We may collect device type, operating system, browser or app version, IP address, general location, and usage or crash analytics through third-party tools to operate and improve the service.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">2. How We Use Your Information</h2>
              <p className="text-gray-600 mb-2">We use your information to:</p>
              <ul className="list-disc list-inside text-gray-600 space-y-1 ml-2">
                <li>Provide access to your benefits, enrollment, and member profile</li>
                <li>Send you SMS and email notifications, reminders, and account-related messages</li>
                <li>Respond to support requests and inquiries</li>
                <li>Improve security, performance, and user experience</li>
                <li>Comply with legal and regulatory requirements</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">3. How We Share Your Information</h2>
              <p className="text-gray-600 mb-2">
                We <strong>do not sell</strong> your personal data. We may share your information with:
              </p>
              <ul className="list-disc list-inside text-gray-600 space-y-1 ml-2">
                <li><strong>Service providers</strong> (e.g., cloud hosting, SMS via Twilio, email via SendGrid) who help us operate the service under strict confidentiality and data protection terms</li>
                <li><strong>Your organization or plan sponsors</strong> to fulfill benefits and enrollment obligations</li>
                <li><strong>Legal authorities</strong> when required by law or to protect rights and safety</li>
              </ul>
              <p className="text-gray-600 mt-2">
                Twilio and SendGrid act as data processors for SMS and email delivery; their privacy notices and terms apply to their processing of that data.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">4. Data Security</h2>
              <p className="text-gray-600 mb-2">
                We use administrative, technical, and physical safeguards to protect your data, including encrypted transmission (HTTPS/TLS), secure storage, access controls, and vendor security standards. No system is completely secure; we encourage you to safeguard your credentials.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">5. Your Rights and Choices</h2>
              <p className="text-gray-600 mb-2">
                Depending on your jurisdiction, you may have the right to access, correct, or request deletion of your personal information, and to withdraw consent for certain uses. You may opt out of marketing SMS by replying STOP and of marketing email via the unsubscribe link in messages. Account-related and transactional messages may still be sent as necessary for the service.
              </p>
              <p className="text-gray-600">
                Contact us (see Section 10) for any privacy or data requests.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">6. Data Retention</h2>
              <p className="text-gray-600">
                We retain your data only as long as necessary for the purposes described in this policy or as required by law. When no longer needed, we securely delete or anonymize it.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">7. Children’s Privacy</h2>
              <p className="text-gray-600">
                Our service is not intended for individuals under 13. We do not knowingly collect personal information from children. If we learn we have collected such information, we will delete it promptly.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">8. Third-Party Services</h2>
              <p className="text-gray-600">
                We use Twilio for SMS and SendGrid for email delivery. Their privacy policies and terms apply to their handling of data. Our platform may also link to third-party sites (e.g., benefits portals, telehealth); this policy does not cover those sites. Please review their privacy practices separately.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">9. Changes to This Policy</h2>
              <p className="text-gray-600">
                We may update this Privacy Policy from time to time. We will post the revised policy and update the “Last updated” date. Continued use of the service after changes constitutes acceptance. For material changes, we may notify you by email or in-app notice.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">10. Contact Us</h2>
              <p className="text-gray-600 mb-4">
                For questions or concerns about this Privacy Policy or our data practices, please contact your administrator or use the contact information provided on the AllAboard365 platform.
              </p>
              <div className="flex flex-wrap gap-4">
                <Link
                  to="/terms"
                  className="inline-flex items-center text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  Terms of Service
                </Link>
                <Link
                  to="/login"
                  className="inline-flex items-center text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  Back to login
                </Link>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PrivacyPolicyPage;
