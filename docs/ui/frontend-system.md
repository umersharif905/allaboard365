# Frontend System & UI Patterns

This document logs UI patterns, issues, and solutions encountered during the development of the OpenEnroll frontend, specifically regarding responsive layouts, complex dashboards, and data grids.

## 1. Handling "Infinite Width" in Flex Layouts

### The Issue
In a flex layout (e.g., a sidebar + main content area), if a child element (like a DataGrid or a table) has wide content, it can force the main content area to expand indefinitely beyond the viewport width. This pushes the entire container off-screen or creates unwanted body-level horizontal scrolling, breaking the layout.

### The Cause
Flex items by default can shrink, but if their content has a minimum intrinsic width (like a wide table), the flex item won't shrink below that size unless explicitly constrained.

### The Solution: `min-w-0`
Apply `min-width: 0` (Tailwind: `min-w-0`) to the flex child wrapper (the main content area). This overrides the default behavior and allows the container to shrink to fit the available space, forcing its children to handle the overflow (e.g., via their own scrollbars).

**Example (Layout Component):**
```tsx
<div className="flex ...">
  {/* Sidebar */}
  <div className="w-64 ..." />
  
  {/* Main Content */}
  <div className="flex-1 min-w-0 ..."> {/* Added min-w-0 */}
    <div className="overflow-auto ...">
      {children}
    </div>
  </div>
</div>
```

## 2. Implementing a "Zoom Out" / High-Density Dashboard View

### The Requirement
Users sometimes need a "zoomed out" view of complex dashboards (like Group Details) to see more columns or data at once without changing their browser's global zoom setting.

### Approach 1: `transform: scale()`
- **Technique:** `transform: scale(0.8); width: 125%; transform-origin: top left;`
- **Pros:** Standard CSS, supported everywhere.
- **Cons:** 
  - Leaves empty whitespace at the bottom/right.
  - Can cause layout calculation issues with fixed elements or scrollbars.
  - Doesn't always reflow content correctly when parent containers resize (e.g., expanding/collapsing a sidebar).

### Approach 2: CSS `zoom` (Preferred for this use case)
- **Technique:** `style={{ zoom: '80%' }}`
- **Pros:** 
  - Behaves exactly like browser zoom.
  - Content reflows naturally to fill the space.
  - Scrollbars appear correctly on the parent container.
- **Cons:** Non-standard property (historically IE/Chrome), but widely supported in Chromium-based browsers (Chrome, Edge) and WebKit (Safari). Firefox support is varying.
- **Implementation:**
```tsx
<Box sx={{ width: '100%', height: '100%' }} style={{ zoom: '80%' }}>
  <Box sx={{ p: 3 }}>
    {/* Content */}
  </Box>
</Box>
```

## 3. DataGrid Responsiveness

### The Issue
MUI DataGrid (and other table libraries) can be aggressive about width. Even inside a constrained container, they might try to render full width, causing horizontal scrollbars on the *page* instead of the *grid*.

### The Fix
1.  **Container Constraints:** Ensure the immediate parent of the DataGrid has `width: '100%'`, `maxWidth: '100%'`, and `overflow: 'hidden'` (or `auto`).
2.  **Column Management:** 
    -   Use `flex: 1` for columns that should stretch.
    -   Set `minWidth` on columns to prevent them from becoming unreadable.
    -   Hide less critical columns by default (e.g., `CreatedDate`) using `columnVisibilityModel`.

**Example:**
```tsx
<Paper sx={{ width: '100%', maxWidth: '100%', overflow: 'hidden' }}>
  <DataGrid
    // ...
    initialState={{
      columns: {
        columnVisibilityModel: {
          CreatedDate: false, // Hide less important columns
        },
      },
    }}
  />
</Paper>
```

## 4. Top-Level Layout Structure (Admin/Agent/Group)

To ensure consistent behavior across different portals (Tenant Admin, Agent, Group Admin), the top-level layout components must follow a strict pattern:

1.  **Outer Wrapper:** `min-h-screen flex`
2.  **Sidebar:** Fixed positioning or flex item with fixed width.
3.  **Main Content Wrapper:**
    -   `flex-1` (fill remaining space)
    -   `min-w-0` (prevent infinite growth from children)
    -   `transition-all` (for smooth sidebar collapse/expand)
    -   `margin-left` (to account for fixed sidebar)
4.  **Scroll Container:**
    -   Inside the main content wrapper.
    -   `h-screen` (full height)
    -   `overflow-y-auto` (vertical scroll)
    -   `flex flex-col`

**Code Reference:**
- `frontend/src/components/tenant-admin/TenantAdminLayout.tsx`
- `frontend/src/components/agent/AgentLayout.tsx`
- `frontend/src/components/group-admin/GroupAdminLayout.tsx`

## 5. Horizontal Scrolling & Clipping

When content is cut off on the right side:
1.  **Check Layout Constraints:** Apply Fix #1 (Infinite Width).
2.  **Check Overflow:** Ensure the parent container has `overflow-x-auto` or `overflow-auto`.
3.  **Check Stacking:** If using `position: absolute` or `fixed` elements, ensure `z-index` is correct.
4.  **Check Padding:** Ensure `p-3` or similar padding isn't pushing content out of a `100%` width container (use `box-sizing: border-box` which is default in Tailwind/MUI).

## Summary of Recent Fixes (Feb 2026)

-   **GroupDetails Page:** Applied `zoom: '80%'` to the main container to provide a high-density view.
-   **GroupMembersTab:** Constrained DataGrid width and hid "Added" column to prevent horizontal overflow.
-   **Layout Components:** Added `min-w-0` to all layout main content areas (`TenantAdminLayout`, `AgentLayout`, `GroupAdminLayout`) to fix the "infinite width" flexbox bug that was breaking responsiveness when sidebars were toggled.
