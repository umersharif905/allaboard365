// TypeScript interfaces for Payment Processor Settings
// These settings are stored in the Tenants.PaymentProcessorSettings column as JSON

export interface DimeCredentials {
  apiToken: string; // Stored as apiTokenEncrypted in database
  sid: string; // Not encrypted - merchant ID
  webhookSecret: string; // Stored as webhookSecretEncrypted in database
  environment: 'demo' | 'production';
}

export interface NmiCredentials {
  securityKey: string;        // Stored as securityKeyEncrypted in DB
  collectJsKey: string;       // Public tokenization key (not encrypted)
  environment: 'sandbox' | 'production';
}


export interface ProcessingFees {
  ach: {
    percentageFee: number; // e.g., 0.5 for 0.5%
    flatFee: number; // e.g., 0.30 for $0.30
  };
  creditCard: {
    percentageFee: number; // e.g., 3.0 for 3%
    flatFee: number; // e.g., 0.30 for $0.30
  };
}

export interface OpenEnrollProcessorSettings {
  enabled: boolean;
  dime: DimeCredentials;
  nmi: NmiCredentials;        // ← ADD THIS
  fees: ProcessingFees;
}

export interface PaymentProcessorSettings {
  activeProcessor: string; // 'openenroll', 'stripe', etc.
  chargeFeeToMember: boolean;
  processors: {
    openenroll: OpenEnrollProcessorSettings;
    // Future processors can be added here
    // stripe?: StripeProcessorSettings;
    // square?: SquareProcessorSettings;
  };
}

// System Fees Settings (from oe.Tenants.SystemFees)
export interface SystemFee {
  name: string;
  amount: number;
  type: 'fixed' | 'percentage';
  description: string;
  enabled: boolean;
  MemberPaid?: boolean;
  FlatOrPercent?: 'Flat' | 'Percent';
  MemberPaidAmount?: number;
}

export interface SystemFeesSettings {
  platformFee?: SystemFee;
  mobileAppFee?: SystemFee;
  aiAssistantFee?: SystemFee;
}

