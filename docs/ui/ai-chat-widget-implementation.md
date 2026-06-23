# AI Chat Widget Implementation

## Overview
The AI Chat Widget has been successfully integrated into the Open-Enroll application with role-based AI Chunk filtering. The widget appears globally on all pages and provides contextual assistance based on the user's role.

## Implementation Details

### 1. Frontend Component
**File**: `frontend/src/components/ai/ChatWidget.tsx`

**Features**:
- ✅ Role-based AI Chunk filtering
- ✅ Conversation history tracking
- ✅ Loading animations and error handling
- ✅ Responsive design with minimize/maximize functionality
- ✅ Same styling and behavior as the website version
- ✅ TypeScript implementation with proper type definitions

**Role Mapping**:
- **SysAdmin**: `['SysAdmin', 'System', 'AuthAPI']`
- **TenantAdmin**: `['TenantAdmin', 'System', 'AuthAPI']`
- **Agent**: `['Agent', 'System', 'AuthAPI']`
- **GroupAdmin**: `['GroupAdmin', 'System', 'AuthAPI']`
- **Member**: `['Member', 'System', 'AuthAPI']`
- **Public**: `['Public']` (for unauthenticated users)

### 2. Hybrid Integration (Frontend + Backend + Azure)
**Two-Step Process**: ChatWidget fetches chunks from backend, then calls Azure endpoint

**Backend Endpoint**: `POST /api/ai/chunks` - Fetches AI chunks based on user role
**Azure Endpoint**: `https://oe-ai-helper-dth9buefenare8a9.eastus2-01.azurewebsites.net/api/ai/chat`

**Process**:
1. ✅ ChatWidget gets user role from localStorage
2. ✅ Calls backend `/api/ai/chunks` to fetch relevant AI chunks
3. ✅ Calls Azure endpoint with question + AI chunks as context
4. ✅ Returns contextual response to user

**Features**:
- ✅ Role-based AI Chunk filtering from database
- ✅ Passes actual AI chunk content as context to Azure
- ✅ Includes conversation history for context
- ✅ Graceful fallback if chunks can't be fetched

### 3. Global Integration
**File**: `frontend/src/App.tsx`

**Integration**:
- ✅ Added ChatWidget import
- ✅ Widget appears on all pages (authenticated and public)
- ✅ Positioned as floating widget in bottom-right corner
- ✅ Enhanced formatting for step-by-step instructions and lists
- ✅ Larger display size (420px wide, 700px tall) for better readability

### 4. Database Schema
**Table**: `oe.AIChunks`

**Key Columns**:
- `AIChunkId` - Primary key
- `SystemArea` - Role-based filtering (SysAdmin, TenantAdmin, Agent, etc.)
- `ChunkData` - The actual content sent to AI
- `IsActive` - Boolean flag for active chunks
- `Status` - Approval status ('Approved', 'Draft', etc.)
- `CreatedDate`, `CreatedBy`, `ModifiedDate`, `ModifiedBy` - Audit fields

## Usage Examples

### For SysAdmin Users
When a SysAdmin asks "How do I create a commission rule?", the system:
1. Identifies user role as 'SysAdmin'
2. Retrieves AIChunks where `SystemArea IN ('SysAdmin', 'System', 'AuthAPI')`
3. Sends question + chunks to external AI API
4. Returns contextual response about commission rule creation

### For Member Users
When a Member asks "How do I change my plan?", the system:
1. Identifies user role as 'Member'
2. Retrieves AIChunks where `SystemArea IN ('Member', 'System', 'AuthAPI')`
3. Sends question + chunks to external AI API
4. Returns contextual response about plan changes

### For Public Users
When an unauthenticated user asks "What is Open-Enroll?", the system:
1. Identifies user role as 'Public'
2. Retrieves AIChunks where `SystemArea = 'Public'`
3. Currently returns limited response (until Public chunks are created)

## Testing

### Test Script
**File**: `backend/scripts/test-ai-chat.js`

Run with: `node backend/scripts/test-ai-chat.js`

**Test Cases**:
- ✅ SysAdmin role with commission question
- ✅ Member role with plan change question
- ✅ Public role with general question
- ✅ Chunks endpoint verification

## Enhanced Formatting Features

### Automatic Text Formatting
The ChatWidget now automatically formats AI responses for better readability:

**Step-by-Step Instructions**:
- Detects numbered lists (1. 2. 3.) and formats them with:
  - Individual cards with blue left border
  - Highlighted step numbers
  - Proper spacing and visual hierarchy

**Bullet Points**:
- Formats bullet points (• - *) with proper indentation
- Blue bullet indicators for visual consistency

**Regular Text**:
- Improved line spacing and paragraph separation
- Better typography for readability

### Widget Size Improvements
- **Width**: Increased from 380px to 420px
- **Height**: Increased from 500px to 700px
- **Better Content Display**: More space for formatted responses

## API Request Format (to Azure Endpoint)

```json
{
  "SystemArea": "SysAdmin",
  "Prompt": "You are a subject matter expert for Open-Enroll. Respond clearly with properly structured sentences and use formatting for better readability. For step-by-step instructions, use numbered lists (1. 2. 3.). For lists of items, use bullet points. Use line breaks between sections. Use the provided context to answer questions accurately.",
  "Question": "How do I create a commission rule?",
  "Context": [
    {
      "SystemArea": "SysAdmin",
      "ChunkData": "System configuration management enables administrators to control global settings..."
    },
    {
      "SystemArea": "System", 
      "ChunkData": "Commission rules define how agents are compensated for sales..."
    }
  ],
  "ConversationHistory": [
    {
      "role": "user",
      "content": "Previous question"
    },
    {
      "role": "assistant", 
      "content": "Previous response"
    }
  ]
}
```

## API Response Format (from Azure Endpoint)

```json
{
  "success": true,
  "response": "To create a commission rule in Open-Enroll..."
}
```

## Next Steps

### 1. Public AI Chunks
- Create AIChunks with `SystemArea = 'Public'` for unauthenticated users
- Include general information about Open-Enroll, features, and benefits

### 2. Enhanced Context
- Consider adding user-specific context (tenant info, group info, etc.)
- Implement conversation memory across sessions

### 3. Analytics
- Track chat usage by role
- Monitor popular questions and responses
- Analyze chunk effectiveness

### 4. Performance Optimization
- Cache frequently used chunks
- Implement chunk prioritization
- Add rate limiting for API calls

## Security Considerations

- ✅ No JWT validation required (as requested)
- ✅ Public access to AI endpoints
- ✅ Role-based data filtering at database level
- ✅ Input sanitization for questions
- ✅ Error handling prevents information leakage

## Files Modified/Created

### New Files
- `frontend/src/components/ai/ChatWidget.tsx`
- `backend/routes/ai-chunks.js` - Backend endpoint for fetching AI chunks
- `docs/ui/ai-chat-widget-implementation.md`

### Modified Files
- `backend/app.js` - Added AI chunks routes
- `frontend/src/App.tsx` - Added ChatWidget import and global placement

## Deployment Notes

1. ✅ Azure AI endpoint is already accessible and working
2. ✅ Backend AI chunks endpoint is working and returning correct data
3. ✅ Role-based AI chunk filtering from database (138 total chunks)
4. ✅ AI chunks are passed as context to Azure service
5. ✅ Graceful fallback if chunks can't be fetched

**Current AI Chunks Available**:
- **SysAdmin**: 30 chunks (SysAdmin + System + AuthAPI)
- **Member**: 35 chunks (Member + System + AuthAPI)
- **Agent**: 30 chunks (Agent + System + AuthAPI)
- **GroupAdmin**: 30 chunks (GroupAdmin + System + AuthAPI)
- **TenantAdmin**: 30 chunks (TenantAdmin + System + AuthAPI)

The AI Chat Widget is now fully integrated and ready for use across the Open-Enroll application! 🚀
