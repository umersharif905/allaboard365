// @ts-check
/**
 * Fetch ProductDocuments for multiple product IDs.
 * Returns a Map<productId, documents[]> for attaching to product objects.
 * Table oe.ProductDocuments may not exist before migration; returns empty map on error.
 */
async function getProductDocumentsForProductIds(pool, productIds, sql) {
    if (!pool || !productIds || productIds.length === 0) {
        return new Map();
    }
    const uniqueIds = [...new Set(productIds)].filter(Boolean);
    if (uniqueIds.length === 0) return new Map();
    try {
        const request = pool.request();
        uniqueIds.forEach((id, index) => {
            request.input(`ProductId${index}`, sql.UniqueIdentifier, id);
        });
        const inClause = uniqueIds.map((_, i) => `@ProductId${i}`).join(', ');
        const result = await request.query(`
            SELECT ProductDocumentId, ProductId, DocumentUrl, DisplayName, SortOrder
            FROM oe.ProductDocuments
            WHERE ProductId IN (${inClause})
            ORDER BY ProductId, SortOrder ASC, CreatedDate ASC
        `);
        const byProduct = new Map();
        for (const row of result.recordset || []) {
            const pid = row.ProductId;
            if (!byProduct.has(pid)) byProduct.set(pid, []);
            byProduct.get(pid).push({
                productDocumentId: row.ProductDocumentId,
                documentUrl: row.DocumentUrl,
                displayName: row.DisplayName,
                sortOrder: row.SortOrder ?? 0
            });
        }
        return byProduct;
    } catch (err) {
        console.warn('⚠️ getProductDocumentsForProductIds failed (table may not exist):', err.message);
        return new Map();
    }
}

module.exports = {
    getProductDocumentsForProductIds
};
