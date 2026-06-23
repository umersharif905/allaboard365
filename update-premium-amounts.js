// Script to update premium amounts for existing enrollments
const { getPool, sql } = require('./backend/config/database');

async function updatePremiumAmounts() {
    const pool = await getPool();
    
    try {
        console.log('🔄 Starting premium amount update...');
        
        // Get all active enrollments with 0 premium amount
        const enrollmentsQuery = `
            SELECT 
                e.EnrollmentId,
                e.MemberId,
                e.ProductId,
                m.Tier,
                p.IsVendorPrice,
                p.Name as ProductName
            FROM oe.Enrollments e
            JOIN oe.Members m ON e.MemberId = m.MemberId
            JOIN oe.Products p ON e.ProductId = p.ProductId
            WHERE e.Status = 'Active' 
            AND e.PremiumAmount = 0
        `;
        
        const enrollmentsResult = await pool.request().query(enrollmentsQuery);
        const enrollments = enrollmentsResult.recordset;
        
        console.log(`📊 Found ${enrollments.length} enrollments with 0 premium amount`);
        
        let updatedCount = 0;
        let errorCount = 0;
        
        for (const enrollment of enrollments) {
            try {
                // Get the pricing for this product and tier
                const pricingQuery = `
                    SELECT TOP 1 
                        NetRate,
                        OverrideRate,
                        VendorCommission
                    FROM oe.ProductPricing
                    WHERE ProductId = @productId 
                    AND TierType = @tierType
                    ORDER BY NetRate ASC
                `;
                
                const pricingRequest = pool.request();
                pricingRequest.input('productId', sql.UniqueIdentifier, enrollment.ProductId);
                pricingRequest.input('tierType', sql.NVarChar, enrollment.Tier);
                
                const pricingResult = await pricingRequest.query(pricingQuery);
                
                if (pricingResult.recordset.length === 0) {
                    console.log(`⚠️ No pricing found for product ${enrollment.ProductName} (${enrollment.ProductId}) with tier ${enrollment.Tier}`);
                    continue;
                }
                
                const pricing = pricingResult.recordset[0];
                
                // Calculate premium amount based on product type
                let premiumAmount = 0;
                if (enrollment.IsVendorPrice) {
                    premiumAmount = (Number(pricing.NetRate) || 0) + (Number(pricing.VendorCommission) || 0);
                } else {
                    premiumAmount = (Number(pricing.NetRate) || 0) + (Number(pricing.OverrideRate) || 0);
                }
                
                // Update the enrollment with the calculated premium amount
                const updateQuery = `
                    UPDATE oe.Enrollments 
                    SET PremiumAmount = @premiumAmount,
                        ModifiedDate = GETUTCDATE()
                    WHERE EnrollmentId = @enrollmentId
                `;
                
                const updateRequest = pool.request();
                updateRequest.input('enrollmentId', sql.UniqueIdentifier, enrollment.EnrollmentId);
                updateRequest.input('premiumAmount', sql.Decimal(19,4), premiumAmount);
                
                await updateRequest.query(updateQuery);
                
                console.log(`✅ Updated enrollment ${enrollment.EnrollmentId} for ${enrollment.ProductName} (${enrollment.Tier}): $${premiumAmount}`);
                updatedCount++;
                
            } catch (error) {
                console.error(`❌ Error updating enrollment ${enrollment.EnrollmentId}:`, error.message);
                errorCount++;
            }
        }
        
        console.log(`\n📊 Update Summary:`);
        console.log(`✅ Successfully updated: ${updatedCount} enrollments`);
        console.log(`❌ Errors: ${errorCount} enrollments`);
        console.log(`📋 Total processed: ${enrollments.length} enrollments`);
        
    } catch (error) {
        console.error('❌ Error in updatePremiumAmounts:', error);
    } finally {
        await pool.close();
    }
}

// Run the update
updatePremiumAmounts()
    .then(() => {
        console.log('🎉 Premium amount update completed!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('💥 Fatal error:', error);
        process.exit(1);
    });
