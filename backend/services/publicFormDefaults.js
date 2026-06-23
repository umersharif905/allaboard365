/**
 * Default form definitions (JSON) for the three public sharing form kinds.
 * Tenant admins can replace via template version editor.
 */

const UA_INTRO = `Before submitting an Unshared Amount (UA) Sharing Request, confirm your expenses meet Member Guidelines. For preventive sharing, use the Preventive Care form. Do not submit multiple requests for the same bills.`;

const ADDITIONAL_INTRO = `Upload additional documents for an existing sharing request. You must enter your member ID and the request number shown on your prior confirmation.`;

const PREVENTIVE_INTRO = `Submit a preventive care sharing request. Confirm your membership includes preventive sharing benefits.`;

function baseFields(kind) {
    const memberField = {
        name: 'memberId',
        type: 'text',
        label: 'Member ID',
        required: true,
        helperText: 'Enter the member ID from your ID card.'
    };

    const nameFields = [
        { name: 'firstName', type: 'text', label: 'First name', required: true },
        { name: 'lastName', type: 'text', label: 'Last name', required: true }
    ];

    const contact = [
        { name: 'email', type: 'email', label: 'Email', required: true },
        { name: 'phone', type: 'tel', label: 'Phone', required: true, placeholder: '(000) 000-0000' }
    ];

    if (kind === 'AdditionalDocuments') {
        return [
            memberField,
            {
                name: 'existingRequestNumber',
                type: 'text',
                label: 'Existing request number',
                required: true,
                helperText: 'The Share Request number for your open request.'
            },
            {
                name: 'verifyLastName',
                type: 'text',
                label: 'Verify last name',
                required: true,
                helperText: 'Must match the member of record.'
            },
            {
                name: 'verifyDateOfBirth',
                type: 'date',
                label: 'Verify date of birth',
                required: true,
                helperText: 'YYYY-MM-DD — must match our records.'
            },
            ...nameFields,
            ...contact,
            {
                name: 'notes',
                type: 'textarea',
                label: 'Notes for processing staff',
                required: false
            }
        ];
    }

    const common = [
        { name: 'acceptTerms', type: 'checkbox', label: 'I accept the Terms and Conditions.', required: true },
        ...nameFields,
        ...contact,
        memberField,
        {
            name: 'relationToPrimary',
            type: 'select',
            label: 'Relation to primary member',
            required: true,
            options: [
                { value: 'Self', label: 'Self' },
                { value: 'Spouse', label: 'Spouse' },
                { value: 'Child', label: 'Child' }
            ]
        },
        { name: 'dateOfBirth', type: 'date', label: 'Date of birth (member this request is for)', required: true },
        {
            name: 'providerInformation',
            type: 'textarea',
            label: 'Provider information (optional)',
            required: false
        }
    ];

    if (kind === 'PreventiveCare') {
        return [
            ...common,
            {
                name: 'requestDescription',
                type: 'textarea',
                label: 'Describe preventive services',
                required: true
            },
            { name: 'dateOfService', type: 'date', label: 'Date of service (if known)', required: false }
        ];
    }

    // UnsharedAmount
    return [
        ...common,
        {
            name: 'sharingRequestType',
            type: 'select',
            label: 'Sharing request type',
            required: true,
            options: [
                { value: 'Medical', label: 'Miscellaneous / care exceeding UA' },
                { value: 'Maternity', label: 'Maternity' },
                { value: 'MedicalProcedure', label: 'Upcoming or performed procedure' },
                { value: 'Emergency', label: 'Emergency visit' }
            ]
        },
        {
            name: 'detailedDescription',
            type: 'textarea',
            label: 'Describe in detail what happened',
            required: true
        },
        {
            name: 'symptomsStartDate',
            type: 'date',
            label: 'When did symptoms or care for this issue begin?',
            required: true
        },
        {
            name: 'isNewCondition',
            type: 'select',
            label: 'Is this a new condition?',
            required: true,
            options: [
                { value: 'yes', label: 'Yes' },
                { value: 'no', label: 'No' }
            ]
        },
        {
            name: 'uaTier',
            type: 'select',
            label: 'Bills will exceed your Unshared Amount tier',
            required: true,
            options: [
                { value: '1500', label: 'Yes — $1,500 UA' },
                { value: '3000', label: 'Yes — $3,000 UA' },
                { value: '6000', label: 'Yes — $6,000 UA' }
            ]
        },
        {
            name: 'otherInsurance',
            type: 'select',
            label: 'Other insurance (if any)',
            required: false,
            options: [
                { value: '', label: 'None / not applicable' },
                { value: 'Health', label: 'Health insurance' },
                { value: 'Auto', label: 'Auto insurance' },
                { value: 'Medicaid', label: 'Medicaid' },
                { value: 'WorkersComp', label: "Workers' compensation" }
            ]
        },
        {
            name: 'additionalNotes',
            type: 'textarea',
            label: 'Additional information',
            required: false
        },
        { name: 'acceptPhi', type: 'checkbox', label: 'I accept the authorization regarding medical information (PHI).', required: true },
        { name: 'dateOfService', type: 'date', label: 'First date of service (if known)', required: false }
    ];
}

/** Empty definition for tenant-created forms (builder starts from scratch). */
function getBlankCustomDefinitionJson(title) {
    const t = (title || 'New form').trim() || 'New form';
    return JSON.stringify(
        {
            version: 1,
            title: t,
            introHtml: '',
            fields: []
        },
        null,
        2
    );
}

function getDefaultDefinitionJson(formKind) {
    const titles = {
        UnsharedAmount: 'Unshared Amount Sharing Request',
        AdditionalDocuments: 'Additional Document for Existing Request',
        PreventiveCare: 'Preventive Care Sharing Request'
    };
    const intros = {
        UnsharedAmount: UA_INTRO,
        AdditionalDocuments: ADDITIONAL_INTRO,
        PreventiveCare: PREVENTIVE_INTRO
    };

    return JSON.stringify({
        version: 1,
        title: titles[formKind] || 'Sharing Request',
        introHtml: `<p>${intros[formKind] || ''}</p>`,
        fields: baseFields(formKind)
    }, null, 2);
}

module.exports = {
    getDefaultDefinitionJson,
    getBlankCustomDefinitionJson
};
