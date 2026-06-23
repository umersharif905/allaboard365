const { generateAuthenticatedUrl, isBlobUrl } = require('../routes/uploads');

/**
 * Replace definition.headerImage.url with a read SAS when it points at a private Azure blob
 * (anonymous <img src> cannot use raw blob URLs).
 */
async function definitionWithAuthenticatedHeaderImage(definition) {
    if (!definition || typeof definition !== 'object') return definition;
    const hi = definition.headerImage;
    const url = hi && typeof hi.url === 'string' ? hi.url.trim() : '';
    if (!url || !isBlobUrl(url)) return definition;
    try {
        const sasUrl = await generateAuthenticatedUrl(url);
        return {
            ...definition,
            headerImage: { ...hi, url: sasUrl }
        };
    } catch (e) {
        console.warn('form definition header image SAS failed', e.message);
        return definition;
    }
}

module.exports = {
    definitionWithAuthenticatedHeaderImage
};
