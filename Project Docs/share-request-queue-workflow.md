# Share Request Queue System - Workflow Documentation

## Overview

The Queue System organizes share requests into work queues based on their status, flags, and characteristics. This helps staff prioritize and manage their workload efficiently.

## Queue Types

The system supports the following queue types:

1. **Pending Review** (Priority: 1)
   - New share requests that need initial review
   - Status: `New` or `Intake`

2. **Awaiting Member** (Priority: 3)
   - Requests waiting for member action or response
   - Status: `Awaiting Member` or `Pending Member Action`

3. **Awaiting Records** (Priority: 2)
   - Requests missing required documents or medical records
   - Status: `Awaiting Records` or `Pending Medical Records`
   - OR Flag: `MissingDocuments = true`

4. **UA Pending** (Priority: 2)
   - Requests waiting for Unshared Amount (UA) payment
   - Status: `UA Pending`

5. **In Negotiation** (Priority: 2)
   - Requests with active negotiations
   - Status: `In Negotiation`
   - OR Has negotiations with status `Pending` or `In Progress`

6. **FAP Submitted** (Priority: 2)
   - Requests with submitted Financial Assistance Program applications
   - Has FAP records with status `Submitted`

7. **Ready to Pay** (Priority: 3)
   - Requests approved and ready for payment
   - Status: `Ready to Pay`
   - OR Status: `Approved for Share` with `Balance > 0`

8. **In Collections** (Priority: 5 - **HIGHEST**)
   - Requests with bills flagged for collections
   - Has bills with `InCollections = 1` and `IsActive = 1`

## Auto-Assignment Workflow

### 1. **Automatic Assignment Triggers**

Share requests are automatically assigned to queues when:

#### A. **Request Creation**
- When a new share request is created via `createShareRequest()`
- Automatically runs `autoAssignQueues()` after creation
- Assigns based on initial status (typically "Pending Review" for new requests)

#### B. **Status Changes**
- When share request status is updated via `updateStatus()`
- Re-evaluates all queue assignments based on new status
- May add to new queues or remove from old ones

#### C. **Bill Creation**
- When a new bill is added via `createBill()`
- Re-evaluates queues (may trigger "In Collections" if bill is flagged)
- May trigger "Awaiting Records" if documents are needed

### 2. **Auto-Assignment Logic**

The `autoAssignQueues()` function:

1. **Fetches Current State:**
   - Share request status and determination
   - MissingDocuments flag
   - Balance amount
   - Count of bills in collections
   - Count of submitted FAP applications
   - Count of active negotiations

2. **Determines Queues to Add:**
   - Evaluates each queue type based on conditions
   - Priority order: Collections (5) > Missing Docs (2) > Status queues (1-3)
   - A request can be in multiple queues simultaneously

3. **Adds to Queues:**
   - Calls `addToQueue()` for each matching queue type
   - Checks if already in queue (prevents duplicates)
   - Creates queue entry with priority and timestamp

### 3. **Queue Entry Structure**

Each queue entry contains:
- `QueueId`: Unique identifier
- `ShareRequestId`: Link to the share request
- `QueueType`: Type of queue (e.g., "Pending Review")
- `Priority`: Numeric priority (1-5, higher = more urgent)
- `AssignedTo`: Optional user assignment
- `AssignedDate`: When assigned to a user
- `CreatedDate`: When added to queue
- `RemovedDate`: Soft delete timestamp (NULL = active)

## Manual Assignment

### Staff Actions

1. **"Assign to Queue" Button** (Share Request Detail Page)
   - Manually triggers `autoAssignQueues()`
   - Useful for:
     - Existing requests that weren't auto-assigned
     - Re-evaluating queue assignments after manual changes
     - Testing queue logic

2. **"Auto-Assign All Requests" Button** (Queues Dashboard)
   - Bulk operation for all share requests
   - Useful for:
     - Initial setup
     - After schema changes
     - Correcting missing assignments

3. **Direct Queue Management** (Future)
   - Add/remove from specific queues
   - Change priority
   - Assign to specific staff members

## Queue Display

### Queues Dashboard (`/vendor/share-requests/queues`)

1. **Queue Statistics Cards:**
   - Shows count for each queue type
   - Displays aging metrics (oldest item, average age)
   - Clickable to filter by queue type

2. **Queue List:**
   - Shows all share requests in selected queue
   - Displays:
     - Request number
     - Member name and number
     - Status and determination
     - Priority
     - Days in queue (aging)
     - Assigned staff member
   - Sortable by priority, date, request number
   - Paginated for performance

3. **Filtering:**
   - Filter by queue type
   - Filter by assigned staff
   - Filter by role (future: role-based queues)

## Workflow Examples

### Example 1: New Request Flow

```
1. Member submits share request
   ↓
2. System creates request with status "New"
   ↓
3. autoAssignQueues() runs automatically
   ↓
4. Request added to "Pending Review" queue (Priority: 1)
   ↓
5. Staff reviews request
   ↓
6. Staff updates status to "Awaiting Records"
   ↓
7. autoAssignQueues() runs automatically
   ↓
8. Request moved to "Awaiting Records" queue (Priority: 2)
```

### Example 2: Collections Flow

```
1. Bill is added with InCollections flag = true
   ↓
2. autoAssignQueues() runs automatically
   ↓
3. System detects CollectionsCount > 0
   ↓
4. Request added to "In Collections" queue (Priority: 5)
   ↓
5. Request appears at top of queue list (highest priority)
   ↓
6. Staff handles collections issue
   ↓
7. Bill InCollections flag set to false
   ↓
8. autoAssignQueues() runs on next status change
   ↓
9. Request removed from "In Collections" queue
```

### Example 3: Multiple Queues

```
1. Request has:
   - Status: "In Negotiation"
   - MissingDocuments: true
   - 1 bill with InCollections = true
   ↓
2. autoAssignQueues() evaluates:
   - CollectionsCount > 0 → Add "In Collections" (Priority: 5)
   - MissingDocuments = true → Add "Awaiting Records" (Priority: 2)
   - Status = "In Negotiation" → Add "In Negotiation" (Priority: 2)
   ↓
3. Request appears in 3 queues simultaneously
   ↓
4. Shows in "In Collections" with highest priority
```

## Priority System

Priorities are numeric (1-5):
- **5**: In Collections (highest urgency)
- **3**: Awaiting Member, Ready to Pay
- **2**: Awaiting Records, UA Pending, In Negotiation, FAP Submitted
- **1**: Pending Review (lowest urgency)

Within each queue, items are sorted by:
1. Priority (DESC) - Higher priority first
2. Sort column (configurable: CreatedDate, Priority, RequestNumber, SubmittedDate)
3. Sort order (ASC/DESC)

## Queue Removal

Queues are soft-deleted (not hard-deleted):
- `RemovedDate` is set when request is removed from queue
- Historical tracking maintained
- Can be re-added if conditions change

Removal happens when:
- Status changes and no longer matches queue criteria
- Flags change (e.g., MissingDocuments = false)
- Manual removal by staff (future feature)

## Best Practices

1. **Regular Review:**
   - Check queues daily
   - Address high-priority items first
   - Monitor aging metrics

2. **Status Updates:**
   - Always update status when taking action
   - This triggers automatic queue re-evaluation

3. **Document Management:**
   - Set MissingDocuments flag appropriately
   - This ensures requests appear in correct queues

4. **Collections:**
   - Flag bills for collections when needed
   - This automatically prioritizes the request

5. **Manual Assignment:**
   - Use "Assign to Queue" if request seems misplaced
   - Use "Auto-Assign All" after bulk updates

## Technical Implementation

### Backend Services

- **`shareRequestQueueService.js`**: Core queue management
  - `getQueues()`: Fetch queues with filtering
  - `getQueueStats()`: Get statistics
  - `addToQueue()`: Add request to queue
  - `removeFromQueue()`: Remove request from queue
  - `autoAssignQueues()`: Auto-assignment logic

### Database Tables

- **`oe.ShareRequestQueues`**: Queue entries
  - Links share requests to queue types
  - Tracks assignments and priorities
  - Soft-delete enabled

### API Endpoints

- `GET /api/me/vendor/share-requests/queues`: List queues
- `GET /api/me/vendor/share-requests/queues/stats`: Get statistics
- `POST /api/me/vendor/share-requests/:id/queues/auto-assign`: Manual trigger
- `POST /api/me/vendor/share-requests/:id/queues`: Add to specific queue
- `DELETE /api/me/vendor/share-requests/:id/queues/:queueType`: Remove from queue

## Future Enhancements

1. **Role-Based Queues:**
   - Filter queues by staff role
   - Different queues for different roles

2. **Assignment Workflow:**
   - Auto-assign to available staff
   - Workload balancing
   - Escalation rules

3. **Queue Rules Engine:**
   - Configurable queue rules
   - Custom queue types
   - Business rule management

4. **Analytics:**
   - Queue performance metrics
   - Staff productivity tracking
   - SLA monitoring

5. **Notifications:**
   - Alert staff when items added to their queues
   - Aging alerts
   - Priority change notifications

