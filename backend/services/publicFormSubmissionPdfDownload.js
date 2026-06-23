'use strict';

const { buildSubmissionPdfBuffer } = require('./publicFormSubmissionPdfService');
const { buildSubmissionDownloadBasename } = require('./submissionDownloadFilename');

/**
 * @param {{ payload?: unknown }} detail
 * @returns {Record<string, unknown>}
 */
function normalizeSubmissionPayload(detail) {
    if (detail.payload && typeof detail.payload === 'object' && !Array.isArray(detail.payload)) {
        return detail.payload;
    }
    return {};
}

/**
 * Shared path for public + tenant-admin submission PDF downloads: parse definition, build buffer,
 * derive filename. Callers supply auth, detail lookup, and template lookup.
 *
 * @param {{ FormKind?: string|null, payload?: unknown }} detail
 * @param {{ DefinitionJson: string, Title?: string|null }|null|undefined} templateRow
 * @param {{ includeAllFields?: boolean, basenameSuffix: string, templateMissingMessage: string }} opts
 * @returns {Promise<{ ok: true, pdfBuf: Buffer, basename: string } | { ok: false, status: number, body: object }>}
 */
async function buildSubmissionPdfDownload(detail, templateRow, opts) {
    const {
        includeAllFields = false,
        basenameSuffix,
        templateMissingMessage
    } = opts;

    if (!templateRow || !templateRow.DefinitionJson) {
        return {
            ok: false,
            status: 404,
            body: { success: false, message: templateMissingMessage }
        };
    }
    let def;
    try {
        def = JSON.parse(templateRow.DefinitionJson);
    } catch {
        return {
            ok: false,
            status: 500,
            body: { success: false, message: 'Invalid form definition JSON' }
        };
    }
    const payload = normalizeSubmissionPayload(detail);
    const pdfBuf = await buildSubmissionPdfBuffer(def, payload, {
        title: templateRow.Title || detail.FormKind || 'Form submission',
        includeAllFields: !!includeAllFields
    });
    const basename = buildSubmissionDownloadBasename(detail.FormKind, payload, basenameSuffix);
    return { ok: true, pdfBuf, basename };
}

/**
 * @param {import('express').Response} res
 * @param {object} result
 */
function sendSubmissionPdfDownload(res, result) {
    if (!result.ok) {
        return res.status(result.status).json(result.body);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.basename}.pdf"`);
    return res.send(result.pdfBuf);
}

module.exports = {
    buildSubmissionPdfDownload,
    sendSubmissionPdfDownload
};
