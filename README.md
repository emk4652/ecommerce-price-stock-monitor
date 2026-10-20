# E-Commerce Competitive Price & Stock Monitor

Tracks competitor product prices, stock availability, SKU codes, and discount margins across Shopify, WooCommerce, Magento, BigCommerce, and Schema.org e-commerce stores.

## Core Capabilities

- **Multi-Layer Extraction Engine**:
  1. Probes native Shopify `.json` endpoints for variant-level pricing, compare-at prices, and inventory state.
  2. Parses `application/ld+json` (`Schema.org/Product` and `Offer` graphs) for structured price, currency, brand, and SKU attributes.
  3. Falls back to OpenGraph (`product:price:amount`) and semantic HTML price selectors.
- **Automated Threshold Alerts**: Evaluates extracted prices against `targetPriceThreshold` and dispatches JSON payloads to any configured webhook (Slack, Discord, n8n, Make, Zapier).
- **Pay-Per-Event Ready**: Charges per verified product check (`product-checked`) with predictable unit economics.

## Input Configuration

```json
{
  "productUrls": [
    "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"
  ],
  "targetPriceThreshold": 60,
  "tryShopifyJsonEndpoint": true
}
```

## Output Dataset Example

```json
{
  "url": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
  "title": "A Light in the Attic",
  "brand": null,
  "sku": "a897fe39b1053632",
  "price": 51.77,
  "compareAtPrice": null,
  "discountPercentage": 0,
  "currency": "GBP",
  "inStock": true,
  "platform": "Custom / Standard E-Commerce",
  "extractionMethod": "OpenGraph & Semantic HTML",
  "targetPriceThreshold": 60,
  "priceAlertTriggered": true,
  "imageUrl": null,
  "checkedAt": "2026-10-20T11:36:00.000Z"
}
```
