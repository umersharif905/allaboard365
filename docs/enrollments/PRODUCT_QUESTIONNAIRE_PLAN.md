# Product Questionnaire Feature — Implementation Plan

**Branch:** `enrollment-updates`
**Date:** 2026-03-25
**Status:** Planning

---

## Overview

Add an optional, generic **questionnaire system** to products. Product creators can attach a questionnaire to any product — giving it a title, questions, and answer types. When a member enrolls in a product (or a bundle containing that product), the questionnaire appears as a required step in the enrollment wizard.

The immediate use case is a "Major Pre-Existing Conditions Notice" for ShareWELL plans, but the feature is generic — any product can have its own questionnaire with its own title and questions.

Additionally, **height and weight** collection is being added as a product-level setting, collected conditionally in the member info step alongside tobacco use.

---

## Tyler's Original Requirements (ShareWELL)

- **Title:** "Major Pre-Existing Conditions Notice"
- **Body:** "Certain major conditions have pre-existing limitations under our Member Guidelines..."
- **Questions (Yes/No):**
  - Gallbladder-related issues (24 months)
  - Kidney stones (24 months)
  - Tumors, benign or malignant (24 months)
  - Cancer, any form (36 months)
- **Required acknowledgement checkbox**
- **Gold/Silver plans** do not apply the 90-day exclusion (but still show the questionnaire for disclosure)
- **Height/Weight** to be collected for individual plans

**Note:** The ShareWELL questionnaire will NOT be pre-populated by code. It will be manually created by a user through the AddProductWizard questionnaire builder as a test of the feature.

---

## Architecture Decisions

### 1. Generic Questionnaire, Not "Pre-Existing Conditions" Specific

The system is a **product questionnaire builder**. The product creator defines:
- A title (shows as the tab/step name in enrollment)
- A description/body text
- Questions with configurable answer types (yes/no, text, checkbox, dropdown, etc.)
- An optional required acknowledgement checkbox with custom text

This keeps the feature reusable for any product that needs enrollment-time questions.

### 2. Store Questionnaire Definitions on the Products Table

**New column:** `ProductQuestionnaires NVARCHAR(MAX) NULL` on `oe.Products`

This follows the exact same pattern as the existing `AcknowledgementQuestions` column. Same ownership model, same marketplace immutability, same bundle inheritance.

### 3. Store Member Responses in EnrollmentDetails

Questionnaire responses are stored in the existing `Enrollments.EnrollmentDetails` NVARCHAR(MAX) JSON column. No new response tables needed.

### 4. Height/Weight on Members Table (Conditional by Product)

`Height INT NULL` and `Weight INT NULL` columns on `oe.Members`, following the same pattern as `TobaccoUse`. Collected in the member info step, stored per-member (not per-enrollment).

**Conditional display:** Height/weight fields only appear in the member info step when any product available in the enrollment link has `requiresHeightWeight: true` in its `ProductQuestionnaires` JSON. This is checked when enrollment data is loaded (the enrollment data endpoint returns all available products with their metadata, so the frontend knows upfront whether height/weight is needed).

This means:
- ShareWELL products can require height/weight
- If ShareWELL is in a bundle, the bundle inherits the requirement
- Tenants using products that don't need height/weight won't see the fields
- Product owner controls whether height/weight is collected

**Note:** Tobacco use is always shown (hardcoded, not conditional). Height/weight is different — it is product-driven.

### 5. Product Owner Owns the Questionnaire

Whoever creates the product defines the questionnaire. Marketplace subscribers **cannot** override it. This matches how `AcknowledgementQuestions` already works.

### 6. Bundles Inherit Questionnaires from Included Products

When a bundle includes a product with a questionnaire, the enrollment wizard shows that questionnaire. Uses the same JOIN through `ProductBundles` that already exists for acknowledgements. Same logic applies for the `requiresHeightWeight` flag — if any included product requires it, height/weight is collected.

---

## Database Changes

### Migration 1: Add ProductQuestionnaires column to Products

```sql
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Products') AND name = 'ProductQuestionnaires'
)
BEGIN
  ALTER TABLE oe.Products
  ADD ProductQuestionnaires NVARCHAR(MAX) NULL;
  PRINT 'Added ProductQuestionnaires to oe.Products';
END
```

### Migration 2: Add Height and Weight to Members

```sql
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Members') AND name = 'Height'
)
BEGIN
  ALTER TABLE oe.Members ADD Height INT NULL;
  PRINT 'Added Height (inches) to oe.Members';
END

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Members') AND name = 'Weight'
)
BEGIN
  ALTER TABLE oe.Members ADD Weight INT NULL;
  PRINT 'Added Weight (pounds) to oe.Members';
END
```

### No New Tables

Questionnaire definitions live in `Products.ProductQuestionnaires` (JSON).
Member responses live in `Enrollments.EnrollmentDetails` (JSON).
Height/weight live as columns on `Members`.

---

## ProductQuestionnaires JSON Schema

Stored in `Products.ProductQuestionnaires`:

```json
{
  "version": 1,
  "enabled": true,
  "title": "Your Questionnaire Title Here",
  "description": "Description text shown to the member.",
  "questions": [
    {
      "id": "unique-question-id",
      "text": "The question text shown to the member?",
      "type": "yes_no",
      "required": true
    }
  ],
  "acknowledgement": {
    "required": true,
    "text": "Acknowledgement text the member must agree to."
  },
  "requiresHeightWeight": false
}
```

**Supported question types:** `yes_no`, `text`, `textarea`, `checkbox`, `dropdown`, `number`

The title from the JSON is what appears as the step/tab name in the enrollment wizard.

---

## Response Storage (in EnrollmentDetails)

When a member completes the questionnaire, their answers are stored in `Enrollments.EnrollmentDetails`:

```json
{
  "...existing fields (configuration, etc.)...",
  "questionnaireResponses": {
    "productId": "uuid-of-product-with-questionnaire",
    "questionnaireVersion": 1,
    "answeredAt": "2026-03-25T14:30:00Z",
    "answers": [
      { "questionId": "question-id-1", "answer": false },
      { "questionId": "question-id-2", "answer": true }
    ],
    "acknowledgementAccepted": true,
    "acknowledgedAt": "2026-03-25T14:30:00Z"
  }
}
```

---

## Enrollment Wizard — Step Order

```
1. Member Info (name, DOB, SSN, tobacco, HEIGHT/WEIGHT if product requires, etc.)
2. Household Info
3. Product Selection (one step per product category)
4. PRODUCT QUESTIONNAIRE (new — conditional, only if selected products have one)
5. Dependents (conditional)
6. Effective Date
7. Payment Method (individual only)
8. Acknowledgements
9. Confirmation
10. Password Setup
```

**Key placement rationale:** The questionnaire goes immediately after product selection and BEFORE dependents/payment. This is intentional — the questionnaire acts as a deterrent for the pre-existing conditions use case. Members with pre-existing conditions encounter this early so they don't waste time filling out dependents and payment info.

**Dynamic visibility:** The step only appears if ANY selected product (or any product included in a selected bundle) has a non-null `ProductQuestionnaires` with `enabled: true`.

**Step title:** Uses the `title` from the product's questionnaire JSON (e.g., "Major Pre-Existing Conditions Notice"), not a hardcoded label.

**Questionnaire is per-primary-member only.** Not per-dependent.

---

## Enrollment Wizard — Implementation Details

### New Component: `ProductQuestionnaireStep.tsx`

A generic, self-contained component that renders whatever questionnaire a product defines.

**Renders:**
- Questionnaire title (from product JSON — this is the tab/step name)
- Description/body text
- Each question with appropriate input based on type (yes/no radio buttons, text fields, etc.)
- Required acknowledgement checkbox (if configured)
- Validation: all required questions answered + acknowledgement checked

### New State in EnrollmentWizard.tsx

```typescript
const [hasQuestionnairesRequired, setHasQuestionnairesRequired] = useState(false);
const [questionnaireData, setQuestionnaireData] = useState(null);
const [questionnaireResponses, setQuestionnaireResponses] = useState({});
const [questionnaireAcknowledged, setQuestionnaireAcknowledged] = useState(false);
```

Mirrors the existing `hasAcknowledgementsRequired` pattern.

### Height/Weight in Member Info

```typescript
// Added to MemberInfoData interface
height?: number;  // total inches (e.g., 70 for 5'10")
weight?: number;  // pounds

// Conditional display — check at enrollment data load
const requiresHeightWeight = enrollmentData?.productSections?.some(section =>
  section.products?.some(product => {
    const q = product.productQuestionnaires;
    return q?.requiresHeightWeight === true;
  })
) || false;

// Also check bundle included products for the flag
```

**UI:** Two inputs alongside tobacco use — height as feet + inches, weight as pounds.

### Step Generation

In `generateSteps()`, insert the questionnaire step after the last product section step and before dependents, only when `hasQuestionnairesRequired` is true.

### Submission

`questionnaireResponses` included in the `submitEnrollment()` payload. Backend validates and stores in `EnrollmentDetails`.

---

## AddProductWizard — Where Questionnaire Builder Goes

### Location: Existing Acknowledgements Step (Step 5) — New Section

**Not a separate wizard step.** The questionnaire builder is a collapsible section within the existing Acknowledgements step in AddProductWizard.

### UI Layout

```
Step 5: Acknowledgement Questions
|-- [Existing acknowledgement question builder]
|
|-- ----------------------------------------
|
|-- Product Questionnaire (Optional)
|   |-- Toggle: "Enable Product Questionnaire" [ON/OFF]
|   |
|   |-- (When ON):
|   |   |-- Title: [_________________________________]
|   |   |   (This title becomes the enrollment step/tab name)
|   |   |-- Description: [__________________________]
|   |   |
|   |   |-- Questions:
|   |   |   |-- Q1: [question text] | Type: [yes_no v] | Required: [check]
|   |   |   |-- Q2: [question text] | Type: [text v]   | Required: [check]
|   |   |   |-- [+ Add Question]
|   |   |
|   |   |-- Acknowledgement:
|   |   |   |-- Toggle: "Require acknowledgement checkbox" [ON/OFF]
|   |   |   |-- Acknowledgement text: [________________]
|   |   |
|   |   |-- Health Metrics:
|   |   |   |-- Toggle: "Require Height/Weight" [ON/OFF]
```

### Save

When the product is saved, `ProductQuestionnaires` JSON is written to the `Products.ProductQuestionnaires` column.

---

## Bundle Inheritance

When a member selects a bundle product during enrollment:

1. System checks the bundle product itself for `ProductQuestionnaires`
2. System JOINs through `ProductBundles` to check all included products for `ProductQuestionnaires`
3. All found questionnaires are collected and presented in the questionnaire step
4. Each product's questionnaire is shown with its own title and questions
5. Responses are stored per-product in `EnrollmentDetails`
6. `requiresHeightWeight` is true if ANY product in the bundle (or included products) has it set

**SQL pattern** (mirrors existing acknowledgements query):
```sql
-- Direct products
SELECT p.ProductId, p.Name, p.ProductQuestionnaires
FROM oe.Products p
WHERE p.ProductId IN (@selectedProducts)
  AND p.ProductQuestionnaires IS NOT NULL

UNION ALL

-- Bundle included products
SELECT p.ProductId, p.Name, p.ProductQuestionnaires
FROM oe.ProductBundles pb
INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
WHERE pb.BundleProductId IN (@selectedProducts)
  AND p.ProductQuestionnaires IS NOT NULL
```

---

## Backend Changes Summary

| Area | Change |
|------|--------|
| **Products CRUD** | Read/write `ProductQuestionnaires` JSON in existing product endpoints |
| **Enrollment Links — enrollment data** | Include `ProductQuestionnaires` and `requiresHeightWeight` flag from products (and bundle-included products) in enrollment data response |
| **Enrollment Links — complete enrollment** | Accept `questionnaireResponses` in payload, validate required answers, store in `EnrollmentDetails` |
| **Member creation/update** | Accept and store `height` and `weight` on Members table |
| **Bundle query** | Extend existing acknowledgement JOIN to also pull `ProductQuestionnaires` |

---

## Frontend Changes Summary

| Area | Change |
|------|--------|
| **EnrollmentWizard.tsx** | New state for questionnaire data/responses, dynamic step insertion after product selection, include responses in submission, conditional height/weight in member info |
| **New: ProductQuestionnaireStep.tsx** | Generic self-contained component rendering questionnaire from product JSON |
| **Member Info step** | Conditional height/weight fields (feet+inches, pounds) — shown when any product has `requiresHeightWeight: true` |
| **AddProductWizard — Step 5** | New "Product Questionnaire" collapsible section with builder UI |
| **enrollment.service.ts** | Updated types for questionnaire responses in enrollment payload |

---

## Build Phases

### Phase 1 — Database Migrations (Day 1)
- Add `ProductQuestionnaires` column to Products
- Add `Height` and `Weight` columns to Members
- Run migrations on dev database (`allaboard-testing`)

### Phase 2 — Backend API (Days 1-3)
- Update Product CRUD to handle `ProductQuestionnaires`
- Update enrollment link data endpoint to return questionnaire data (including bundle inheritance)
- Update enrollment submission to accept/validate/store questionnaire responses
- Update member creation/update to handle height/weight

### Phase 3 — AddProductWizard Builder UI (Days 3-5)
- Add questionnaire builder section to Step 5
- Question CRUD (add/edit/remove/reorder)
- Answer type selection
- Acknowledgement text config
- Height/weight toggle
- **User manually creates a questionnaire on a ShareWELL product to test**

### Phase 4 — Enrollment Wizard Step (Days 5-8)
- Build `ProductQuestionnaireStep.tsx` (generic component)
- Wire up dynamic step visibility after product selection
- Height/weight fields in member info (conditional on product flag)
- Validation (all required answers + acknowledgement)
- Include in enrollment submission payload

### Phase 5 — Polish & Testing (Days 8-10)
- Bundle inheritance testing
- Mobile responsiveness
- Edge cases (no questionnaire, multiple questionnaires from bundle)
- E2E test walkthrough

---

## What We Are NOT Building

| Item | Why Not |
|------|---------|
| Separate QuestionnaireResponses table | EnrollmentDetails JSON is sufficient |
| Audit trail table | Not required for yes/no disclosures at this stage |
| MemberHealthMetrics table | Height/weight stored directly on Members table |
| Encryption of questionnaire responses | These are yes/no answers, not PHI identifiers |
| Data retention / auto-expiry | Not requested |
| Questionnaire versioning infrastructure | Version number in JSON is enough |
| Per-dependent questionnaires | Primary member only for now |
| Generic form builder engine | Simple question list with types is sufficient |
| Pre-populated ShareWELL questionnaire | User will create this manually through the UI as a test |

---

## Testing Plan

1. **Create a questionnaire** on a ShareWELL product via AddProductWizard builder
2. **Create an enrollment link** that includes that product (or a bundle containing it)
3. **Walk through enrollment** — verify questionnaire step appears after product selection with correct title
4. **Answer questions** — verify validation (can't skip required questions or acknowledgement)
5. **Complete enrollment** — verify responses stored in EnrollmentDetails
6. **Test bundles** — verify questionnaire appears when bundle includes a product with questionnaire
7. **Test without questionnaire** — verify step is skipped when product has no questionnaire
8. **Height/weight** — verify fields appear in member info only when product has `requiresHeightWeight: true`, stored on Members table
9. **Test without height/weight** — verify fields hidden when no product requires it
