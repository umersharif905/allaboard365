# Problems with the current forms system

The current `PublicForm*` system was built to handle three specific ShareRequest intake workflows. It has grown awkward as the back office tries to use it for general data collection, and has several latent bugs and UX gaps that this redesign addresses.

## 1. Custom forms silently create unwanted ShareRequests

When a tenant admin creates a new "custom" form via the form editor, the system assigns it an auto-generated `FormKind` slug of the form `K_{uuid}`. The share-link workflow special-cases the three seeded slugs (`UnsharedAmount`, `PreventiveCare`, `AdditionalDocuments`) and treats every other slug as if it were `UnsharedAmount`/Medical. The result: every submission to a custom form that gets matched to a member spawns a fresh Medical ShareRequest, even though the form was never intended to start a sharing request. (See `backend/services/publicFormShareLinkService.js:9-19` and the fall-through at line 175.)

There is no way to disable this behavior at the template level today. The only escape hatch is for the form's `FormKind` to be `AdditionalDocuments`, which has its own narrow attach-to-existing-SR flow with hard-coded payload field expectations.

## 2. Hard-coded form taxonomy limits care-team flexibility

The system bakes in three form purposes via `FormKind` slug:

- `UnsharedAmount` — new Medical / Maternity SR intake
- `PreventiveCare` — new Wellness SR intake
- `AdditionalDocuments` — attach files to an existing SR

There is no slot for any other form purpose. Common care-team needs ("send a single ACH form to one member," "send an update-your-contact-info form to a household") have no first-class home. The care team has been creating custom-slug forms as a workaround, which silently activates Problem #1.

## 3. No "send to member" capability

Today, forms are intrinsically broadcast — anyone with the URL can fill them. There is no way for the care team to address a form to a specific known member. As a consequence:

- The recipient must enter their own first name, last name, email, member ID, date of birth, household relationship, etc., on every form. The system already has all of this on the member record.
- There is no audit trail of "who sent what form to which member." All sends are anonymous.
- A recipient cannot click "fill this in" with confidence that the submission lands on their account.

## 4. No authentication option for high-PHI forms

Some forms collect substantial PHI (medical history, claim detail, dependents). The current model is anonymous-by-default. There is no way for a form template to require the recipient to log in to their member portal before filling. As a result, HIPAA-sensitive submissions travel the same path as low-risk anonymous ones.

## 5. The `AdditionalDocuments` verification flow is clunky and weakly secured

To attach documents to an existing SR, the recipient enters the SR's request number plus their last name and date of birth as "verifiers" (`backend/services/publicFormShareLinkService.js:24-44`). This:

- Requires the member to know their request number — usually they don't have it handy.
- Reveals whether a given request number exists in the system (response differs by success/failure path).
- Treats last-name + DOB as authentication, which is weak.

## 6. Submissions are anonymous-first; member linkage happens after-the-fact

The current flow stores submissions anonymously and relies on an admin clicking "resolve member" (or auto-match) to attach them to a Member record. This produces:

- An admin task queue of un-resolved submissions, even when the form was filled in by a known member.
- Member-tab visibility that only appears AFTER an admin acts.
- Inconsistent member linkage when submissions are abandoned mid-resolution.

## 7. No member-profile home for completed forms

Once a submission is resolved to a member, it appears in the submissions list filtered by member, but there is no first-class "Documents" or "Forms" tab on the member profile. To find a member's submitted forms, the care team must navigate to the global submissions page and filter, which is friction-heavy and inconsistent with how care teams expect to use a member profile.

## 8. VendorAgent has UI access to forms but the backend rejects them

The frontend `ProtectedRoute` at `frontend/src/App.tsx` permits both `VendorAdmin` and `VendorAgent` onto `/vendor/sharing-forms`. The backend route file `backend/routes/me/vendor/public-forms.js:21` authorizes only `VendorAdmin` and `SysAdmin`. A vendor agent who reaches the page sees a blank or erroring view. Beyond the broken UX, this also means vendor agents have no read access to forms today, even though their job often involves reviewing submitted information.

## 9. No linkage to Cases (planned care-team workflow)

Cases — a smaller, ticket-style workflow for billing disputes, reimbursement issues, and escalated calls — are planned but not yet implemented. The current forms system has no provision for attaching submissions to a Case. Any future Case implementation will need this; the schema does not currently support it.

## What the redesign delivers

- A per-template policy declaring which delivery modes (`anonymous` / `targeted` / `authenticated`) are permitted, so each form can match its HIPAA/UX requirements.
- A "send to member" flow that issues a single-use signed link, prefills known member fields, attaches the submission to the member's account, and (optionally) links it to a chosen ShareRequest or Case.
- An authenticated submission flow for high-PHI forms with full profile prefill from the member's record.
- A `creates_share_request_on_submit` flag that defaults to OFF, eliminating the silent SR-creation bug for custom forms. The two existing intake templates are explicitly opted in.
- A Member-profile Documents tab as the universal home for any submission tied to a known member.
- Schema-level support for Case linkage so the Cases feature ships without a forms migration.
- A backend access fix for vendor agents that gives them read-only access to forms and submissions.

These changes also reduce manual work for the care team — fewer fields the recipient has to retype, fewer abandoned anonymous submissions to manually resolve, and a single discoverable home per member.
