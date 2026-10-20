import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

async function getRuntime() {
    try {
        const { Actor } = await import('apify');
        await Actor.init();
        return {
            isApify: true,
            getInput: async () => (await Actor.getInput()) || {},
            pushData: async (item) => {
                try {
                    await Actor.pushData(item, 'product-checked');
                } catch {
                    await Actor.pushData(item);
                }
            },
            charge: async (eventName, count = 1) => {
                if (typeof Actor.charge === 'function') {
                    try {
                        await Actor.charge({ eventName, count });
                    } catch {
                        // Ignore when running outside Pay-Per-Event billing
                    }
                }
            },
            exit: async () => Actor.exit(),
        };
    } catch {
        const inputPath = path.resolve(process.cwd(), 'INPUT.json');
        const localInput = fs.existsSync(inputPath)
            ? JSON.parse(fs.readFileSync(inputPath, 'utf8'))
            : {
                  productUrls: ['https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html'],
                  targetPriceThreshold: 60,
                  tryShopifyJsonEndpoint: true,
              };
        const outDir = path.resolve(process.cwd(), 'storage', 'datasets', 'default');
        fs.mkdirSync(outDir, { recursive: true });
        let counter = 1;
        return {
            isApify: false,
            getInput: async () => localInput,
            pushData: async (item) => {
                const file = path.join(outDir, `${String(counter++).padStart(9, '0')}.json`);
                fs.writeFileSync(file, JSON.stringify(item, null, 2), 'utf8');
            },
            charge: async () => {},
            exit: async () => {},
        };
    }
}

function parseNumericPrice(raw) {
    if (typeof raw === 'number') return raw;
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.replace(/[^0-9.,]/g, '').trim();
    if (!cleaned) return null;
    const normalized =
        cleaned.includes(',') && cleaned.includes('.')
            ? cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
                ? cleaned.replace(/\./g, '').replace(',', '.')
                : cleaned.replace(/,/g, '')
            : cleaned.replace(',', '.');
    const num = Number.parseFloat(normalized);
    return Number.isFinite(num) ? num : null;
}

function detectCurrencySymbol(rawText = '') {
    if (rawText.includes('£') || /GBP/i.test(rawText)) return 'GBP';
    if (rawText.includes('€') || /EUR/i.test(rawText)) return 'EUR';
    if (rawText.includes('$') || /USD/i.test(rawText)) return 'USD';
    return 'USD';
}

function parseJsonLdProducts(html) {
    const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
        try {
            const data = JSON.parse(match[1].trim());
            const candidates = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
            for (const item of candidates) {
                if (!item || typeof item !== 'object') continue;
                const typeVal = Array.isArray(item['@type']) ? item['@type'].join(' ') : String(item['@type'] || '');
                if (/Product/i.test(typeVal)) {
                    const offersRaw = item.offers;
                    const offer = Array.isArray(offersRaw) ? offersRaw[0] : offersRaw || {};
                    const price = parseNumericPrice(offer.price ?? offer.lowPrice ?? item.price);
                    const availability = String(offer.availability || '');
                    const inStock =
                        /InStock|PreOrder|LimitedAvailability/i.test(availability) ||
                        (!/OutOfStock|SoldOut|Discontinued/i.test(availability) && price !== null);
                    return {
                        title: item.name || null,
                        brand: typeof item.brand === 'object' ? item.brand?.name : item.brand || null,
                        sku: item.sku || item.mpn || offer.sku || null,
                        price,
                        currency: offer.priceCurrency || 'USD',
                        inStock,
                        availabilityRaw: availability || (inStock ? 'InStock' : 'OutOfStock'),
                        imageUrl: Array.isArray(item.image) ? item.image[0] : item.image || null,
                        extractionMethod: 'JSON-LD Schema.org',
                    };
                }
            }
        } catch {
            // Ignore malformed JSON-LD block
        }
    }
    return null;
}

function parseOpenGraphAndHtmlFallback(html) {
    const getMeta = (prop) => {
        const regex = new RegExp(
            `<meta[^>]+(?:property|name|itemprop)=["']${prop}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["']${prop}["']`,
            'i'
        );
        const m = html.match(regex);
        return m ? (m[1] || m[2]).trim() : null;
    };

    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const fallbackTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;

    const ogPrice = getMeta('product:price:amount') || getMeta('og:price:amount') || getMeta('price');
    const ogCurrency = getMeta('product:price:currency') || getMeta('og:price:currency') || getMeta('priceCurrency');

    const priceHtmlMatch =
        html.match(/class=["'][^"']*price_color[^"']*["'][^>]*>([^<]+)</i) ||
        html.match(/class=["'][^"']*product-price[^"']*["'][^>]*>([\s\S]*?)</i) ||
        html.match(/([£$€]\s*\d+(?:[.,]\d{2})?)/);

    const rawPriceText = ogPrice || (priceHtmlMatch ? priceHtmlMatch[1] : null);
    const price = parseNumericPrice(rawPriceText);
    const currency = ogCurrency || detectCurrencySymbol(rawPriceText || html);

    const outOfStockRegex = /out\s*of\s*stock|sold\s*out|agotado|currently\s*unavailable/i;
    const inStockRegex = /in\s*stock|instock|add\s*to\s*cart|disponible/i;
    const inStock = inStockRegex.test(html) ? true : !outOfStockRegex.test(html);

    const skuMatch =
        html.match(/<th>\s*UPC\s*<\/th>\s*<td>([^<]+)<\/td>/i) ||
        html.match(/"sku"\s*:\s*"([^"]+)"/i);

    return {
        title: getMeta('og:title') || fallbackTitle,
        brand: getMeta('product:brand') || null,
        sku: skuMatch ? skuMatch[1].trim() : null,
        price,
        currency,
        inStock,
        availabilityRaw: inStock ? 'InStock' : 'OutOfStock',
        imageUrl: getMeta('og:image') || null,
        extractionMethod: 'OpenGraph & Semantic HTML',
    };
}

function detectEcommercePlatform(html) {
    if (/cdn\.shopify\.com|Shopify\.theme/i.test(html)) return 'Shopify';
    if (/woocommerce|wc-cart-fragments/i.test(html)) return 'WooCommerce';
    if (/mage\/cookies|Magento_/i.test(html)) return 'Magento';
    if (/bigcommerce\.com/i.test(html)) return 'BigCommerce';
    return 'Custom / Standard E-Commerce';
}

async function tryFetchShopifyProductJson(productUrl) {
    try {
        const parsed = new URL(productUrl);
        if (!parsed.pathname.includes('/products/')) return null;
        const jsonUrl = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}.json`;
        const res = await fetch(jsonUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ApifyEcommerceMonitor/1.0)',
                Accept: 'application/json',
            },
        });
        if (!res.ok) return null;
        const payload = await res.json();
        if (!payload || !payload.product) return null;
        const p = payload.product;
        const primaryVariant = Array.isArray(p.variants) && p.variants.length > 0 ? p.variants[0] : {};
        const price = parseNumericPrice(primaryVariant.price);
        const compareAtPrice = parseNumericPrice(primaryVariant.compare_at_price);
        return {
            title: p.title,
            brand: p.vendor || null,
            sku: primaryVariant.sku || String(primaryVariant.id || p.id),
            price,
            compareAtPrice,
            discountPercentage:
                compareAtPrice && price && compareAtPrice > price
                    ? Number((((compareAtPrice - price) / compareAtPrice) * 100).toFixed(2))
                    : 0,
            currency: 'USD',
            inStock: primaryVariant.available !== false,
            variantsCount: Array.isArray(p.variants) ? p.variants.length : 1,
            imageUrl: p.image?.src || p.images?.[0]?.src || null,
            platform: 'Shopify',
            extractionMethod: 'Shopify Native Product JSON API',
        };
    } catch {
        return null;
    }
}

async function run() {
    const runtime = await getRuntime();
    const input = await runtime.getInput();

    const productUrls =
        Array.isArray(input.productUrls) && input.productUrls.length > 0
            ? input.productUrls
            : ['https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html'];
    const targetPriceThreshold =
        typeof input.targetPriceThreshold === 'number' ? input.targetPriceThreshold : null;
    const webhookUrl = typeof input.webhookUrl === 'string' && input.webhookUrl.trim() ? input.webhookUrl.trim() : null;
    const tryShopifyJsonEndpoint = input.tryShopifyJsonEndpoint !== false;

    console.log(`[Ecommerce-Price-Monitor] Monitoring ${productUrls.length} product URL(s)...`);

    for (const targetUrl of productUrls) {
        try {
            let extracted = null;
            if (tryShopifyJsonEndpoint) {
                extracted = await tryFetchShopifyProductJson(targetUrl);
            }

            if (!extracted) {
                const res = await fetch(targetUrl, {
                    headers: {
                        'User-Agent':
                            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    },
                });
                const html = await res.text();
                const platform = detectEcommercePlatform(html);
                const schemaProduct = parseJsonLdProducts(html);
                const fallbackProduct = schemaProduct || parseOpenGraphAndHtmlFallback(html);
                extracted = {
                    ...fallbackProduct,
                    platform,
                };
            }

            const priceAlertTriggered =
                targetPriceThreshold !== null &&
                typeof extracted.price === 'number' &&
                extracted.price <= targetPriceThreshold;

            const record = {
                url: targetUrl,
                title: extracted.title,
                brand: extracted.brand,
                sku: extracted.sku,
                price: extracted.price,
                compareAtPrice: extracted.compareAtPrice || null,
                discountPercentage: extracted.discountPercentage || 0,
                currency: extracted.currency || 'USD',
                inStock: Boolean(extracted.inStock),
                platform: extracted.platform,
                extractionMethod: extracted.extractionMethod,
                targetPriceThreshold,
                priceAlertTriggered,
                imageUrl: extracted.imageUrl,
                checkedAt: new Date().toISOString(),
            };

            if (webhookUrl && priceAlertTriggered) {
                try {
                    await fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            alert: 'PRICE_THRESHOLD_REACHED',
                            product: record,
                        }),
                    });
                } catch {
                    // Non-blocking webhook error
                }
            }

            await runtime.pushData(record);
            await runtime.charge('product-checked', 1);
            console.log(
                `[Ecommerce-Price-Monitor] Checked "${record.title}" | ${record.price} ${record.currency} | InStock: ${record.inStock} | Alert: ${record.priceAlertTriggered}`
            );
        } catch (err) {
            await runtime.pushData({
                url: targetUrl,
                error: err.message || 'Failed to extract product data',
                checkedAt: new Date().toISOString(),
            });
            console.error(`[Ecommerce-Price-Monitor] Failed on ${targetUrl}: ${err.message}`);
        }
    }

    await runtime.exit();
}

run();
