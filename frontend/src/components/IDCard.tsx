import { CreditCard, Eye } from 'lucide-react';
import { useState } from 'react';
import {
  cardFrontHeaderImageStyle,
  cardFrontHeaderSideTextStyle,
  cardFrontHeaderTextStyle,
  getCardFrontHeaderBlockOrder,
  getCardFrontHeaderZoneStyle,
  normalizeHeaderImagePlacement,
} from '../utils/idCardHeaderImagePlacement';

// Types
export interface IDCardData {
  Card_Front: {
    Header: {
      Image: string;
      /** Optional. Defaults to Center when omitted (legacy cards). */
      ImagePlacement?: 'Center' | 'Left' | 'Right';
      /** Optional banner text; sits opposite the logo when Left/Right, below when Center. */
      HeaderText?: string;
    };
    Footer: {
      Header: string;
      Text1: string;
      Text2: string;
    };
  };
  Card_Back: {
    Top_Left: CardSection;
    Top_Right: CardSection;
    Middle: CardSection;
    Bottom_Left: CardSection;
    Bottom_Right: CardSection;
  };
}
export interface CardSection {
  Image: string;
  Header: string;
  Text1: string;
  Link_Name1: string;
  URL1: string;
  Link_Name2: string;
  URL2: string;
}
export interface MemberInfo {
  firstName: string;
  lastName: string;
  memberId: string;
  dateOfBirth: string;
  planName: string;
  effectiveDate: string;
  spouse?: {
    name: string;
    dob: string;
    gender: string;
  };
  dependents?: Array<{
    name: string;
    dob: string;
    gender: string;
  }>;
}
export interface IdCardConfigurationDisplay {
  label: string;
  value: string;
}

interface IDCardProps {
  idCardData: IDCardData;
  memberInfo: MemberInfo;
  productName: string;
  isPreview?: boolean; // For use in AddProductWizard preview
  showPreviewLabels?: boolean; // Show/hide "Card Front" and "Card Back" labels in preview mode
  groupId?: string | null; // Group ID to display (vendor group ID for groups, static group ID for individuals)
  showGroupId?: boolean; // Whether to show Group ID on the card
  fallbackLogoUrl?: string; // Used when Card_Front.Header.Image is missing
  /** Plan configuration row rendered under Member Details (e.g. unshared amount when not inlined via {{ConfigValue1}}). */
  idCardConfigurationDisplay?: IdCardConfigurationDisplay | null;
}
export default function IDCard({ 
  idCardData, 
  memberInfo, 
  productName,
  isPreview = false,
  showPreviewLabels = true,
  groupId = null,
  showGroupId = false,
  fallbackLogoUrl = '',
  idCardConfigurationDisplay = null
}: IDCardProps) {
  const [activeTab, setActiveTab] = useState<'front' | 'back'>('front');
  const cardTextStyle = { wordBreak: 'break-word' as const, overflowWrap: 'anywhere' as const };

  // Helper function to format dates as MM/DD/YYYY
  // Handles UTC dates correctly by parsing date parts separately to avoid timezone conversion
  const formatDate = (dateString: string) => {
    if (!dateString) return 'N/A';
    try {
      // For calendar dates (DOB, effective dates), parse date parts separately to avoid timezone issues
      // Server returns UTC dates like "2025-11-05T00:00:00Z" which new Date() converts to local timezone
      const [datePart] = dateString.split('T');
      if (datePart) {
        const [year, month, day] = datePart.split('-');
        if (year && month && day) {
          const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
          return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
          });
        }
      }
      // Fallback to standard parsing if format is different
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
    } catch (error) {
      return dateString; // Return original if parsing fails
    }
  };

  // Helper function to format gender
  const formatGender = (gender: string) => {
    if (!gender) return '';
    switch (gender?.toUpperCase()) {
      case 'M':
      case 'MALE':
        return 'M';
      case 'F':
      case 'FEMALE':
        return 'F';
      default:
        return gender.toUpperCase().charAt(0);
    }
  };

  /** Strip trailing `$` from labels like "Unshared Amount $" so we don't render "…$: $2500". */
  const normalizeConfigurationLabel = (raw: string) => {
    const t = String(raw ?? '').trim();
    const withoutTrailingDollar = t.replace(/\$\s*$/u, '').trim();
    return withoutTrailingDollar || t;
  };

  const formatConfigurationDisplayValue = (raw: string) => {
    const t = String(raw ?? '').trim();
    if (!t) return t;
    if (t.includes('$')) return t;
    if (/^\d[\d,]*(\.\d+)?$/.test(t)) return `$${t}`;
    return t;
  };

  // Render card front with member data
  const renderCardFront = () => {
    const logoUrl = (idCardData?.Card_Front?.Header?.Image || '').trim() || fallbackLogoUrl.trim();
    const headerPlacement = normalizeHeaderImagePlacement(
      idCardData?.Card_Front?.Header?.ImagePlacement
    );
    const headerText = (idCardData?.Card_Front?.Header?.HeaderText || '').trim();
    const hasImage = Boolean(logoUrl);
    const hasText = Boolean(headerText);
    const blockOrder = getCardFrontHeaderBlockOrder(headerPlacement, hasImage, hasText);
    const sideBySide = hasImage && hasText && headerPlacement !== 'Center';

    const renderHeaderImage = () =>
      hasImage ? (
        <img
          src={logoUrl}
          alt="Company Logo"
          style={cardFrontHeaderImageStyle}
        />
      ) : (
        <div style={{ color: '#666', fontSize: '12px' }}>[Company Logo]</div>
      );

    const renderHeaderText = () => (
      <div
        style={
          sideBySide
            ? cardFrontHeaderSideTextStyle(headerPlacement)
            : cardFrontHeaderTextStyle
        }
      >
        {headerText}
      </div>
    );

    return (
      <div className="mx-auto w-full max-w-[340px]" style={{ width: '340px' }} data-id-card-side="front">
        <div style={{
          border: '2px solid black',
          borderRadius: '12px',
          backgroundColor: 'white',
          overflow: 'hidden'
        }}>
          <div style={getCardFrontHeaderZoneStyle(headerPlacement, hasImage, hasText)}>
            {blockOrder.map((block) =>
              block === 'image' ? (
                <span
                  key="image"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexShrink: 0,
                    marginLeft: sideBySide && headerPlacement === 'Right' ? 'auto' : undefined,
                  }}
                >
                  {renderHeaderImage()}
                </span>
              ) : (
                <span
                  key="text"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    minWidth: 0,
                    flex: sideBySide ? 1 : undefined,
                  }}
                >
                  {renderHeaderText()}
                </span>
              )
            )}
          </div>
          {/* Member Info Section */}
          <div style={{ display: 'flex', borderBottom: '1px solid black' }}>
            <div style={{ flex: 1, padding: '12px', borderRight: '1px solid black' }}>
              <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Member Details</div>
              <div style={{ fontSize: '11px', color: '#333', ...cardTextStyle }}>
                <div><strong>Name:</strong> {memberInfo.firstName} {memberInfo.lastName}</div>
                <div><strong>Member ID:</strong> {memberInfo.memberId}</div>
                <div><strong>DoB:</strong> {formatDate(memberInfo.dateOfBirth)}</div>
                <div><strong>Plan Name:</strong> {memberInfo.planName}</div>
                <div><strong>Effective Date:</strong> {formatDate(memberInfo.effectiveDate)}</div>
                {idCardConfigurationDisplay && (
                  <div>
                    <strong>{normalizeConfigurationLabel(idCardConfigurationDisplay.label)}:</strong>{' '}
                    {formatConfigurationDisplayValue(idCardConfigurationDisplay.value)}
                  </div>
                )}
                {showGroupId && groupId && (
                  <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #ddd' }}>
                    <div><strong>Group ID:</strong> {groupId}</div>
                  </div>
                )}
              </div>
            </div>
            <div style={{ flex: 1, padding: '12px' }}>
              <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Household</div>
              <div style={{ fontSize: '11px', color: '#333', ...cardTextStyle }}>
                {/* Spouse Section */}
                {memberInfo.spouse && (
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>Spouse:</div>
                    <div style={{ marginBottom: '4px' }}>
                      {memberInfo.spouse.name}{formatGender(memberInfo.spouse.gender) ? ` (${formatGender(memberInfo.spouse.gender)})` : ''}
                    </div>
                    <div>
                      <strong>DoB:</strong> {formatDate(memberInfo.spouse.dob)}
                    </div>
                  </div>
                )}
                
                {/* Dependents Section (children only) */}
                {memberInfo.dependents && memberInfo.dependents.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>Dependents:</div>
                    {memberInfo.dependents.map((dependent, index) => (
                      <div key={index} style={{ marginLeft: '16px', marginBottom: '4px' }}>
                        <div>
                          • {dependent.name}{formatGender(dependent.gender) ? ` (${formatGender(dependent.gender)})` : ''}
                        </div>
                        <div style={{ marginLeft: '8px' }}>
                          <strong>DoB:</strong> {formatDate(dependent.dob)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* Footer */}
          <div style={{ padding: '12px', textAlign: 'center' }}>
            <div style={{ fontWeight: 'bold', fontSize: '14px' }}>
              {idCardData.Card_Front.Footer.Header}
            </div>
            <div style={{ fontSize: '11px', margin: '4px 0', ...cardTextStyle }}>
              {idCardData.Card_Front.Footer.Text1}
            </div>
            <div style={{ fontWeight: 'bold', fontSize: '14px' }}>
              {idCardData.Card_Front.Footer.Text2}
            </div>
          </div>
        </div>
      </div>
    );
  };
  // Render card back
  const renderCardBack = () => {
    return (
      <div className="mx-auto w-full max-w-[340px]" style={{ width: '340px' }} data-id-card-side="back">
        <div style={{
          border: '2px solid black',
          borderRadius: '12px',
          backgroundColor: 'white',
          overflow: 'hidden'
        }}>
          {/* Top Row */}
          <div style={{ display: 'flex', borderBottom: '1px solid black' }}>
            <div style={{ flex: 1, padding: '12px', borderRight: '1px solid black' }}>
              {idCardData.Card_Back.Top_Left.Image && (
                <div style={{ width: '100px', height: '40px', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <img 
                    src={idCardData.Card_Back.Top_Left.Image} 
                    alt="Top Left" 
                    style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' }} 
                  />
                </div>
              )}
              <div style={{ fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>
                {idCardData.Card_Back.Top_Left.Header}
              </div>
              <div style={{ fontSize: '10px', color: '#333', whiteSpace: 'pre-line', ...cardTextStyle }}>
                {idCardData.Card_Back.Top_Left.Text1}
              </div>
              {idCardData.Card_Back.Top_Left.Link_Name1 && (
                <div style={{ fontSize: '10px', marginTop: '4px' }}>
                  <a href={idCardData.Card_Back.Top_Left.URL1} style={{ color: '#0066cc' }}>
                    {idCardData.Card_Back.Top_Left.Link_Name1}
                  </a>
                </div>
              )}
            </div>
            <div style={{ flex: 1, padding: '12px' }}>
              {idCardData.Card_Back.Top_Right.Image && (
                <div style={{ width: '100px', height: '40px', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <img 
                    src={idCardData.Card_Back.Top_Right.Image} 
                    alt="Top Right" 
                    style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' }} 
                  />
                </div>
              )}
              <div style={{ fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>
                {idCardData.Card_Back.Top_Right.Header}
              </div>
              <div style={{ fontSize: '10px', color: '#333', whiteSpace: 'pre-line', ...cardTextStyle }}>
                {idCardData.Card_Back.Top_Right.Text1}
              </div>
              {idCardData.Card_Back.Top_Right.Link_Name1 && (
                <div style={{ fontSize: '10px', marginTop: '4px' }}>
                  <a href={idCardData.Card_Back.Top_Right.URL1} style={{ color: '#0066cc' }}>
                    {idCardData.Card_Back.Top_Right.Link_Name1}
                  </a>
                </div>
              )}
            </div>
          </div>
          {/* Middle Section */}
          <div style={{ padding: '12px', borderBottom: '1px solid black', textAlign: 'center' }}>
            {idCardData.Card_Back.Middle.Image && (
              <div style={{ width: '100px', height: '40px', marginBottom: '8px', margin: '0 auto 8px auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <img 
                  src={idCardData.Card_Back.Middle.Image} 
                  alt="Middle" 
                  style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' }} 
                />
              </div>
            )}
            <div style={{ fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>
              {idCardData.Card_Back.Middle.Header}
            </div>
            <div style={{ fontSize: '10px', color: '#333', whiteSpace: 'pre-line', ...cardTextStyle }}>
              {idCardData.Card_Back.Middle.Text1}
            </div>
            {idCardData.Card_Back.Middle.Link_Name1 && (
              <div style={{ fontSize: '10px', marginTop: '4px' }}>
                <a href={idCardData.Card_Back.Middle.URL1} style={{ color: '#0066cc' }}>
                  {idCardData.Card_Back.Middle.Link_Name1}
                </a>
              </div>
            )}
          </div>
          {/* Bottom Row */}
          <div style={{ display: 'flex' }}>
            <div style={{ flex: 1, padding: '12px', borderRight: '1px solid black' }}>
              {idCardData.Card_Back.Bottom_Left.Image && (
                <div style={{ width: '100px', height: '40px', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <img 
                    src={idCardData.Card_Back.Bottom_Left.Image} 
                    alt="Bottom Left" 
                    style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' }} 
                  />
                </div>
              )}
              <div style={{ fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>
                {idCardData.Card_Back.Bottom_Left.Header}
              </div>
              <div style={{ fontSize: '10px', color: '#333', whiteSpace: 'pre-line', ...cardTextStyle }}>
                {idCardData.Card_Back.Bottom_Left.Text1}
              </div>
              {idCardData.Card_Back.Bottom_Left.Link_Name1 && (
                <div style={{ fontSize: '10px', marginTop: '4px' }}>
                  <a href={idCardData.Card_Back.Bottom_Left.URL1} style={{ color: '#0066cc' }}>
                    {idCardData.Card_Back.Bottom_Left.Link_Name1}
                  </a>
                </div>
              )}
            </div>
            <div style={{ flex: 1, padding: '12px' }}>
              {idCardData.Card_Back.Bottom_Right.Image && (
                <div style={{ width: '100px', height: '40px', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <img 
                    src={idCardData.Card_Back.Bottom_Right.Image} 
                    alt="Bottom Right" 
                    style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' }} 
                  />
                </div>
              )}
              <div style={{ fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>
                {idCardData.Card_Back.Bottom_Right.Header}
              </div>
              <div style={{ fontSize: '10px', color: '#333', whiteSpace: 'pre-line', ...cardTextStyle }}>
                {idCardData.Card_Back.Bottom_Right.Text1}
              </div>
              {idCardData.Card_Back.Bottom_Right.Link_Name1 && (
                <div style={{ fontSize: '10px', marginTop: '4px' }}>
                  <a href={idCardData.Card_Back.Bottom_Right.URL1} style={{ color: '#0066cc' }}>
                    {idCardData.Card_Back.Bottom_Right.Link_Name1}
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };
  // If this is a preview (for AddProductWizard), just render the card without tabs
  if (isPreview) {
    return (
      <div className="space-y-4">
        <div>
          {showPreviewLabels && <h4 className="font-semibold text-gray-800 mb-3">Card Front</h4>}
          {renderCardFront()}
        </div>
        <div>
          {showPreviewLabels && <h4 className="font-semibold text-gray-800 mb-3">Card Back</h4>}
          {renderCardBack()}
        </div>
      </div>
    );
  }
  // For the full display (PlansAndIdCards), render with tabs
  return (
    <div className="space-y-6">
      {/* Card Display - Render both sides, hide inactive with visibility/position for download compatibility */}
      <div className="flex justify-center relative" style={{ minHeight: '400px' }}>
        <div 
          data-id-card-visibility-wrapper="front"
          style={{ 
            display: 'block',
            visibility: activeTab === 'front' ? 'visible' : 'hidden',
            position: activeTab === 'front' ? 'relative' : 'absolute',
            left: activeTab === 'front' ? 'auto' : '-9999px',
            top: activeTab === 'front' ? 'auto' : '0'
          }}
        >
          {renderCardFront()}
        </div>
        <div 
          data-id-card-visibility-wrapper="back"
          style={{ 
            display: 'block',
            visibility: activeTab === 'back' ? 'visible' : 'hidden',
            position: activeTab === 'back' ? 'relative' : 'absolute',
            left: activeTab === 'back' ? 'auto' : '-9999px',
            top: activeTab === 'back' ? 'auto' : '0'
          }}
        >
          {renderCardBack()}
        </div>
      </div>
      {/* Card Side Tabs - Moved below the cards */}
      <div className="flex gap-2 justify-center mt-4">
        <button
          data-testid="card-front-tab"
          onClick={() => setActiveTab('front')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'front' 
              ? 'bg-oe-primary text-white hover:bg-oe-dark' 
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          <CreditCard className="w-4 h-4 inline-block mr-2" />
          Card Front
        </button>
        <button
          data-testid="card-back-tab"
          onClick={() => setActiveTab('back')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'back' 
              ? 'bg-oe-primary text-white hover:bg-oe-dark' 
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          <Eye className="w-4 h-4 inline-block mr-2" />
          Card Back
        </button>
      </div>
    </div>
  );
}
