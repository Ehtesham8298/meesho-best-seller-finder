let allRankedProducts = [];
let scanStartTime = 0;
let timerInterval = null;

document.getElementById("scanBtn").addEventListener("click", startScan);
document.getElementById("downloadBtn").addEventListener("click", downloadCSV);
document.getElementById("useCurrentBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.includes("meesho.com")) {
    document.getElementById("urlInput").value = tab.url;
  } else {
    document.getElementById("urlInput").value = "";
    document.getElementById("urlInput").placeholder =
      "Not a Meesho page! Paste URL here";
  }
});

// Auto-fill URL from current tab on load
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.includes("meesho.com")) {
    document.getElementById("urlInput").value = tab.url;
  }
})();

async function startScan() {
  const btn = document.getElementById("scanBtn");
  btn.disabled = true;
  btn.textContent = "Scanning...";

  document.getElementById("error").style.display = "none";
  document.getElementById("results").style.display = "none";
  document.getElementById("downloadBtn").style.display = "none";
  document.getElementById("progress").style.display = "block";

  // Start timer
  scanStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - scanStartTime) / 1000);
    document.getElementById("progressTime").textContent = elapsed + "s";
  }, 1000);

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    const inputUrl = document.getElementById("urlInput").value.trim();
    let targetUrl = inputUrl || tab.url;

    if (!targetUrl || !targetUrl.includes("meesho.com")) {
      showError(
        "Please enter a Meesho seller URL or open a seller page first!"
      );
      return;
    }

    // Navigate to the seller page if different from current
    if (inputUrl && inputUrl !== tab.url) {
      updateProgress(2, "Opening seller page...");
      await chrome.tabs.update(tab.id, { url: inputUrl });
      await waitForPageLoad(tab.id);
    }

    updateProgress(5, "Reading seller info...");

    // Step 1: Extract products from current page
    const firstPageData = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageData,
    });

    const data = firstPageData[0].result;
    if (!data || data.products.length === 0) {
      showError(
        "No products found! Make sure you are on a Meesho seller/store page (not a product or category page)."
      );
      return;
    }

    // Show seller info
    showSellerInfo(data.sellerInfo);

    const expectedTotal = data.sellerInfo?.totalProducts
      ? parseInt(String(data.sellerInfo.totalProducts).replace(/,/g, ""))
      : 0;

    let allProducts = [...data.products];
    const baseUrl = targetUrl.split("?")[0];

    updateProducts(allProducts.length, expectedTotal);
    updateProgress(10, `Page 1: ${data.products.length} products`);

    // Step 2: Load remaining pages
    let pageNum = 2;
    let hasMore = true;
    let consecutiveEmpty = 0;
    const maxPages = Math.max(Math.ceil(expectedTotal / 20) + 3, 15);

    while (hasMore) {
      const pageUrl = baseUrl + "?page=" + pageNum;

      const pct = expectedTotal
        ? Math.min(
            10 + Math.floor((allProducts.length / expectedTotal) * 55),
            65
          )
        : Math.min(10 + pageNum * 4, 65);

      updateProgress(
        pct,
        `Scanning page ${pageNum}...`
      );
      updateProducts(allProducts.length, expectedTotal);

      // Get current product IDs before navigation (to detect stale data)
      const prevIds = allProducts.map((p) => p.id).slice(-20);

      await chrome.tabs.update(tab.id, { url: pageUrl });
      await waitForPageLoad(tab.id);

      // Wait for fresh data — retry until we get new products or confirm empty
      let pageResult;
      let retries = 0;
      while (retries < 3) {
        // Scroll to load lazy content
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.scrollTo(0, document.body.scrollHeight),
          });
        } catch {}
        await new Promise((r) => setTimeout(r, 1500));

        pageResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractPageData,
        });

        const pageProducts = pageResult[0].result?.products || [];
        // Check if this is stale data (same products as we just had)
        const isStale =
          pageProducts.length > 0 &&
          pageProducts.every((p) => prevIds.includes(p.id));

        if (!isStale || pageProducts.length === 0) break;

        // Stale data — wait and retry
        retries++;
        await new Promise((r) => setTimeout(r, 2000));
      }

      const pageData = pageResult[0].result;
      const newProducts = (pageData?.products || []).filter(
        (p) => !allProducts.find((ap) => ap.id === p.id)
      );

      if (newProducts.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) hasMore = false;
        if (expectedTotal && allProducts.length >= expectedTotal)
          hasMore = false;
      } else {
        consecutiveEmpty = 0;
        allProducts.push(...newProducts);
        if (expectedTotal && allProducts.length >= expectedTotal)
          hasMore = false;
      }

      pageNum++;
      if (pageNum > maxPages) hasMore = false;
    }

    updateProducts(allProducts.length, expectedTotal);

    // Step 3: Rank by rating count
    allProducts.sort((a, b) => b.ratingCount - a.ratingCount);

    // Step 4: Visit top 20 product pages for exact review counts
    const top20 = allProducts.slice(0, 20).filter((p) => p.ratingCount > 0);
    if (top20.length > 0) {
      for (let i = 0; i < top20.length; i++) {
        const p = top20[i];
        const productUrl = p.slug
          ? `https://www.meesho.com/${p.slug}/p/${p.productId}`
          : null;
        if (!productUrl) continue;

        updateProgress(
          70 + Math.floor((i / top20.length) * 25),
          `Getting reviews: ${i + 1}/${top20.length}`
        );

        try {
          await chrome.tabs.update(tab.id, { url: productUrl });
          await waitForPageLoad(tab.id);

          const detailResult = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: extractProductDetails,
          });

          const details = detailResult[0].result;
          const idx = allProducts.findIndex((r) => r.id === p.id);
          if (idx !== -1 && details) {
            allProducts[idx].reviewCount = Math.max(
              allProducts[idx].reviewCount,
              details.reviewCount
            );
            allProducts[idx].ratingCount = Math.max(
              allProducts[idx].ratingCount,
              details.ratingCount
            );
            if (details.avgRating > 0) {
              allProducts[idx].avgRating = details.avgRating;
            }
          }
        } catch {}
      }
    }

    // Navigate back
    await chrome.tabs.update(tab.id, { url: baseUrl });

    updateProgress(100, "Done!");
    clearInterval(timerInterval);

    const elapsed = Math.floor((Date.now() - scanStartTime) / 1000);
    document.getElementById("progressTime").textContent = elapsed + "s total";

    allRankedProducts = allProducts;
    showResults(allProducts, expectedTotal, elapsed);
  } catch (err) {
    showError("Error: " + err.message);
  } finally {
    clearInterval(timerInterval);
    btn.disabled = false;
    btn.textContent = "Scan Again";
  }
}

function extractPageData() {
  const el = document.querySelector("#__NEXT_DATA__");
  if (!el) return { products: [], sellerInfo: null };

  const json = JSON.parse(el.textContent);
  const shopListing =
    json.props?.pageProps?.initialState?.shopListing?.listing;
  const pages = shopListing?.products || [];
  const rawProducts =
    pages.length > 0 && Array.isArray(pages[0]?.products)
      ? pages[0].products
      : [];

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

  const text = document.body.innerText || "";
  const followersMatch = text.match(/([\d,]+)\s*Followers?/i);
  const productsMatch = text.match(/([\d,]+)\s*Products?/i);
  const ratingsMatch = text.match(/([\d,]+)\s*Ratings?/i);
  const ratingMatch = text.match(/([\d.]+)\s*\u2605/);

  sellerInfo = sellerInfo || {};
  sellerInfo.followers = followersMatch ? followersMatch[1] : "N/A";
  sellerInfo.totalProducts = productsMatch ? productsMatch[1] : "N/A";
  sellerInfo.totalRatings = ratingsMatch
    ? ratingsMatch[1]
    : sellerInfo.ratingCount || "N/A";
  sellerInfo.ratingStr = ratingMatch
    ? ratingMatch[1]
    : sellerInfo.rating || "N/A";

  const products = rawProducts.map((p) => {
    const cr = p.catalog_reviews_summary || {};
    return {
      name: (p.name || "").trim(),
      id: p.id,
      productId: p.product_id,
      slug: p.slug,
      price: p.min_catalog_price || p.min_product_price || 0,
      avgRating: cr.average_rating || 0,
      ratingCount: cr.rating_count || 0,
      reviewCount: cr.review_count || 0,
      ratingMap: cr.rating_count_map || null,
    };
  });

  return { products, sellerInfo };
}

function extractProductDetails() {
  let ratingCount = 0;
  let reviewCount = 0;
  let avgRating = 0;

  const el = document.querySelector("#__NEXT_DATA__");
  if (el) {
    const text = el.textContent;
    const catalogBlock = text.match(
      /"review_count"\s*:\s*(\d+)\s*,\s*"rating_count"\s*:\s*(\d+)\s*,\s*"type"\s*:\s*"catalog"/
    );
    if (catalogBlock) {
      reviewCount = parseInt(catalogBlock[1]);
      ratingCount = parseInt(catalogBlock[2]);
    } else {
      const rc = text.match(/"rating_count"\s*:\s*(\d+)/);
      const rv = text.match(/"review_count"\s*:\s*(\d+)/);
      if (rc) ratingCount = parseInt(rc[1]);
      if (rv) reviewCount = parseInt(rv[1]);
    }
    const avgM = text.match(/"average_rating"\s*:\s*([\d.]+)/);
    if (avgM) avgRating = parseFloat(avgM[1]);
  }

  if (ratingCount === 0 && reviewCount === 0) {
    const bodyText = document.body.innerText || "";
    const ratingsM = bodyText.match(/([\d,]+)\s*Ratings?/i);
    const reviewsM = bodyText.match(/([\d,]+)\s*Reviews?/i);
    const avgM = bodyText.match(/([\d.]+)\s*\u2605/);
    if (ratingsM) ratingCount = parseInt(ratingsM[1].replace(/,/g, ""));
    if (reviewsM) reviewCount = parseInt(reviewsM[1].replace(/,/g, ""));
    if (avgM) avgRating = parseFloat(avgM[1]);
  }

  return { ratingCount, reviewCount, avgRating };
}

function waitForPageLoad(tabId) {
  return new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(); }
    }, 20000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        let checks = 0;
        const interval = setInterval(async () => {
          checks++;
          try {
            const result = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                const el = document.querySelector("#__NEXT_DATA__");
                return el && el.textContent.length > 1000;
              },
            });
            if (result[0].result || checks >= 10) {
              clearInterval(interval);
              if (!resolved) { resolved = true; clearTimeout(timeout); resolve(); }
            }
          } catch {
            clearInterval(interval);
            if (!resolved) { resolved = true; clearTimeout(timeout); resolve(); }
          }
        }, 500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function showSellerInfo(info) {
  if (!info) return;
  document.getElementById("sellerInfo").style.display = "block";
  document.getElementById("sellerName").textContent =
    info.name || "Seller Store";
  document.getElementById("sellerRating").textContent =
    (info.ratingStr || info.rating || "-") + " \u2605";
  document.getElementById("sellerRatings").textContent =
    info.totalRatings || "-";
  document.getElementById("sellerFollowers").textContent =
    info.followers || "-";
  document.getElementById("sellerProducts").textContent =
    info.totalProducts || "-";
}

function updateProgress(percent, text) {
  document.getElementById("progressFill").style.width = percent + "%";
  document.getElementById("progressText").textContent = text;
}

function updateProducts(found, total) {
  document.getElementById("progressProducts").textContent =
    total ? `${found}/${total} products` : `${found} products`;
}

function showError(msg) {
  document.getElementById("progress").style.display = "none";
  document.getElementById("error").style.display = "block";
  document.getElementById("errorText").textContent = msg;
  document.getElementById("scanBtn").disabled = false;
  document.getElementById("scanBtn").textContent = "Scan All Products";
  clearInterval(timerInterval);
}

function showResults(products, expectedTotal, elapsed) {
  document.getElementById("progress").style.display = "none";
  const container = document.getElementById("results");
  container.style.display = "block";
  container.innerHTML = "";

  const withRatings = products.filter((p) => p.ratingCount > 0);
  const zeroRated = products.filter((p) => p.ratingCount === 0);
  const top10 = products.slice(0, 10);
  const worst5 = withRatings.slice(-5).reverse();

  // Summary note
  const summary = document.createElement("div");
  summary.className = "info-note note-green";
  summary.innerHTML = `Scanned <strong>${products.length}</strong>${expectedTotal ? "/" + expectedTotal : ""} products in <strong>${elapsed}s</strong> &mdash; <strong>${withRatings.length}</strong> rated, <strong>${zeroRated.length}</strong> unrated`;
  container.appendChild(summary);

  // TOP 10
  const heading = document.createElement("h3");
  heading.textContent = "Top 10 Best Sellers";
  heading.style.color = "#2e7d32";
  container.appendChild(heading);

  top10.forEach((p, i) => {
    container.appendChild(createProductCard(p, i, "best"));
  });

  // WORST sellers
  if (worst5.length > 0 && worst5[0].id !== top10[top10.length - 1]?.id) {
    const worstHeading = document.createElement("h3");
    worstHeading.textContent = "Least Sold (with ratings)";
    worstHeading.style.color = "#c62828";
    container.appendChild(worstHeading);

    worst5.forEach((p, i) => {
      const rank = withRatings.length - worst5.length + i + 1;
      container.appendChild(createProductCard(p, rank - 1, "worst"));
    });
  }

  // Zero rated note
  if (zeroRated.length > 0) {
    const zeroNote = document.createElement("div");
    zeroNote.className = "info-note note-orange";
    zeroNote.textContent = `${zeroRated.length} products have 0 ratings (no orders yet)`;
    container.appendChild(zeroNote);
  }

  document.getElementById("downloadBtn").style.display = "block";
}

function createProductCard(p, index, type) {
  const card = document.createElement("div");
  const isBest = type === "best" && index === 0;
  const isWorst = type === "worst";
  card.className = "product-card" + (isBest ? " best" : "") + (isWorst ? " worst" : "");

  const url = p.slug
    ? `https://www.meesho.com/${p.slug}/p/${p.productId}`
    : "#";

  let breakdownHtml = "";
  if (p.ratingMap) {
    breakdownHtml = `<div class="breakdown">
      5\u2605:${p.ratingMap["5"] || 0} | 4\u2605:${p.ratingMap["4"] || 0} | 3\u2605:${p.ratingMap["3"] || 0} | 2\u2605:${p.ratingMap["2"] || 0} | 1\u2605:${p.ratingMap["1"] || 0}
    </div>`;
  }

  const ratingChipClass = isWorst ? "chip-bad" : "chip-rating";

  card.innerHTML = `
    ${isBest ? '<div class="best-badge">BEST SELLER</div>' : ""}
    <div class="product-rank">#${index + 1}</div>
    <div class="product-name">${escapeHtml(p.name)}</div>
    <div class="product-meta">
      <span class="meta-chip chip-price">\u20B9${p.price}</span>
      <span class="meta-chip ${ratingChipClass}">${p.avgRating > 0 ? p.avgRating + " \u2605" : "No rating"}</span>
      <span class="meta-chip chip-ratings">${p.ratingCount.toLocaleString()} Ratings</span>
      <span class="meta-chip chip-reviews">${p.reviewCount.toLocaleString()} Reviews</span>
      ${breakdownHtml}
    </div>
    <a class="product-link" href="${url}" target="_blank">View on Meesho \u2192</a>
  `;
  return card;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function downloadCSV() {
  const rows = ["Rank,Name,Price,Avg Rating,Ratings,Reviews,URL"];
  allRankedProducts.forEach((p, i) => {
    const url = p.slug
      ? `https://www.meesho.com/${p.slug}/p/${p.productId}`
      : "";
    rows.push(
      `${i + 1},"${(p.name || "").replace(/"/g, '""')}",${p.price},${p.avgRating},${p.ratingCount},${p.reviewCount},${url}`
    );
  });

  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "meesho-products.csv";
  a.click();
  URL.revokeObjectURL(url);
}
