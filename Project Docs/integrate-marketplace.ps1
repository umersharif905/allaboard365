# ===================================================================================================
# MARKETPLACE INTEGRATION SCRIPT
# ===================================================================================================
# This script adds admin controls to your existing marketplace without breaking functionality

Write-Host "🔗 Integrating Admin Controls with Existing Marketplace..." -ForegroundColor Green

# Create backup of existing marketplace
if (Test-Path "src/pages/admin/marketplace.tsx") {
    Copy-Item "src/pages/admin/marketplace.tsx" "src/pages/admin/marketplace.tsx.backup" -Force
    Write-Host "✅ Created backup of existing marketplace.tsx" -ForegroundColor Green
}

# Read existing marketplace content
$existingContent = Get-Content "src/pages/admin/marketplace.tsx" -Raw

# Add imports for new admin components at the top
$newImports = @"
import AdminMarketplaceControls from '../../components/admin-marketplace/AdminMarketplaceControls';
"@

# Insert the import after existing imports
$updatedContent = $existingContent -replace "(import.*from.*lucide-react.*';)", "`$1`n$newImports"

# Add admin controls section before the products display
$adminControlsSection = @"
          {/* Admin Controls - Only show for Admin users */}
          {userRole === 'Admin' && (
            <AdminMarketplaceControls
              products={filteredProducts}
              selectedProducts={selectedProducts}
              onProductsRefresh={fetchMarketplaceProducts}
              onProductEdit={(productId) => {
                console.log('Edit product:', productId);
                // TODO: Implement product editing
              }}
              onProductDelete={(productId) => {
                console.log('Delete product:', productId);
                // Handled by the component
              }}
              onProductClone={(productId) => {
                console.log('Clone product:', productId);
                // TODO: Implement product cloning
              }}
              onOwnershipTransfer={(productId) => {
                console.log('Transfer ownership:', productId);
                // TODO: Implement ownership transfer
              }}
            />
          )}

"@

# Insert admin controls before the products display section
$updatedContent = $updatedContent -replace "(          {/\* Products Display \*/)", "$adminControlsSection`$1"

# Add selectedProducts state management
$selectedProductsState = @"
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
"@

# Insert after existing state declarations
$updatedContent = $updatedContent -replace "(  const \[userRole, setUserRole\] = useState<string>\(''\);)", "`$1`n$selectedProductsState"

# Add selection checkbox to ProductCard component
$checkboxInCard = @"
            <input
              type="checkbox"
              checked={selectedProducts.includes(product.ProductId)}
              onChange={(e) => {
                if (e.target.checked) {
                  setSelectedProducts([...selectedProducts, product.ProductId]);
                } else {
                  setSelectedProducts(selectedProducts.filter(id => id !== product.ProductId));
                }
              }}
              className="absolute top-2 left-2 z-10"
            />
"@

# Insert checkbox in ProductCard component
$updatedContent = $updatedContent -replace "(          <div className=`"absolute top-2 right-2 flex flex-col gap-1`">)", "$checkboxInCard`n`$1"

# Add selection checkbox to ProductListItem component  
$checkboxInListItem = @"
                        <input
                          type="checkbox"
                          checked={selectedProducts.includes(product.ProductId)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedProducts([...selectedProducts, product.ProductId]);
                            } else {
                              setSelectedProducts(selectedProducts.filter(id => id !== product.ProductId));
                            }
                          }}
                          className="mt-1"
                        />
"@

# Insert checkbox in ProductListItem component
$updatedContent = $updatedContent -replace "(          <div className=`"w-16 h-16 flex-shrink-0 rounded-md overflow-hidden bg-gray-50 flex items-center justify-center px-2.5`">)", "$checkboxInListItem`n`$1"

# Save the updated content
Set-Content -Path "src/pages/admin/marketplace.tsx" -Value $updatedContent -Encoding UTF8
Write-Host "✅ Updated existing marketplace.tsx with admin controls" -ForegroundColor Green
