'use strict';

/**
 * Enrollment config for ID cards (e.g. unshared amount).
 *
 * - Strips {{ConfigValue1}} placeholders from idCardData when a value resolves (value is shown under
 *   Member Details only, avoiding crowded footer / phone lines).
 * - When there is no token, returns idCardConfigurationDisplay { label, value } for UI only; idCardData unchanged.
 * - If RequiredDataFields is missing but ConfigValue1 / enrollment snapshot resolves, still shows Member Details row (label "Configuration").
 * - In-memory only; never persists to oe.Products.
 */

const CONFIG_TOKEN_REPLACE = /\{\{\s*ConfigValue1\s*\}\}/gi;
const CONFIG_TOKEN_TEST = /\{\{\s*ConfigValue1\s*\}\}/i;

function parseRequiredDataFieldsArray(requiredDataFields) {
    if (!requiredDataFields) return { valid: false, fieldName: 'Configuration' };
    let arr = requiredDataFields;
    if (typeof requiredDataFields === 'string') {
        try {
            arr = JSON.parse(requiredDataFields);
        } catch {
            return { valid: false, fieldName: 'Configuration' };
        }
    }
    if (!Array.isArray(arr) || arr.length === 0) {
        return { valid: false, fieldName: 'Configuration' };
    }
    const fieldName =
        arr[0] && arr[0].fieldName ? String(arr[0].fieldName) : 'Configuration';
    return { valid: true, fieldName };
}

function resolveConfigValue(configValue1, enrollmentDetails) {
    const pricing =
        configValue1 != null && configValue1 !== undefined
            ? String(configValue1).trim()
            : '';
    if (pricing && pricing !== 'Default') return pricing;

    if (enrollmentDetails == null || enrollmentDetails === '') return null;

    const edStr =
        typeof enrollmentDetails === 'string'
            ? enrollmentDetails
            : String(enrollmentDetails);
    if (
        edStr === 'Enrolled via product change' ||
        edStr === 'Updated via product change'
    ) {
        return null;
    }

    try {
        const details =
            typeof enrollmentDetails === 'string'
                ? JSON.parse(enrollmentDetails)
                : enrollmentDetails;
        if (
            details &&
            details.configuration &&
            String(details.configuration) !== 'Default'
        ) {
            return String(details.configuration).trim();
        }
    } catch {
        /* ignore */
    }
    return null;
}

function deepReplaceConfigToken(obj, replacement) {
    if (obj == null) return false;
    if (typeof obj === 'string') return false;
    if (Array.isArray(obj)) {
        let any = false;
        for (let i = 0; i < obj.length; i++) {
            const item = obj[i];
            if (typeof item === 'string' && CONFIG_TOKEN_TEST.test(item)) {
                obj[i] = item.replace(CONFIG_TOKEN_REPLACE, replacement);
                any = true;
            } else if (item && typeof item === 'object') {
                any = deepReplaceConfigToken(item, replacement) || any;
            }
        }
        return any;
    }
    if (typeof obj !== 'object') return false;

    let any = false;
    for (const key of Object.keys(obj)) {
        const v = obj[key];
        if (typeof v === 'string' && CONFIG_TOKEN_TEST.test(v)) {
            obj[key] = v.replace(CONFIG_TOKEN_REPLACE, replacement);
            any = true;
        } else if (v && typeof v === 'object') {
            any = deepReplaceConfigToken(v, replacement) || any;
        }
    }
    return any;
}

function idCardContainsConfigToken(idCardData) {
    return CONFIG_TOKEN_TEST.test(JSON.stringify(idCardData));
}

function cloneIdCardData(data) {
    return JSON.parse(JSON.stringify(data));
}

/**
 * @param {object|null} idCardData - network-resolved layout
 * @param {object} params
 * @param {unknown} params.requiredDataFields - array or JSON string
 * @param {string|null|undefined} params.configValue1
 * @param {string|null|undefined} params.enrollmentDetails
 * @returns {{ data: object|null, idCardConfigurationDisplay: { label: string, value: string } | null, configurationShownInIdCardData: boolean }}
 */
function hydrateIdCardDataWithEnrollmentConfig(idCardData, params) {
    const { requiredDataFields, configValue1, enrollmentDetails } = params;

    if (
        !idCardData ||
        typeof idCardData !== 'object' ||
        idCardData.DisableIDCard === true
    ) {
        return {
            data: idCardData,
            idCardConfigurationDisplay: null,
            configurationShownInIdCardData: false
        };
    }

    const { valid, fieldName } = parseRequiredDataFieldsArray(requiredDataFields);
    const value = resolveConfigValue(configValue1, enrollmentDetails);
    const hasToken = idCardContainsConfigToken(idCardData);

    if (!value && !hasToken) {
        return {
            data: idCardData,
            idCardConfigurationDisplay: null,
            configurationShownInIdCardData: false
        };
    }

    if (!value && hasToken) {
        const cloned = cloneIdCardData(idCardData);
        deepReplaceConfigToken(cloned, '');
        return {
            data: cloned,
            idCardConfigurationDisplay: null,
            configurationShownInIdCardData: false
        };
    }

    const strVal = String(value);
    const display = { label: fieldName, value: strVal };

    // No Step-3 field metadata: still show pricing/snapshot value under Member Details.
    if (!valid) {
        if (hasToken) {
            const cloned = cloneIdCardData(idCardData);
            deepReplaceConfigToken(cloned, '');
            return {
                data: cloned,
                idCardConfigurationDisplay: display,
                configurationShownInIdCardData: true
            };
        }
        return {
            data: idCardData,
            idCardConfigurationDisplay: display,
            configurationShownInIdCardData: true
        };
    }

    if (hasToken) {
        const cloned = cloneIdCardData(idCardData);
        deepReplaceConfigToken(cloned, '');
        return {
            data: cloned,
            idCardConfigurationDisplay: display,
            configurationShownInIdCardData: true
        };
    }

    return {
        data: idCardData,
        idCardConfigurationDisplay: display,
        configurationShownInIdCardData: true
    };
}

module.exports = {
    hydrateIdCardDataWithEnrollmentConfig,
    parseRequiredDataFieldsArray,
    resolveConfigValue
};
