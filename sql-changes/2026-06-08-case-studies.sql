-- oe.CaseStudies
-- Vendor-authored "Patient/Client Success Story" case studies, created from a completed
-- share request and later pulled by the MightyWELL / ShareWELL marketing websites to render
-- shareable one-pagers. Scoped by VendorId (matches oe.ShareRequests, which has no TenantId).
-- Variable-length presentational lists (the 4 snapshot cells and 4 "how it happened" steps)
-- are stored as JSON columns (fixed cardinality, never queried individually) following the
-- NVARCHAR(MAX) JSON convention used by oe.TrainingLibrary. The user-named figures and the two
-- hero numbers are first-class typed columns so they can be validated/formatted/aggregated.

IF NOT EXISTS (
    SELECT 1
    FROM sys.tables
    WHERE name = 'CaseStudies'
      AND schema_id = SCHEMA_ID('oe')
)
BEGIN
    CREATE TABLE oe.CaseStudies (
        CaseStudyId         UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_CaseStudies_Id      DEFAULT NEWID(),
        VendorId            UNIQUEIDENTIFIER NOT NULL,
        ShareRequestId      UNIQUEIDENTIFIER NULL,            -- source SR; nullable so a story survives SR deletion

        -- Website routing / branding
        Brand               NVARCHAR(50)     NOT NULL CONSTRAINT DF_CaseStudies_Brand   DEFAULT 'MightyWELL',
        Category            NVARCHAR(100)    NULL,            -- chip, e.g. "SELF-PAY ADVOCACY" / "MATERNITY CARE"

        -- Headline + hero comparison (two numbers with custom, editable labels)
        Headline            NVARCHAR(500)    NULL,
        HeroLeftLabel       NVARCHAR(100)    NULL,            -- "Self-Pay Quote" / "Total Care"
        HeroLeftValue       DECIMAL(18,2)    NULL,            -- 29600.00 / 6827.00
        HeroRightLabel      NVARCHAR(100)    NULL,            -- "Negotiated Total" / "Patient Paid"
        HeroRightValue      DECIMAL(18,2)    NULL,            -- 4080.00 / 1500.00

        -- Big percent badge
        PercentValue        INT              NULL,            -- 86 / 78 (rounded for display)
        PercentLabel        NVARCHAR(50)     NULL,            -- "SAVED" / "SHARED"
        PercentSavedShared  DECIMAL(5,2)     NULL,            -- precise percent

        -- Narrative
        BriefDescription    NVARCHAR(MAX)    NULL,            -- brief description of the situation
        OutcomeParagraph    NVARCHAR(MAX)    NULL,            -- 2-4 sentence outcome

        -- Procedure (layman, manually derived from CPT for now -- no AI)
        ProcedureType       NVARCHAR(255)    NULL,            -- "Prolapse Repair"
        CptCodes            NVARCHAR(255)    NULL,            -- raw CPT(s) copied from SR for reference

        -- User-named figures (first-class for validation/formatting)
        TotalBilledAmount   DECIMAL(18,2)    NULL,            -- total amount billed
        TotalPaidToProvider DECIMAL(18,2)    NULL,            -- total paid to the hospital/provider
        AmountSharedByPlan  DECIMAL(18,2)    NULL,            -- amount the plan (ShareWELL) paid
        PatientPaidAmount   DECIMAL(18,2)    NULL,            -- amount the client/patient actually paid
        UnsharedAmount      DECIMAL(18,2)    NULL,            -- UA

        -- Patient quote
        PatientQuote        NVARCHAR(MAX)    NULL,
        QuoteAttribution    NVARCHAR(200)    NULL,            -- "-- SHAREWELL PATIENT"

        -- Variable-length presentational lists as JSON (see header note)
        SnapshotCellsJson   NVARCHAR(MAX)    NULL,            -- JSON array of { label, value, subcaption }
        HowItHappenedJson   NVARCHAR(MAX)    NULL,            -- JSON array of { title, description }

        -- Story-level date (distinct from audit CreatedDate)
        StoryDate           DATE             NULL,

        -- Website visibility
        Status              NVARCHAR(20)     NOT NULL CONSTRAINT DF_CaseStudies_Status  DEFAULT 'Draft',
        IsPublished         BIT              NOT NULL CONSTRAINT DF_CaseStudies_Pub      DEFAULT 0,
        PublishedDate       DATETIME2        NULL,

        -- Audit
        CreatedBy           UNIQUEIDENTIFIER NULL,            -- vendor agent/admin who filled the form
        CreatedDate         DATETIME2        NOT NULL CONSTRAINT DF_CaseStudies_Created  DEFAULT GETUTCDATE(),
        ModifiedBy          UNIQUEIDENTIFIER NULL,
        ModifiedDate        DATETIME2        NOT NULL CONSTRAINT DF_CaseStudies_Modified DEFAULT GETUTCDATE(),

        CONSTRAINT PK_CaseStudies PRIMARY KEY CLUSTERED (CaseStudyId),
        CONSTRAINT FK_CaseStudies_Vendors FOREIGN KEY (VendorId)
            REFERENCES oe.Vendors (VendorId),
        CONSTRAINT FK_CaseStudies_ShareRequests FOREIGN KEY (ShareRequestId)
            REFERENCES oe.ShareRequests (ShareRequestId),
        CONSTRAINT CK_CaseStudies_Status CHECK (Status IN ('Draft', 'Review', 'Published', 'Archived')),
        CONSTRAINT CK_CaseStudies_Brand  CHECK (Brand IN ('MightyWELL', 'ShareWELL'))
    );

    CREATE INDEX IX_CaseStudies_VendorId       ON oe.CaseStudies (VendorId);
    CREATE INDEX IX_CaseStudies_ShareRequestId ON oe.CaseStudies (ShareRequestId);
    -- public website read path: published rows by brand
    CREATE INDEX IX_CaseStudies_Published      ON oe.CaseStudies (IsPublished, Brand) INCLUDE (PublishedDate);
END;
GO
