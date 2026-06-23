// routes/me/vendor/cases.js
// Cases — back-office vendor portal. Renamed from Cases on 2026-05-19.
// Only VendorAdmin / VendorAgent can access.

const express = require('express');
const multer = require('multer');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const { attachVendorContext } = require('../../../middleware/shareRequestAccess');
const CaseService = require('../../../services/caseService');
const CaseFinanceService = require('../../../services/caseFinanceService');
const FinanceSummaryService = require('../../../services/financeSummaryService');
const TaxonomyService = require('../../../services/caseTaxonomyService');
const HistoryTimelineService = require('../../../services/historyTimelineService');
const { sendNoteMentionEmails } = require('../../../services/noteMentionService');
const { MAX_LARGE_UPLOAD_BYTES } = require('../../../constants/uploadLimits');

router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(attachVendorContext);

const userDisplayName = (req) =>
    `${req.user?.FirstName || req.user?.firstName || ''} ${req.user?.LastName || req.user?.lastName || ''}`.trim() || null;

let caseBlobClient;
try {
    const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (cs) {
        caseBlobClient = BlobServiceClient.fromConnectionString(cs);
        console.log('✅ Azure Blob client initialized for case documents');
    }
} catch (e) {
    console.error('❌ Failed to init Azure Blob client (cases):', e.message);
}

const uploadMulter = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_LARGE_UPLOAD_BYTES, files: 10 },
    fileFilter: (req, file, cb) => {
        const allowed = new Set([
            'application/pdf', 'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/csv',
            'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp'
        ]);
        return allowed.has(file.mimetype) ? cb(null, true) : cb(new Error(`File type ${file.mimetype} not allowed`));
    }
});

// ---------------------------------------------------------------------------
// META / DASHBOARD
// ---------------------------------------------------------------------------

router.get('/dashboard', async (req, res) => {
    try {
        const stats = await CaseService.getDashboardStats(req.vendor.VendorId);
        res.json({ success: true, data: stats });
    } catch (err) {
        console.error('❌ cases dashboard:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch dashboard', error: err.message });
    }
});

router.get('/statuses', (req, res) => {
    res.json({ success: true, data: CaseService.CASE_STATUSES });
});

router.get('/taxonomy', async (req, res) => {
    try {
        const types = await TaxonomyService.getActiveTaxonomy(req.vendor.VendorId);
        res.json({ success: true, data: { types } });
    } catch (err) {
        console.error('❌ cases taxonomy:', err);
        res.status(500).json({ success: false, message: 'Failed to load taxonomy', error: err.message });
    }
});

// ---------------------------------------------------------------------------
// ADMIN: taxonomy editor (VendorAdmin only)
// ---------------------------------------------------------------------------

const adminOnly = authorize(['VendorAdmin']);

router.get('/admin/taxonomy', adminOnly, async (req, res) => {
    try {
        const types = await TaxonomyService.getFullTaxonomy(req.vendor.VendorId);
        res.json({ success: true, data: { types } });
    } catch (err) {
        console.error('❌ admin taxonomy list:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/admin/types', adminOnly, async (req, res) => {
    try {
        const created = await TaxonomyService.createType(
            req.vendor.VendorId,
            { label: req.body?.label, sortOrder: req.body?.sortOrder },
            req.user.UserId
        );
        res.status(201).json({ success: true, data: created });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ admin createType:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.put('/admin/types/reorder', adminOnly, async (req, res) => {
    try {
        await TaxonomyService.reorderTypes(
            req.vendor.VendorId,
            req.body?.orderedTypeIds,
            req.user.UserId
        );
        res.json({ success: true });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ admin reorderTypes:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.put('/admin/types/:typeId', adminOnly, async (req, res) => {
    try {
        await TaxonomyService.updateType(
            req.vendor.VendorId,
            req.params.typeId,
            {
                label: req.body?.label,
                isActive: req.body?.isActive,
                sortOrder: req.body?.sortOrder
            },
            req.user.UserId
        );
        res.json({ success: true });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ admin updateType:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.post('/admin/types/:typeId/subcategories', adminOnly, async (req, res) => {
    try {
        const created = await TaxonomyService.createSubcategory(
            req.vendor.VendorId,
            req.params.typeId,
            { label: req.body?.label, sortOrder: req.body?.sortOrder },
            req.user.UserId
        );
        res.status(201).json({ success: true, data: created });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ admin createSubcategory:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.put('/admin/subcategories/reorder', adminOnly, async (req, res) => {
    try {
        await TaxonomyService.reorderSubcategories(
            req.vendor.VendorId,
            req.body?.typeId,
            req.body?.orderedSubcategoryIds,
            req.user.UserId
        );
        res.json({ success: true });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ admin reorderSubcategories:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.put('/admin/subcategories/:subcategoryId', adminOnly, async (req, res) => {
    try {
        await TaxonomyService.updateSubcategory(
            req.vendor.VendorId,
            req.params.subcategoryId,
            {
                label: req.body?.label,
                isActive: req.body?.isActive,
                sortOrder: req.body?.sortOrder
            },
            req.user.UserId
        );
        res.json({ success: true });
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error('❌ admin updateSubcategory:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

// Must come before GET /:id so the literal segment isn't swallowed.
router.get('/claimers', async (req, res) => {
    try {
        const claimers = await CaseService.getClaimers(req.vendor.VendorId, req.user.UserId);
        res.json({ success: true, data: claimers });
    } catch (err) {
        console.error('❌ cases claimers:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch assignees', error: err.message });
    }
});

// ---------------------------------------------------------------------------
// LIST + CRUD
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
    try {
        let claimedByUserId = req.query.claimedByUserId;
        if (claimedByUserId === 'me') claimedByUserId = req.user.UserId;

        const result = await CaseService.listCases(req.vendor.VendorId, {
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status,
            caseType: req.query.caseType,
            caseSubcategory: req.query.caseSubcategory,
            memberId: req.query.memberId,
            q: req.query.q || req.query.search,
            claimed: req.query.claimed,
            claimedByUserId
        });
        res.json({ success: true, data: result.data, pagination: result.pagination });
    } catch (err) {
        console.error('❌ cases list:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch cases', error: err.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const row = await CaseService.getCaseById(req.vendor.VendorId, req.params.id);
        if (!row) return res.status(404).json({ success: false, message: 'Case not found' });
        res.json({ success: true, data: row });
    } catch (err) {
        console.error('❌ case get:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch case', error: err.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const { memberId, title, description, status, caseType, caseSubcategory, subcategoryDetail } = req.body || {};
        if (!memberId) return res.status(400).json({ success: false, message: 'memberId is required' });

        const row = await CaseService.createCase(req.vendor.VendorId, {
            memberId, title, description, status,
            caseType, caseSubcategory, subcategoryDetail,
            userId: req.user.UserId,
            userName: userDisplayName(req)
        });
        res.status(201).json({ success: true, data: row });
    } catch (err) {
        const status = err.statusCode || 500;
        console.error('❌ case create:', err);
        res.status(status).json({ success: false, message: err.message || 'Failed to create case' });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const row = await CaseService.updateCase(req.vendor.VendorId, req.params.id, {
            title: req.body?.title,
            description: req.body?.description,
            caseType: req.body?.caseType,
            caseSubcategory: req.body?.caseSubcategory,
            subcategoryDetail: req.body?.subcategoryDetail,
            userId: req.user.UserId,
            userName: userDisplayName(req)
        });
        res.json({ success: true, data: row });
    } catch (err) {
        const status = err.statusCode || 500;
        console.error('❌ case update:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.put('/:id/status', async (req, res) => {
    try {
        const row = await CaseService.updateStatus(req.vendor.VendorId, req.params.id, {
            status: req.body?.status,
            userId: req.user.UserId,
            userName: userDisplayName(req)
        });
        res.json({ success: true, data: row });
    } catch (err) {
        const status = err.statusCode || 500;
        console.error('❌ case status:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// CLAIM
// ---------------------------------------------------------------------------

// Assignment-changing endpoints are VendorAdmin-only. VendorAgents see the
// claim status read-only; admins drive every claim / unclaim / reassign,
// including self-assignment. Mirrors the ShareRequest rules.
function requireVendorAdmin(req, res) {
    const isAdmin = Array.isArray(req.user.roles)
        && req.user.roles.includes('VendorAdmin');
    if (!isAdmin) {
        res.status(403).json({
            success: false,
            message: 'Only Vendor Admins can change case assignments'
        });
        return false;
    }
    return true;
}

router.post('/:id/claim', async (req, res) => {
    if (!requireVendorAdmin(req, res)) return;
    try {
        const row = await CaseService.claimCase(req.vendor.VendorId, req.params.id, {
            userId: req.user.UserId,
            userName: userDisplayName(req)
        });
        res.json({ success: true, data: row });
    } catch (err) {
        const status = err.statusCode || 500;
        if (err.code === 'ALREADY_CLAIMED') {
            return res.status(409).json({ success: false, message: err.message, code: err.code });
        }
        console.error('❌ case claim:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.delete('/:id/claim', async (req, res) => {
    if (!requireVendorAdmin(req, res)) return;
    try {
        const row = await CaseService.unclaimCase(req.vendor.VendorId, req.params.id, {
            userId: req.user.UserId,
            userName: userDisplayName(req)
        });
        res.json({ success: true, data: row });
    } catch (err) {
        const status = err.statusCode || 500;
        console.error('❌ case unclaim:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.put('/:id/claim', async (req, res) => {
    if (!requireVendorAdmin(req, res)) return;
    try {
        const newUserId = req.body?.claimedByUserId;
        if (!newUserId) return res.status(400).json({ success: false, message: 'claimedByUserId required' });
        const row = await CaseService.reassignCase(req.vendor.VendorId, req.params.id, {
            newUserId,
            userId: req.user.UserId,
            userName: userDisplayName(req)
        });
        res.json({ success: true, data: row });
    } catch (err) {
        const status = err.statusCode || 500;
        console.error('❌ case reassign:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// NOTES (+ activity log if includeAudit=1)
// ---------------------------------------------------------------------------

router.get('/:id/notes', async (req, res) => {
    try {
        const includeAuditEvents = req.query.includeAudit === '1' || req.query.includeAudit === 'true';
        const notes = await CaseService.listNotes(req.vendor.VendorId, req.params.id, { includeAuditEvents });
        res.json({ success: true, data: notes });
    } catch (err) {
        const status = err.statusCode || 500;
        console.error('❌ case notes list:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

router.post('/:id/notes', async (req, res) => {
    try {
        const note = await CaseService.addNote(req.vendor.VendorId, req.params.id, {
            note: req.body?.note,
            isInternal: req.body?.isInternal !== false,
            userId: req.user.UserId,
            userName: userDisplayName(req)
        });

        const mentionedUserIds = req.body?.mentionedUserIds;
        if (Array.isArray(mentionedUserIds) && mentionedUserIds.length > 0) {
            const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
            sendNoteMentionEmails({
                authorUserId: req.user.UserId,
                authorName: userDisplayName(req),
                mentionedUserIds,
                vendorId: req.vendor.VendorId,
                contextType: 'case',
                contextId: req.params.id,
                noteText: req.body?.note,
                baseUrl
            }).catch((e) => console.error('[case notes] mention emails failed:', e.message));
        }

        res.status(201).json({ success: true, data: note });
    } catch (err) {
        const status = err.statusCode || 500;
        console.error('❌ case note add:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// HISTORY (read-only unified timeline — backs the History tab)
// ---------------------------------------------------------------------------

router.get('/:id/history', async (req, res) => {
    try {
        const events = await HistoryTimelineService.getTimeline('case', req.params.id, req.vendor.VendorId);
        res.json({ success: true, data: events });
    } catch (err) {
        const status = err.statusCode || 500;
        console.error('❌ case history:', err);
        res.status(status).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// PROVIDERS
// ---------------------------------------------------------------------------

router.get('/:id/providers', async (req, res) => {
    try {
        const data = await CaseService.listProviders(req.vendor.VendorId, req.params.id);
        res.json({ success: true, data });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, message: err.message });
    }
});

router.post('/:id/providers', async (req, res) => {
    try {
        const row = await CaseService.addProvider(req.vendor.VendorId, req.params.id, {
            providerId: req.body?.providerId,
            providerRole: req.body?.providerRole,
            notes: req.body?.notes,
            userId: req.user.UserId
        });
        res.status(201).json({ success: true, data: row });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, message: err.message });
    }
});

router.delete('/:id/providers/:caseProviderId', async (req, res) => {
    try {
        const removed = await CaseService.removeProvider(req.vendor.VendorId, req.params.id, req.params.caseProviderId);
        if (!removed) return res.status(404).json({ success: false, message: 'Provider link not found' });
        res.json({ success: true });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// FINANCES — summary, bills, transactions (ledger)
// ---------------------------------------------------------------------------

const actorOf = (req) => ({ userId: req.user.UserId, userName: userDisplayName(req) });

router.get('/:id/finance-summary', async (req, res) => {
    try {
        // Vendor-scoped: getCaseSummary returns null if the case isn't this
        // vendor's, so finances never leak cross-tenant.
        const summary = await FinanceSummaryService.getCaseSummary(req.params.id, req.vendor.VendorId);
        if (!summary) {
            return res.status(404).json({ success: false, message: 'Case not found' });
        }
        res.json({ success: true, data: summary });
    } catch (err) {
        console.error('❌ Error computing case finance summary:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

// --- Bills ---
router.get('/:id/bills', async (req, res) => {
    try {
        const bills = await CaseFinanceService.getBills(req.vendor.VendorId, req.params.id);
        res.json({ success: true, data: bills });
    } catch (err) {
        console.error('❌ Error fetching case bills:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

router.post('/:id/bills', async (req, res) => {
    try {
        const result = await CaseFinanceService.createBill(req.vendor.VendorId, req.params.id, req.body, actorOf(req));
        res.status(201).json({ success: true, data: result, message: 'Bill created successfully' });
    } catch (err) {
        console.error('❌ Error creating case bill:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

router.put('/:id/bills/:billId', async (req, res) => {
    try {
        const result = await CaseFinanceService.updateBill(req.vendor.VendorId, req.params.billId, req.body, actorOf(req));
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message });
        }
        res.json({ success: true, message: 'Bill updated successfully' });
    } catch (err) {
        console.error('❌ Error updating case bill:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

router.delete('/:id/bills/:billId', async (req, res) => {
    try {
        const result = await CaseFinanceService.deleteBill(req.vendor.VendorId, req.params.id, req.params.billId, actorOf(req));
        if (!result.success) {
            return res.status(404).json({ success: false, message: result.message });
        }
        res.json({ success: true, message: 'Bill deleted successfully' });
    } catch (err) {
        console.error('❌ Error deleting case bill:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

// --- Transactions (ledger) ---
router.get('/:id/transactions', async (req, res) => {
    try {
        const transactions = await CaseFinanceService.getTransactions(req.vendor.VendorId, req.params.id);
        res.json({ success: true, data: transactions });
    } catch (err) {
        console.error('❌ Error fetching case transactions:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

router.post('/:id/transactions', async (req, res) => {
    try {
        const { transactionType, amount } = req.body;
        if (!transactionType) {
            return res.status(400).json({ success: false, message: 'Transaction type is required' });
        }
        if (amount === undefined || amount === null) {
            return res.status(400).json({ success: false, message: 'Amount is required' });
        }
        const result = await CaseFinanceService.createTransaction(req.vendor.VendorId, req.params.id, req.body, actorOf(req));
        res.status(201).json({ success: true, data: result, message: 'Transaction created successfully' });
    } catch (err) {
        console.error('❌ Error creating case transaction:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

router.put('/:id/transactions/:transactionId', async (req, res) => {
    try {
        const result = await CaseFinanceService.updateTransaction(req.vendor.VendorId, req.params.transactionId, req.body, actorOf(req));
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message });
        }
        res.json({ success: true, message: 'Transaction updated successfully' });
    } catch (err) {
        console.error('❌ Error updating case transaction:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

router.delete('/:id/transactions/:transactionId', async (req, res) => {
    try {
        const result = await CaseFinanceService.deleteTransaction(req.vendor.VendorId, req.params.id, req.params.transactionId, actorOf(req));
        if (!result.success) {
            return res.status(404).json({ success: false, message: result.message });
        }
        res.json({ success: true, message: 'Transaction deleted successfully' });
    } catch (err) {
        console.error('❌ Error deleting case transaction:', err);
        res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// DOCUMENTS
// ---------------------------------------------------------------------------

// Public-form submissions linked to this case (Documents and Forms tab).
router.get('/:id/form-submissions', async (req, res) => {
    try {
        const subs = await CaseService.listFormSubmissions(req.vendor.VendorId, req.params.id);
        res.json({ success: true, data: subs });
    } catch (err) {
        console.error('❌ Error fetching case form-submissions:', err);
        res.status(err.statusCode || 500).json({ success: false, message: 'Failed to fetch form submissions' });
    }
});

router.get('/:id/documents', async (req, res) => {
    try {
        const docs = await CaseService.listDocuments(req.vendor.VendorId, req.params.id);
        const enriched = await Promise.all(docs.map(async (doc) => {
            if (doc.BlobUrl && caseBlobClient) {
                try {
                    const containerClient = caseBlobClient.getContainerClient('members');
                    const blobPath = doc.BlobPath || doc.BlobUrl.split('/members/')[1]?.split('?')[0];
                    if (blobPath) {
                        const expiresOn = new Date();
                        expiresOn.setHours(expiresOn.getHours() + 1);
                        const sas = generateBlobSASQueryParameters({
                            containerName: 'members',
                            blobName: blobPath,
                            permissions: BlobSASPermissions.parse('r'),
                            expiresOn,
                            startsOn: new Date()
                        }, caseBlobClient.credential).toString();
                        doc.AuthenticatedUrl = `${containerClient.getBlockBlobClient(blobPath).url}?${sas}`;
                    }
                } catch (e) {
                    console.warn('case docs SAS failed:', e.message);
                    doc.AuthenticatedUrl = doc.BlobUrl;
                }
            }
            return doc;
        }));
        res.json({ success: true, data: enriched });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, message: err.message });
    }
});

router.post('/:id/documents/upload', uploadMulter.array('files', 10), async (req, res) => {
    try {
        if (!caseBlobClient) return res.status(503).json({ success: false, message: 'Storage service unavailable' });

        const caseRow = await CaseService.getCaseById(req.vendor.VendorId, req.params.id);
        if (!caseRow) return res.status(404).json({ success: false, message: 'Case not found' });
        if (!caseRow.HouseholdId) {
            return res.status(400).json({ success: false, message: 'Case has no associated household' });
        }

        const files = req.files || [];
        if (files.length === 0) return res.status(400).json({ success: false, message: 'No files uploaded' });

        const { documentType, description } = req.body;
        const containerClient = caseBlobClient.getContainerClient('members');
        await containerClient.createIfNotExists();

        const uploaded = [];
        for (const file of files) {
            const ext = file.originalname.split('.').pop();
            const uniqueName = `${uuidv4()}.${ext}`;
            const blobPath = `${caseRow.HouseholdId}/cases/${caseRow.CaseId}/${uniqueName}`;
            const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
            await blockBlobClient.uploadData(file.buffer, {
                blobHTTPHeaders: { blobContentType: file.mimetype },
                metadata: {
                    originalName: encodeURIComponent(file.originalname),
                    caseId: caseRow.CaseId,
                    householdId: String(caseRow.HouseholdId)
                }
            });
            const rec = await CaseService.createDocumentRecord(req.vendor.VendorId, caseRow.CaseId, {
                documentName: file.originalname,
                documentType: documentType || 'General',
                fileName: uniqueName,
                fileSize: file.size,
                mimeType: file.mimetype,
                blobUrl: blockBlobClient.url,
                blobPath,
                description: description || null,
                uploadedBy: 'Vendor',
                userId: req.user.UserId
            });
            uploaded.push({ documentId: rec.DocumentId, documentName: file.originalname });
        }
        res.status(201).json({ success: true, data: uploaded });
    } catch (err) {
        console.error('❌ case doc upload:', err);
        res.status(500).json({ success: false, message: 'Document upload failed', error: err.message });
    }
});

router.delete('/:id/documents/:documentId', async (req, res) => {
    try {
        const ok = await CaseService.softDeleteDocument(req.vendor.VendorId, req.params.id, req.params.documentId);
        if (!ok) return res.status(404).json({ success: false, message: 'Document not found' });
        res.json({ success: true });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({ success: false, message: err.message });
    }
});

module.exports = router;
