import { Link } from 'react-router-dom';

const LOGO_URL = '/images/branding/allaboard365/allaboard365-logo-primary-transparent.png';
const LAST_UPDATED = 'March 2, 2026';

const TermsPage: React.FC = () => {
  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        {/* Logo (primary version with text, larger) */}
        <div className="flex justify-center mb-8">
          <img
            src={LOGO_URL}
            alt="AllAboard365"
            className="h-24 sm:h-28 md:h-32 w-auto max-w-full"
          />
        </div>

        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h1 className="text-2xl font-semibold text-gray-900">Terms of Service</h1>
            <p className="mt-1 text-sm text-gray-500">Last updated: {LAST_UPDATED}</p>
          </div>

          <div className="p-6 space-y-8">
            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">1. Acceptance</h2>
              <p className="text-gray-600">
                By accessing or using the AllAboard365 service and related enrollment, benefits, and communication features, you agree to be bound by these Terms of Service. If you do not agree, do not use the service.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">2. Description of Service</h2>
              <p className="text-gray-600">
                AllAboard365 provides benefits enrollment, member and group management, agent tools, and related communications. We may send you notifications, reminders, and account-related messages via email and SMS.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">3. Eligibility and Accounts</h2>
              <p className="text-gray-600">
                You must be eligible under your organization’s or plan’s rules to use the service. You are responsible for keeping your account credentials secure and for all activity under your account.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">4. Communications (SMS and Email)</h2>
              <p className="text-gray-600 mb-2">
                We may send you SMS and email for enrollment, notifications, reminders, and account-related purposes. By providing your phone number and email, you consent to receive these messages.
              </p>
              <ul className="list-disc list-inside text-gray-600 space-y-1 ml-2">
                <li>Message and data rates may apply for SMS. Check with your carrier.</li>
                <li>To opt out of SMS, reply STOP to any message or contact us as described below.</li>
                <li>To opt out of marketing email, use the unsubscribe link in the email.</li>
                <li>Carriers are not liable for delayed or undelivered messages.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">5. Acceptable Use</h2>
              <p className="text-gray-600">
                You may not use the service for any illegal, abusive, or prohibited purpose. You must comply with applicable laws and with the acceptable use policies of our communication providers (including Twilio and SendGrid).
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">6. Privacy and Data</h2>
              <p className="text-gray-600">
                We collect and use your information as described in our <Link to="/privacy-policy" className="text-blue-600 hover:text-blue-700 font-medium">Privacy Policy</Link> and to provide the service. By using the service you agree to our data practices.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">7. Third-Party Services</h2>
              <p className="text-gray-600">
                We use third-party services for SMS (e.g., Twilio) and email (e.g., SendGrid). Their terms and policies also apply to those communications. We are not responsible for their services beyond our obligations under these terms.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">8. Intellectual Property</h2>
              <p className="text-gray-600">
                AllAboard365 and related logos and content are our property or our licensors’. You may not copy, modify, or misuse our branding or content without permission.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">9. Disclaimers and Limitation of Liability</h2>
              <p className="text-gray-600">
                The service is provided “as is.” We disclaim warranties to the extent permitted by law. Our liability is limited to the maximum extent permitted by applicable law.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">10. Termination</h2>
              <p className="text-gray-600">
                We or your organization may suspend or terminate your access to the service. You may stop using the service at any time. Provisions that by their nature should survive will survive termination.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">11. Changes to Terms</h2>
              <p className="text-gray-600">
                We may update these terms from time to time. We will post the updated terms and the “Last updated” date. Continued use of the service after changes constitutes acceptance of the revised terms.
              </p>
            </section>

            {/* SMS opt-in screenshot for campaign review — URL: /terms#optin-screenshot */}
            <section id="optin-screenshot" className="scroll-mt-8">
              <h2 className="text-lg font-medium text-gray-900 mb-2">SMS opt-in (sign-up form)</h2>
              <p className="text-gray-600 mb-3 text-sm">
                Below is a screenshot of the sign-up form showing the SMS consent checkbox that users must accept before completing registration.
              </p>
              <img
                src="/images/optin-screenshot.png"
                alt="SMS consent checkbox on sign-up form"
                className="w-full max-w-2xl rounded-lg border border-gray-200"
              />
              <p className="text-xs text-gray-500 mt-2">
                To update: replace the file at <code className="bg-gray-100 px-1 rounded">public/images/optin-screenshot.png</code> with your actual screenshot.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-medium text-gray-900 mb-2">12. Governing Law and Contact</h2>
              <p className="text-gray-600 mb-4">
                These terms are governed by the laws of the jurisdiction specified in your agreement with us, or otherwise the laws of the United States. For questions about these terms or the service, please contact us through the contact information provided by your administrator or on the AllAboard365 platform.
              </p>
              <Link
                to="/login"
                className="inline-flex items-center text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                Back to login
              </Link>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TermsPage;
