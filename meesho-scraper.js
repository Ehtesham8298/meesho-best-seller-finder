const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
puppeteer.use(StealthPlugin());

const SELLER_URL = process.argv[2];

if (!SELLER_URL || !SELLER_URL.includes("meesho.com")) {
  console.log("\n  MEESHO BEST SELLER FINDER");
  console.log("  =========================\n");
  console.log("  Usage: node meesho-scraper.js <seller_page_url>\n");
  console.log("  Example:");
  console.log(
    '  node meesho-scraper.js "https://www.meesho.com/CozyfoxStoreIndia"\n'
  );
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPage(page) {
  console.log("\n  >> Browser opened. If CAPTCHA appears, please solve it.");
  console.log("  >> Waiting for page to load...\n");

  for (let i = 0; i < 60; i++) {
    const has = await page.evaluate(() => {
      const el = document.querySelector("#__NEXT_DATA__");
      if (!el) return false;
      return el.textContent.includes("shopListing");
    });
    if (has) {
      console.log("  >> Page loaded!\n");
      return true;
    }
    await sleep(2000);
    if (i % 5 === 4) console.log(`  >> Still waiting... (${(i + 1) * 2}s)`);
  }
  return false;
}

async function extractProductsFromPage(page) {
  // First scroll to load all lazy content
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 400);
        total += 400;
        if (total >= document.body.scrollHeight + 1000) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
      setTimeout(() => { clearInterval(timer); resolve(); }, 12000);
    });
  });
  await sleep(2000);

  return await page.evaluate(() => {
    const el = document.querySelector("#__NEXT_DATA__");
    if (!el) return { products: [], sellerInfo: null };

    const json = JSON.parse(el.textContent);
    const shopListing =
      json.props?.pageProps?.initialState?.shopListing?.listing;
    const pages = shopListing?.products || [];
    const rawProducts = (pages.length > 0 && Array.isArray(pages[0]?.products)) ? pages[0].products : [];

    // Extract seller info from first product's supplier_reviews_summary
    let sellerInfo = null;
    for (const p of rawProducts) {
      const sr = p.supplier_reviews_summary;
      if (sr && sr.rating_count > 0) {
        sellerInfo = {
          rating: sr.average_rating,
          ratingCount: sr.rating_count,
        };
        break;
      }
    }

    // Also scrape visible HTML cards — Meesho shows "X Reviews" on cards
    // but that number is actually the rating_count, not separate reviews.
    // We use it as a fallback for rating count when API returns 0.
    const htmlCards = [];
    const allLinks = document.querySelectorAll('a[href*="/p/"]');
    allLinks.forEach((link) => {
      const card = link.closest('[class*="Card"]') || link.closest('[class*="card"]') || link;
      const text = card.innerText || "";
      const href = link.getAttribute("href") || "";

      const pidMatch = href.match(/\/p\/([a-z0-9]+)/i);
      const pid = pidMatch ? pidMatch[1] : null;

      // Meesho cards show "641 Reviews" but it's actually total ratings
      const countMatch = text.match(/([\d,]+)\s*Reviews?/i);
      const ratingMatch = text.match(/([\d.]+)\s*★/);

      if (pid) {
        htmlCards.push({
          productId: pid,
          htmlCount: countMatch ? parseInt(countMatch[1].replace(/,/g, "")) : 0,
          htmlRating: ratingMatch ? parseFloat(ratingMatch[1]) : 0,
        });
      }
    });

    const products = rawProducts.map((p) => {
      const cr = p.catalog_reviews_summary || {};
      const htmlData = htmlCards.find((h) => h.productId === p.product_id) || {};

      const apiRatingCount = cr.rating_count || 0;
      const apiReviewCount = cr.review_count || 0;
      const apiAvgRating = cr.average_rating || 0;

      // Use API rating_count, fallback to HTML card count
      const ratingCount = apiRatingCount || htmlData.htmlCount || 0;

      return {
        name: (p.name || "").trim(),
        id: p.id,
        productId: p.product_id,
        slug: p.slug,
        price: p.min_catalog_price || p.min_product_price || 0,
        avgRating: apiAvgRating || htmlData.htmlRating || 0,
        ratingCount,
        reviewCount: apiReviewCount,
        ratingMap: cr.rating_count_map || null,
      };
    });

    return { products, sellerInfo, hasNextPage: shopListing?.hasNextPage };
  });
}

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("  MEESHO BEST SELLER FINDER (v2 - API Mode)");
  console.log("=".repeat(60));
  console.log(`  URL: ${SELLER_URL}`);
  console.log("=".repeat(60));

  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1366,768"],
    defaultViewport: { width: 1366, height: 768 },
  });

  const page = await browser.newPage();

  try {
    // Load first page
    console.log("\n  Opening seller page...");
    await page.goto(SELLER_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    const loaded = await waitForPage(page);
    if (!loaded) {
      console.log("  Failed to load. Try again.");
      await browser.close();
      return;
    }

    // Extract seller info from page
    const sellerText = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const followersMatch = text.match(/([\d,]+)\s*Followers?/i);
      const productsMatch = text.match(/([\d,]+)\s*Products?/i);
      const ratingsMatch = text.match(/([\d,]+)\s*Ratings?/i);
      const ratingMatch = text.match(/([\d.]+)\s*★/);
      const h1 = document.querySelector("h1");
      return {
        name: h1 ? h1.innerText.trim() : "Unknown",
        followers: followersMatch ? followersMatch[1] : "N/A",
        totalProducts: productsMatch ? productsMatch[1] : "N/A",
        totalRatings: ratingsMatch ? ratingsMatch[1] : "N/A",
        rating: ratingMatch ? ratingMatch[1] : "N/A",
      };
    });

    // Get first page data
    let firstData = await extractProductsFromPage(page);
    let allProducts = [...firstData.products];

    const sellerRating = firstData.sellerInfo?.rating || sellerText.rating;
    const sellerRatingCount =
      firstData.sellerInfo?.ratingCount || sellerText.totalRatings;

    console.log("-".repeat(50));
    console.log("  SELLER INFO");
    console.log("-".repeat(50));
    console.log(`  Name:           ${sellerText.name}`);
    console.log(`  Rating:         ${sellerRating} ★`);
    console.log(`  Total Ratings:  ${sellerRatingCount}`);
    console.log(`  Followers:      ${sellerText.followers}`);
    console.log(`  Products:       ${sellerText.totalProducts}`);
    console.log("-".repeat(50));

    console.log(
      `\n  Page 1: ${firstData.products.length} products (with ratings from API)`
    );

    // Load remaining pages
    let pageNum = 2;
    let hasMore = true;

    while (hasMore) {
      const url = `${SELLER_URL}?page=${pageNum}`;
      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
      } catch {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      }
      await sleep(3000);

      const pageData = await extractProductsFromPage(page);
      const newProducts = pageData.products.filter(
        (p) => !allProducts.find((ap) => ap.id === p.id)
      );

      if (newProducts.length === 0) {
        // Try one more page before stopping
        hasMore = false;
      } else {
        allProducts.push(...newProducts);
        console.log(
          `  Page ${pageNum}: ${newProducts.length} new products (Total: ${allProducts.length})`
        );
        pageNum++;
        if (pageNum > 30) hasMore = false;
      }
    }

    console.log(`\n  Total products scraped: ${allProducts.length}`);

    // Rank by rating_count (= total people who rated = best indicator of sales)
    const ranked = allProducts
      .sort((a, b) => b.ratingCount - a.ratingCount);

    // Visit top 20 product pages to get exact review counts
    const top20 = ranked.slice(0, 20).filter((p) => p.ratingCount > 0);
    if (top20.length > 0) {
      console.log(
        `\n  Visiting top ${top20.length} product pages for exact review counts...\n`
      );

      for (let i = 0; i < top20.length; i++) {
        const p = top20[i];
        const productUrl = p.slug
          ? `https://www.meesho.com/${p.slug}/p/${p.productId}`
          : null;
        if (!productUrl) continue;

        try {
          await page.goto(productUrl, {
            waitUntil: "domcontentloaded",
            timeout: 25000,
          });

          // Wait for __NEXT_DATA__ to load on product page
          for (let w = 0; w < 15; w++) {
            const ready = await page.evaluate(() => {
              const el = document.querySelector("#__NEXT_DATA__");
              return el && el.textContent.includes("review_count");
            });
            if (ready) break;
            await sleep(1000);
          }

          const details = await page.evaluate(() => {
            let ratingCount = 0;
            let reviewCount = 0;
            let avgRating = 0;

            // Method 1: From __NEXT_DATA__ — find the catalog review_summary
            const el = document.querySelector("#__NEXT_DATA__");
            if (el) {
              const text = el.textContent;
              // Look for the catalog-level review summary block:
              // "review_count":26,"rating_count":17,"type":"catalog"
              const catalogBlock = text.match(
                /"review_count"\s*:\s*(\d+)\s*,\s*"rating_count"\s*:\s*(\d+)\s*,\s*"type"\s*:\s*"catalog"/
              );
              if (catalogBlock) {
                reviewCount = parseInt(catalogBlock[1]);
                ratingCount = parseInt(catalogBlock[2]);
              } else {
                // Fallback: find first review_count and rating_count separately
                const rc = text.match(/"rating_count"\s*:\s*(\d+)/);
                const rv = text.match(/"review_count"\s*:\s*(\d+)/);
                if (rc) ratingCount = parseInt(rc[1]);
                if (rv) reviewCount = parseInt(rv[1]);
              }
              const avgM = text.match(/"average_rating"\s*:\s*([\d.]+)/);
              if (avgM) avgRating = parseFloat(avgM[1]);
            }

            // Method 2: From visible text (fallback)
            if (ratingCount === 0 && reviewCount === 0) {
              const bodyText = document.body.innerText || "";
              const ratingsM = bodyText.match(/([\d,]+)\s*Ratings?/i);
              const reviewsM = bodyText.match(/([\d,]+)\s*Reviews?/i);
              const avgM = bodyText.match(/([\d.]+)\s*★/);
              if (ratingsM) ratingCount = parseInt(ratingsM[1].replace(/,/g, ""));
              if (reviewsM) reviewCount = parseInt(reviewsM[1].replace(/,/g, ""));
              if (avgM) avgRating = parseFloat(avgM[1]);
            }

            return { ratingCount, reviewCount, avgRating };
          });

          // Update product with real data (use max to avoid downgrading)
          const idx = ranked.findIndex((r) => r.id === p.id);
          if (idx !== -1) {
            ranked[idx].reviewCount = Math.max(
              ranked[idx].reviewCount,
              details.reviewCount
            );
            ranked[idx].ratingCount = Math.max(
              ranked[idx].ratingCount,
              details.ratingCount
            );
            if (details.avgRating > 0) {
              ranked[idx].avgRating = details.avgRating;
            }
          }

          console.log(
            `  [${i + 1}/${top20.length}] ${p.name.substring(0, 40)}... → ${details.ratingCount} ratings, ${details.reviewCount} reviews`
          );
        } catch {
          console.log(
            `  [${i + 1}/${top20.length}] ${p.name.substring(0, 40)}... → skipped (timeout)`
          );
        }
      }
    }

    // Display TOP 10
    console.log("\n" + "=".repeat(60));
    console.log("  TOP 10 BEST SELLING PRODUCTS");
    console.log("  (Ranked by Total Ratings = Most Sold)");
    console.log("=".repeat(60));

    const top = ranked.slice(0, 10);
    top.forEach((p, i) => {
      const tag = i === 0 ? "  >>> BEST SELLER <<<" : "";
      const url = p.slug
        ? `https://www.meesho.com/${p.slug}/p/${p.productId}`
        : "";
      console.log(`\n  #${i + 1} ${tag}`);
      console.log(`  Name:       ${p.name}`);
      console.log(`  Price:      Rs. ${p.price}`);
      console.log(`  Rating:     ${p.avgRating} ★`);
      console.log(`  Ratings:    ${p.ratingCount.toLocaleString()}`);
      console.log(`  Reviews:    ${p.reviewCount.toLocaleString()}`);
      if (url) console.log(`  URL:        ${url}`);
      if (p.ratingMap) {
        console.log(
          `  Breakdown:  5★:${p.ratingMap["5"] || 0} | 4★:${p.ratingMap["4"] || 0} | 3★:${p.ratingMap["3"] || 0} | 2★:${p.ratingMap["2"] || 0} | 1★:${p.ratingMap["1"] || 0}`
        );
      }
      console.log("  " + "-".repeat(45));
    });

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("  SUMMARY");
    console.log("=".repeat(60));
    console.log(`  Seller:               ${sellerText.name}`);
    console.log(`  Seller Rating:        ${sellerRating} ★ (${sellerRatingCount} total ratings)`);
    console.log(`  Total Products:       ${allProducts.length}`);
    if (ranked[0]) {
      console.log(`  Best Selling Product: ${ranked[0].name}`);
      console.log(
        `  Best Seller:          ${ranked[0].ratingCount.toLocaleString()} ratings, ${ranked[0].reviewCount.toLocaleString()} reviews`
      );
      const bestUrl = ranked[0].slug
        ? `https://www.meesho.com/${ranked[0].slug}/p/${ranked[0].productId}`
        : "";
      if (bestUrl) console.log(`  Best Seller URL:      ${bestUrl}`);
    }
    console.log("=".repeat(60));

    // Save CSV
    const csvRows = [
      "Rank,Name,Price,Avg Rating,Ratings,Reviews,URL",
    ];
    ranked.forEach((p, i) => {
      const url = p.slug
        ? `https://www.meesho.com/${p.slug}/p/${p.productId}`
        : "";
      csvRows.push(
        `${i + 1},"${(p.name || "").replace(/"/g, '""')}",${p.price},${p.avgRating},${p.ratingCount},${p.reviewCount},${url}`
      );
    });
    fs.writeFileSync("meesho-products.csv", csvRows.join("\n"), "utf-8");
    console.log("\n  All products saved to: meesho-products.csv\n");
  } catch (err) {
    console.error("\n  Error:", err.message);
    await page.screenshot({ path: "debug-error.png" });
  } finally {
    await browser.close();
  }
}

main();
