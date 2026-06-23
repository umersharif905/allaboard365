# Manual Queue Management Guide

## Overview

This guide explains how to manually add, remove, and manage share requests in queues.

## Methods for Manual Queue Management

### 1. **Via Queues Dashboard UI** (Recommended)

#### Adding a Request to a Queue

1. Navigate to **Queues Dashboard** (`/vendor/share-requests/queues`)
2. Click the **"Add to Queue"** button in the top-right corner
3. In the modal that appears:
   - Enter the **Share Request ID** (GUID format)
   - Select the **Queue Type** from the dropdown:
     - Pending Review
     - Awaiting Member
     - Awaiting Records
     - UA Pending
     - In Negotiation
     - FAP Submitted
     - Ready to Pay
     - In Collections
   - Set the **Priority** (0-5, where 5 is highest)
4. Click **"Add to Queue"**

#### Removing a Request from a Queue

1. Navigate to **Queues Dashboard**
2. Find the request in the queue list
3. Click the **red X icon** in the Actions column
4. Confirm the removal

### 2. **Via Share Request Detail Page**

#### Auto-Assign Queues

1. Navigate to a specific share request detail page
2. Click the **"Assign to Queue"** button (next to "Update Status")
3. This triggers automatic queue assignment based on:
   - Current status
   - Missing documents flag
   - Collections count
   - FAP submissions
   - Active negotiations
   - Balance amount

### 3. **Via API Endpoints** (For Developers/Admins)

#### Add to Queue

```http
POST /api/me/vendor/share-requests/:id/queues
Content-Type: application/json

{
  "queueType": "Pending Review",
  "priority": 1,
  "assignedTo": "user-id-optional"
}
```

**Parameters:**
- `queueType` (required): One of the queue types listed above
- `priority` (optional): 0-5, defaults to 0
- `assignedTo` (optional): User ID to assign the queue item to

#### Remove from Queue

```http
DELETE /api/me/vendor/share-requests/:id/queues/:queueType
Content-Type: application/json

{
  "reason": "Manually removed by staff"
}
```

**Parameters:**
- `:id`: Share Request ID
- `:queueType`: Queue type to remove from
- `reason` (optional): Reason for removal

#### Auto-Assign Queues

```http
POST /api/me/vendor/share-requests/:id/queues/auto-assign
```

This automatically evaluates the share request and adds it to appropriate queues based on current state.

## Queue Types and When to Use Them

| Queue Type | Priority | When to Use |
|------------|----------|-------------|
| **Pending Review** | 1 | New requests needing initial review |
| **Awaiting Member** | 3 | Waiting for member response or action |
| **Awaiting Records** | 2 | Missing documents or medical records |
| **UA Pending** | 2 | Waiting for Unshared Amount payment |
| **In Negotiation** | 2 | Active provider negotiations |
| **FAP Submitted** | 2 | Financial assistance application submitted |
| **Ready to Pay** | 3 | Approved and ready for payment |
| **In Collections** | 5 | Bills flagged for collections (highest priority) |

## Priority Guidelines

- **0**: Default/No priority
- **1**: Low priority (normal workflow)
- **2**: Medium priority (needs attention)
- **3**: High priority (urgent)
- **4**: Very high priority
- **5**: Critical (collections, escalations)

## Best Practices

### When to Manually Add to Queue

1. **Corrections**: If a request is in the wrong queue
2. **Special Cases**: Unusual situations not covered by auto-assignment
3. **Workflow Override**: When business rules require manual intervention
4. **Testing**: During development or testing scenarios

### When to Manually Remove from Queue

1. **Resolved**: Issue has been resolved (e.g., documents received)
2. **Moved**: Request moved to a different queue
3. **Closed**: Request is closed or denied
4. **Error**: Incorrectly added to queue

### When to Use Auto-Assign

1. **After Status Changes**: Automatically triggered, but can be manually triggered
2. **After Bulk Updates**: Use "Auto-Assign All Requests" button
3. **After Schema Changes**: Re-evaluate all requests
4. **Initial Setup**: Assign existing requests to queues

## Common Scenarios

### Scenario 1: Request Missing from Queue

**Problem**: A request should be in a queue but isn't showing up.

**Solution**:
1. Go to the Share Request Detail page
2. Click "Assign to Queue" to trigger auto-assignment
3. Or manually add it using the "Add to Queue" button on the Queues Dashboard

### Scenario 2: Request in Wrong Queue

**Problem**: A request is in the wrong queue.

**Solution**:
1. Remove it from the incorrect queue (click X icon)
2. Either:
   - Click "Assign to Queue" on the detail page (auto-assign)
   - Or manually add it to the correct queue

### Scenario 3: Request in Multiple Queues

**Problem**: A request appears in multiple queues.

**Solution**: This is normal! A request can be in multiple queues simultaneously. For example:
- "In Collections" (Priority 5) - because of a collections flag
- "Awaiting Records" (Priority 2) - because documents are missing

Remove from specific queues only if the condition no longer applies.

### Scenario 4: Bulk Queue Assignment

**Problem**: Need to assign many requests to queues.

**Solution**:
1. Go to Queues Dashboard
2. Click "Auto-Assign All Requests"
3. This processes all share requests and assigns them to appropriate queues

## Troubleshooting

### "Already in this queue" Error

**Cause**: The request is already in the specified queue.

**Solution**: Check if the request is already listed. If you need to update priority, remove and re-add with new priority.

### "Share request not found" Error

**Cause**: Invalid Share Request ID.

**Solution**: Verify the Share Request ID is correct (GUID format).

### Queue Not Updating

**Cause**: Cache or state not refreshing.

**Solution**:
1. Refresh the page
2. Check if the change was saved (check activity log on request)
3. Verify API call succeeded (check browser console)

## Activity Logging

All manual queue operations are logged in the share request's activity log:
- "Added to queue: [Queue Type]"
- "Removed from queue: [Queue Type] (reason)"
- "Queues auto-assigned successfully"

Check the **Activity** tab on the Share Request Detail page to see queue history.

## API Response Examples

### Successful Add to Queue

```json
{
  "success": true,
  "data": {
    "queueId": "guid-here",
    "success": true
  },
  "message": "Added to queue successfully"
}
```

### Successful Remove from Queue

```json
{
  "success": true,
  "message": "Removed from queue successfully"
}
```

### Error Response

```json
{
  "success": false,
  "message": "Already in this queue"
}
```

## Notes

- Queue assignments are **soft-deleted** (not permanently removed)
- Historical queue data is maintained for reporting
- Auto-assignment runs automatically on:
  - Request creation
  - Status changes
  - Bill creation
- Manual assignment overrides auto-assignment for specific queues
- A request can be in multiple queues simultaneously

