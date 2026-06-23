# Enrollment Links UX Improvements Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve enrollment link UX with inline Copy/Send buttons, auto-created default link for agents, Send Link on unenrolled members, and 7-day expiration.

**Architecture:** Four independent changes: (1) Replace 3-dot Send/Copy with inline buttons on EnrollmentLinkTemplates table rows, (2) Auto-create a default Individual enrollment link with all products when agent has no templates, (3) Add Send Link button on unenrolled member rows in AgentMemberManagement, (4) Change default link expiration from 72h to 7 days.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Lucide React, Express.js, MSSQL

---

### Task 1: Change link expiration from 72 hours to 7 days

**Files:**
- Modify: `backend/services/shared/enrollment-link.service.js:42`
- Modify: `backend/routes/me/enrollment-links.js:307`
- Modify: `frontend/src/components/shared/SendEnrollmentDialog.tsx:249`

- [ ] **Step 1: Update backend service default expiration**

In `backend/services/shared/enrollment-link.service.js`, line 42, change:
```javascript
expirationHours = 72,
```
to:
```javascript
expirationHours = 168,
```

- [ ] **Step 2: Update backend route default expiration**

In `backend/routes/me/enrollment-links.js`, line 307, change:
```javascript
let expirationHours = 72; // Default 72 hours
```
to:
```javascript
let expirationHours = 168; // Default 7 days
```

- [ ] **Step 3: Update frontend UI text**

In `frontend/src/components/shared/SendEnrollmentDialog.tsx`, line 249, change:
```
expires after 72 hours
```
to:
```
expires after 7 days
```

- [ ] **Step 4: Commit**

```bash
git add backend/services/shared/enrollment-link.service.js backend/routes/me/enrollment-links.js frontend/src/components/shared/SendEnrollmentDialog.tsx
git commit -m "feat: change enrollment link expiration from 72 hours to 7 days"
```

---

### Task 2: Add inline Copy Link and Send Link buttons to EnrollmentLinkTemplates table

**Files:**
- Modify: `frontend/src/pages/enrollment-links/EnrollmentLinkTemplates.tsx`

The current 3-dot dropdown has: Send Link, Copy static link, View Details, Duplicate, Edit, Delete.
Move Send Link and Copy static link out as inline buttons next to the 3-dot menu. Keep View Details, Duplicate, Edit, Delete in the dropdown. Remove Send Link and Copy static link from the dropdown.

For Individual rows: show "Copy Link" button + "Send" button + 3-dot menu.
For Group rows: show "Send" button + 3-dot menu.

The Copy Link button should:
- Call existing `handleCopyStaticLinkOption` to get/create the URL
- Instead of opening the `staticLinkCopyModal`, copy directly to clipboard
- Change button text to "Copied!" and grey it out for 2 seconds, then reset

- [ ] **Step 1: Add per-row copied state tracking**

Add a state variable to track which template's copy button is showing "Copied!":
```typescript
const [copiedTemplateId, setCopiedTemplateId] = useState<string | null>(null);
```

- [ ] **Step 2: Create inline copy handler**

Create a new `handleInlineCopyLink` function that copies directly to clipboard without opening a modal. This reuses the same static link fetch/create logic from `handleCopyStaticLinkOption` but instead of calling `setStaticLinkCopyModal`, copies to clipboard and sets `copiedTemplateId`:

```typescript
const handleInlineCopyLink = async (template: EnrollmentLinkTemplate) => {
  if (template.TemplateType !== 'Individual') return;
  setMutationError(null);
  setLoadingStaticLinkUrl(true);
  try {
    let url = '';
    // Reuse same fetch logic from handleCopyStaticLinkOption
    if (user?.currentRole === 'Agent') {
      const agentResponse = await apiService.get<{ success: boolean; data?: any[] | any }>('/api/me/agent/enrollment-links/static');
      if (agentResponse.success && agentResponse.data) {
        const staticLinks = Array.isArray(agentResponse.data) ? agentResponse.data : [agentResponse.data];
        const matching = staticLinks.find((link: any) =>
          (link.templateId || link.TemplateId || link.EnrollmentLinkTemplateId) === template.TemplateId
        );
        if (matching) url = matching.enrollmentUrl || matching.linkUrl || matching.LinkUrl || '';
      }
      const agentOrAgencyIdForCopy = template.AgentId || template.AgencyId;
      if (!url && agentOrAgencyIdForCopy) {
        const res = await apiService.get<{ success: boolean; data?: any }>(
          `/api/me/tenant-admin/enrollment-link-templates/static-by-agent?agentId=${agentOrAgencyIdForCopy}&templateId=${template.TemplateId}`
        );
        if (res.success && res.data) url = res.data.enrollmentUrl || '';
      }
    } else if (user?.currentRole === 'TenantAdmin') {
      const agentOrAgencyIdForCopy = template.AgentId || template.AgencyId;
      if (agentOrAgencyIdForCopy) {
        const res = await apiService.get<{ success: boolean; data?: any }>(
          `/api/me/tenant-admin/enrollment-link-templates/static-by-agent?agentId=${agentOrAgencyIdForCopy}&templateId=${template.TemplateId}`
        );
        if (res.success && res.data) url = res.data.enrollmentUrl || '';
      }
    } else if (user?.currentRole === 'SysAdmin') {
      const agentOrAgencyIdForCopy = template.AgentId || template.AgencyId;
      if (agentOrAgencyIdForCopy) {
        const res = await apiService.get<{ success: boolean; data?: any }>(
          `/api/me/sysadmin/enrollment-link-templates/static-by-agent?agentId=${agentOrAgencyIdForCopy}&templateId=${template.TemplateId}`
        );
        if (res.success && res.data) url = res.data.enrollmentUrl || '';
      }
    }
    if (!url) {
      if (user?.currentRole === 'Agent') {
        const createRes = await apiService.post<{ success: boolean; data?: { enrollmentUrl: string } }>('/api/me/agent/enrollment-links/create-static', { templateId: template.TemplateId });
        if (createRes.success && createRes.data?.enrollmentUrl) url = createRes.data.enrollmentUrl;
      } else if (user?.currentRole === 'TenantAdmin') {
        const agentOrAgencyIdForCopy = template.AgentId || template.AgencyId;
        if (agentOrAgencyIdForCopy) {
          const createRes = await apiService.post<{ success: boolean; data?: { enrollmentUrl: string } }>('/api/me/tenant-admin/enrollment-link-templates/create-static', { templateId: template.TemplateId, agentId: agentOrAgencyIdForCopy });
          if (createRes.success && createRes.data?.enrollmentUrl) url = createRes.data.enrollmentUrl;
        }
      }
    }
    if (url) {
      await navigator.clipboard.writeText(url);
      setCopiedTemplateId(template.TemplateId);
      setTimeout(() => setCopiedTemplateId(null), 2000);
      loadTemplates();
    } else {
      setMutationError('Could not get or create static link.');
    }
  } catch (err) {
    console.error('Inline copy link failed:', err);
    setMutationError(err instanceof Error ? err.message : 'Failed to copy link.');
  } finally {
    setLoadingStaticLinkUrl(false);
  }
};
```

- [ ] **Step 3: Replace the Actions column content**

In the table body, replace the Actions `<td>` (around lines 1382-1497). The new content should show inline buttons followed by the 3-dot menu. The 3-dot dropdown should NO LONGER contain "Send Link" or "Copy static link" options:

```tsx
<td className="px-6 py-4">
  <div className="flex items-center justify-end gap-2">
    {/* Copy Link - Individual templates only */}
    {template.TemplateType === 'Individual' && (isAgent || isTenantAdmin || user?.currentRole === 'SysAdmin') && (
      <button
        onClick={() => handleInlineCopyLink(template)}
        disabled={loadingStaticLinkUrl || copiedTemplateId === template.TemplateId}
        className={`inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
          copiedTemplateId === template.TemplateId
            ? 'border-gray-200 bg-gray-50 text-gray-400 cursor-default'
            : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
        }`}
      >
        <Copy className="h-3.5 w-3.5 mr-1" />
        {copiedTemplateId === template.TemplateId ? 'Copied!' : 'Copy Link'}
      </button>
    )}

    {/* Send Link - all templates */}
    <button
      onClick={async () => {
        await handleSendLink(template);
      }}
      disabled={loadingStaticLinkUrl}
      className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-lg border border-blue-600 text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Send className="h-3.5 w-3.5 mr-1" />
      Send
    </button>

    {/* 3-dot menu for remaining actions */}
    <div className="relative">
      <button
        ref={(el) => { actionMenuRefs.current[template.TemplateId] = el; }}
        data-action-button
        onClick={(e) => handleActionMenuClick(template.TemplateId, e)}
        className="p-1 text-gray-400 hover:text-gray-600"
        title="Actions"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      
      {openActionMenuId === template.TemplateId && actionMenuPosition && createPortal(
        <div
          data-action-menu
          className="fixed w-48 bg-white rounded-lg shadow-lg border border-gray-200 z-[9999] overflow-y-auto"
          style={{
            top: actionMenuPosition.y,
            left: actionMenuPosition.x,
            ...(actionMenuPosition.maxHeight != null && { maxHeight: actionMenuPosition.maxHeight })
          }}
        >
          <div className="py-1">
            <button
              onClick={() => {
                setSelectedTemplate(template);
                setViewDialogOpen(true);
                setOpenActionMenuId(null);
                setActionMenuPosition(null);
              }}
              className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
            >
              <Eye className="h-4 w-4" />
              View Details
            </button>
            
            {roleConfig.canEditTemplates && (
              <>
                <button
                  onClick={async () => {
                    setOpenActionMenuId(null);
                    setActionMenuPosition(null);
                    await handleDuplicate(template);
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                >
                  <Copy className="h-4 w-4" />
                  Duplicate
                </button>
                <button
                  onClick={() => {
                    setSelectedTemplate(template);
                    setEditDialogOpen(true);
                    setOpenActionMenuId(null);
                    setActionMenuPosition(null);
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                >
                  <Edit className="h-4 w-4" />
                  Edit
                </button>
              </>
            )}
            
            {roleConfig.canDeleteTemplates && (
              <>
                <div className="border-t border-gray-100 my-1"></div>
                <button
                  onClick={() => {
                    setSelectedTemplate(template);
                    setDeleteDialogOpen(true);
                    setOpenActionMenuId(null);
                    setActionMenuPosition(null);
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete Link
                </button>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  </div>
</td>
```

- [ ] **Step 4: Verify in browser**

Load the enrollment links page as an Agent. Confirm:
- Individual rows show "Copy Link" + "Send" buttons + 3-dot menu
- Group rows show only "Send" button + 3-dot menu
- Clicking "Copy Link" copies to clipboard, button changes to "Copied!" and greys out for 2s
- Clicking "Send" opens the Quick Send modal (same behavior as before)
- 3-dot menu still has View Details, Duplicate, Edit, Delete but NOT Send/Copy

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/enrollment-links/EnrollmentLinkTemplates.tsx
git commit -m "feat: add inline Copy Link and Send buttons to enrollment link templates table"
```

---

### Task 3: Auto-create default Individual enrollment link for agents

**Files:**
- Modify: `backend/routes/me/agent/enrollment-link-templates.js` (add auto-create logic in GET handler)

When the agent's GET templates endpoint returns 0 templates, auto-create a default Individual template with all the agent's available individual products. The template is named "My Enrollment Link" and includes all product types.

- [ ] **Step 1: Add auto-create logic to GET route**

In `backend/routes/me/agent/enrollment-link-templates.js`, inside the GET `/` handler, after the main query returns results — if the agent has 0 total templates (not just 0 on current page), auto-create one.

After the existing query execution and before the response is sent, add logic that:
1. Checks if `totalItems === 0` and the user is an Agent (not TenantAdmin viewing agent templates)
2. Fetches all active individual products for the agent's tenant from `oe.Products WHERE TenantId = @tenantId AND IsActive = 1`
3. Groups products by ProductType
4. Builds LinkMetaData with household defaults and product sections for each type
5. INSERTs a new template with TemplateName = "My Enrollment Link", TemplateType = "Individual", IsActive = 1
6. Re-runs the query to include the new template in the response

- [ ] **Step 2: Write the auto-create code**

Add this block in the GET handler, after the count query runs and before sending the response. The exact insertion point is after the `totalItems` is calculated but before the final `res.json(...)`:

```javascript
// Auto-create default Individual template for agents with no templates
if (!isTenantAdmin && totalItems === 0 && !search && !templateType) {
  try {
    console.log('🔄 Agent has no templates, auto-creating default Individual template...');
    
    // Fetch all active products for this tenant
    const productsRequest = pool.request();
    productsRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
    const productsResult = await productsRequest.query(`
      SELECT ProductId, ProductName, ProductType 
      FROM oe.Products 
      WHERE TenantId = @tenantId AND IsActive = 1
      ORDER BY ProductType, ProductName
    `);
    
    // Group products by ProductType
    const productsByType = {};
    for (const product of productsResult.recordset) {
      const pType = product.ProductType || 'Other';
      if (!productsByType[pType]) productsByType[pType] = [];
      productsByType[pType].push(product.ProductId);
    }
    
    // Build product sections
    const productSections = Object.entries(productsByType).map(([productType, productIds]) => ({
      page: productType,
      header: `Select Your ${productType} Coverage`,
      productType: productType.toLowerCase(),
      sectionType: 'products',
      includePdfLinks: true,
      includeVideos: false,
      effectiveDateRules: { type: 'MemberSelected' },
      specificProducts: productIds
    }));
    
    const linkMetaData = JSON.stringify({
      household: {
        collectSSN: false,
        collectDOB: true,
        collectGender: false,
        collectAddress: true,
        collectPhone: true,
      },
      products: productSections
    });
    
    const newTemplateId = require('crypto').randomUUID();
    const createRequest = pool.request();
    createRequest.input('templateId', sql.UniqueIdentifier, newTemplateId);
    createRequest.input('templateName', sql.NVarChar, 'My Enrollment Link');
    createRequest.input('templateType', sql.NVarChar, 'Individual');
    createRequest.input('agentId', sql.UniqueIdentifier, agentId);
    createRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
    createRequest.input('linkMetaData', sql.NVarChar(sql.MAX), linkMetaData);
    createRequest.input('description', sql.NVarChar, 'Default enrollment link with all available products');
    createRequest.input('createdBy', sql.UniqueIdentifier, userId);
    
    await createRequest.query(`
      INSERT INTO oe.EnrollmentLinkTemplates 
        (TemplateId, TemplateName, TemplateType, AgentId, TenantId, LinkMetaData, Description, IsActive, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
      VALUES 
        (@templateId, @templateName, @templateType, @agentId, @tenantId, @linkMetaData, @description, 1, GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy)
    `);
    
    console.log('✅ Auto-created default template:', newTemplateId);
    
    // Re-run the original query to include the new template
    // (re-execute the same query that was run before)
    const refreshResult = await request.query(countQuery);
    const newTotalItems = refreshResult.recordset[0].total;
    
    const refreshDataRequest = pool.request();
    // Re-bind all the same parameters
    if (isTenantAdmin) {
      refreshDataRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
      if (agentIdFromGroup || agentIdParam) {
        refreshDataRequest.input('agentId', sql.UniqueIdentifier, agentIdFromGroup || agentIdParam);
      }
    } else if (isAgencyOwner && viewDownline) {
      refreshDataRequest.input('userId', sql.UniqueIdentifier, userId);
    } else {
      refreshDataRequest.input('agentId', sql.UniqueIdentifier, agentId);
    }
    if (search) refreshDataRequest.input('search', sql.NVarChar, `%${search}%`);
    if (templateType) refreshDataRequest.input('templateType', sql.NVarChar, templateType);
    if (isActive !== undefined && isActive !== '') {
      refreshDataRequest.input('isActive', sql.Bit, isActive === 'true' || isActive === true ? 1 : 0);
    }
    refreshDataRequest.input('offset', sql.Int, offset);
    refreshDataRequest.input('limit', sql.Int, limit);
    
    const refreshDataResult = await refreshDataRequest.query(dataQuery);
    
    return res.json({
      success: true,
      data: {
        data: refreshDataResult.recordset,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(newTotalItems / limit),
          totalItems: newTotalItems,
          itemsPerPage: limit,
          hasNextPage: page < Math.ceil(newTotalItems / limit),
          hasPrevPage: page > 1
        }
      }
    });
  } catch (autoCreateError) {
    console.error('⚠️ Failed to auto-create default template:', autoCreateError);
    // Fall through to return empty results
  }
}
```

- [ ] **Step 3: Verify in browser**

Log in as an agent that has no enrollment link templates. Verify:
- On first load of enrollment links page, a "My Enrollment Link" template appears
- It's an Individual type template with all available products
- The agent can edit it normally
- Refreshing the page doesn't create duplicates (totalItems is now > 0)

- [ ] **Step 4: Commit**

```bash
git add backend/routes/me/agent/enrollment-link-templates.js
git commit -m "feat: auto-create default Individual enrollment link for agents with no templates"
```

---

### Task 4: Add Send Link button on unenrolled members in AgentMemberManagement

**Files:**
- Modify: `frontend/src/pages/agent/AgentMemberManagement.tsx`

Add a "Send Link" button visible on member rows where `enrollmentStatus` is NOT "Enrolled". Clicking it opens the QuickEnrollmentLinkModal pre-filled with the member's info.

- [ ] **Step 1: Add imports and state**

Add to imports:
```typescript
import { Send } from 'lucide-react';
import QuickEnrollmentLinkModal from '../../components/shared/QuickEnrollmentLinkModal';
```

Add state variables:
```typescript
const [showSendLinkModal, setShowSendLinkModal] = useState(false);
const [sendLinkMember, setSendLinkMember] = useState<{
  memberId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
} | null>(null);
```

- [ ] **Step 2: Add Send Link button to member rows**

In the Actions `<td>` (around line 421), add a Send Link button before the Call button. Only show it when `member.enrollmentStatus !== 'Enrolled'`:

```tsx
{member.enrollmentStatus !== 'Enrolled' && (
  <button
    onClick={() => {
      setSendLinkMember({
        memberId: member.memberId,
        firstName: member.firstName,
        lastName: member.lastName,
        email: member.email,
        phoneNumber: member.phoneNumber,
      });
      setShowSendLinkModal(true);
    }}
    className="inline-flex items-center px-2.5 py-1.5 text-xs font-medium rounded-lg border border-blue-600 text-white bg-blue-600 hover:bg-blue-700 transition-colors"
    title="Send enrollment link"
  >
    <Send className="h-3.5 w-3.5 mr-1" />
    Send Link
  </button>
)}
```

- [ ] **Step 3: Add QuickEnrollmentLinkModal at bottom of component**

Before the closing `</div>` of the main component return, add:

```tsx
{showSendLinkModal && sendLinkMember && (
  <QuickEnrollmentLinkModal
    isOpen={showSendLinkModal}
    onClose={() => {
      setShowSendLinkModal(false);
      setSendLinkMember(null);
    }}
    prefillMember={sendLinkMember}
  />
)}
```

- [ ] **Step 4: Verify in browser**

Load the agent member management page. Confirm:
- Unenrolled members show a "Send Link" button
- Enrolled members do NOT show the button
- Clicking "Send Link" opens the QuickEnrollmentLinkModal pre-filled with member info
- The modal works correctly (can choose template, delivery method, send)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/agent/AgentMemberManagement.tsx
git commit -m "feat: add Send Link button on unenrolled members in agent member management"
```
