// backend/routes/public/npi-search.js
// Public (anonymous) NPI provider search for public-form provider_search fields.
// Scoped to a published public form; no auth. Rate-limited at mount time in app.js.

const express = require('express');
const publicFormAdminService = require('../../services/publicFormAdminService');
const { searchProviders, findCoLocatedOrganizations } = require('../../services/publicNpiSearch.service');

const router = express.Router();
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/public/npi/search?form=<uuid>&mode=&lastName=&organizationName=&firstName=&zip=
 */
router.get('/search', async (req, res) => {
  try {
    const { form, mode, lastName, firstName, organizationName, zip } = req.query;

    if (!form || !uuidRe.test(String(form))) {
      return res.status(400).json({ success: false, message: 'Invalid form id' });
    }
    const formRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(String(form));
    if (!formRow) {
      return res.status(401).json({ success: false, message: 'Form not found or not published' });
    }

    const { providers, widened } = await searchProviders({
      mode: String(mode || 'individual'),
      lastName: lastName ? String(lastName).trim() : '',
      firstName: firstName ? String(firstName).trim() : '',
      organizationName: organizationName ? String(organizationName).trim() : '',
      zip: String(zip || '')
    });

    return res.json({ success: true, count: providers.length, widened, data: providers });
  } catch (e) {
    const status = e.statusCode || 500;
    if (status >= 500) console.error('public npi search', e);
    return res.status(status).json({ success: false, message: e.message || 'NPI search failed' });
  }
});

/**
 * GET /api/public/npi/co-located?form=<uuid>&address1=&zip=
 * Organizations registered at a given street address (smart hospital suggestion).
 */
router.get('/co-located', async (req, res) => {
  try {
    const { form, address1, zip } = req.query;

    if (!form || !uuidRe.test(String(form))) {
      return res.status(400).json({ success: false, message: 'Invalid form id' });
    }
    const formRow = await publicFormAdminService.getPublishedDefinitionByTemplateId(String(form));
    if (!formRow) {
      return res.status(401).json({ success: false, message: 'Form not found or not published' });
    }

    const { providers } = await findCoLocatedOrganizations({
      address1: address1 ? String(address1).trim() : '',
      zip: String(zip || '')
    });

    return res.json({ success: true, count: providers.length, data: providers });
  } catch (e) {
    const status = e.statusCode || 500;
    if (status >= 500) console.error('public npi co-located', e);
    return res.status(status).json({ success: false, message: e.message || 'Co-located lookup failed' });
  }
});

module.exports = router;
