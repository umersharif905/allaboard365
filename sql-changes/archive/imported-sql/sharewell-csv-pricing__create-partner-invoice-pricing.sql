-- Partner Invoice Pricing Table
-- Stores per-partner premium and commission rates for invoice generation.
-- Run: ./ai_scripts/db-execute-sharewell.sh sharewell-csv-processor/sql/pricing/create-partner-invoice-pricing.sql

IF OBJECT_ID('dbo.partner_invoice_pricing', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.partner_invoice_pricing (
        id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        partner_id UNIQUEIDENTIFIER NOT NULL,
        ua INT NOT NULL,
        tier NVARCHAR(10) NOT NULL,
        premium MONEY NOT NULL,
        commission MONEY NOT NULL DEFAULT 0,
        tobacco_surcharge MONEY NOT NULL DEFAULT 100,
        effective_from DATE NULL,
        effective_to DATE NULL,
        created_dt DATETIME2(3) NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT PK_partner_invoice_pricing PRIMARY KEY (id),
        CONSTRAINT FK_partner_invoice_pricing_partner FOREIGN KEY (partner_id) REFERENCES dbo.partners(id),
        CONSTRAINT UQ_partner_invoice_pricing UNIQUE (partner_id, ua, tier)
    );
    CREATE INDEX IX_partner_invoice_pricing_partner_ua_tier ON dbo.partner_invoice_pricing (partner_id, ua, tier);
    PRINT 'Created table dbo.partner_invoice_pricing';
END
ELSE
BEGIN
    PRINT 'Table dbo.partner_invoice_pricing already exists';
END
