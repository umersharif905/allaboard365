/**
 * Public, signed (JWT) download for eligibility export files — used in vendor notification emails.
 * No session; token expires in 7 days (see VendorExportService.createEligibilityExportPublicDownloadUrl).
 */

const express = require('express');
const path = require('path');
const router = express.Router();
const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const VendorExportService = require('../../services/vendorExportService');

/** Must match newGroupFormScheduledJobService TEMP_SUBDIR */
const NEW_GROUP_FORM_JOB_TEMP = 'new-group-form-job-downloads';

router.get('/eligibility-download', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token || typeof token !== 'string') {
            return res.status(400).type('text').send('Missing token');
        }
        const secret = process.env.JWT_SECRET || 'your-secret-key';
        let payload;
        try {
            payload = jwt.verify(token, secret);
        } catch (e) {
            if (e.name === 'TokenExpiredError') {
                return res.status(410).type('text').send('This download link has expired (7 days). Request a new export or use SFTP.');
            }
            return res.status(401).type('text').send('Invalid or expired link.');
        }
        if (payload.sub !== 'eligibility-export' || !payload.vendorId || !payload.fileId) {
            return res.status(401).type('text').send('Invalid link.');
        }
        const file = await VendorExportService.getEligibilityExportFile(payload.vendorId, payload.fileId);
        if (!file) {
            return res.status(404).type('text').send('File not found.');
        }
        if (file.eligibilityAzureBlobContainer && file.eligibilityAzureBlobName) {
            const buf = await VendorExportService.downloadEligibilityBlobBuffer(
                file.eligibilityAzureBlobContainer,
                file.eligibilityAzureBlobName
            );
            if (buf && buf.length) {
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"`);
                return res.send(buf);
            }
        }
        const diskPath = await VendorExportService.resolveEligibilityExportDiskPath(payload.vendorId, payload.fileId, file.filePath);
        if (!diskPath) {
            return res.status(404).type('text').send('File is no longer available on the server.');
        }
        res.download(diskPath, file.fileName);
    } catch (error) {
        console.error('public eligibility download:', error);
        res.status(500).type('text').send('Download failed.');
    }
});

/** Time-limited PDF from new_group_form scheduled job (same JWT secret / 7d as eligibility). */
router.get('/new-group-form-job-download', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token || typeof token !== 'string') {
            return res.status(400).type('text').send('Missing token');
        }
        const secret = process.env.JWT_SECRET || 'your-secret-key';
        let payload;
        try {
            payload = jwt.verify(token, secret);
        } catch (e) {
            if (e.name === 'TokenExpiredError') {
                return res.status(410).type('text').send('This download link has expired (7 days).');
            }
            return res.status(401).type('text').send('Invalid or expired link.');
        }
        if (payload.sub !== 'new-group-form-job' || !payload.fileToken) {
            return res.status(401).type('text').send('Invalid link.');
        }
        const filePath = path.join(__dirname, '../../temp', NEW_GROUP_FORM_JOB_TEMP, `${String(payload.fileToken).trim()}.pdf`);
        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).type('text').send('File is no longer available on the server.');
        }
        res.download(filePath, 'NewGroupForm.pdf');
    } catch (error) {
        console.error('public new group form job download:', error);
        res.status(500).type('text').send('Download failed.');
    }
});

module.exports = router;
