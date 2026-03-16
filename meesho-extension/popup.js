let allRankedProducts = [];
let scanStartTime = 0;
let timerInterval = null;
let cachedKeywords = []; // Store keywords from autocomplete for title optimizer

// Tab Navigation
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// SEO Tools Event Listeners
document.getElementById("autoTitleBtn").addEventListener("click", autoGenerateTitle);
document.getElementById("autoTitleInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") autoGenerateTitle();
});
// Trending removed
document.getElementById("keywordSearchBtn").addEventListener("click", fetchAutocomplete);
document.getElementById("keywordInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") fetchAutocomplete();
});
// Competitor Analysis removed
document.getElementById("optimizeTitleBtn").addEventListener("click", analyzeTitle);
document.getElementById("titleInput").addEventListener("input", updateTitleStats);
document.getElementById("copyTitleBtn").addEventListener("click", () => {
  const title = document.getElementById("titleInput").value;
  if (title) {
    navigator.clipboard.writeText(title);
    showToast("Title copied!");
  }
});

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

function isValidProductTitle(name, seed) {
  if (!name || name.trim().length < 3) return false;
  const n = name.trim();
  const words = n.split(/\s+/);

  // Person name pattern: "Anjali Singh Gurjar", "Zafeerah Zahoor"
  // All words capitalized, 2-4 words, no numbers/symbols
  if (words.length <= 4 && words.every((w) => /^[A-Z][a-z]+$/.test(w))) return false;

  return true;
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

// =====================================================
// SEO TOOLS
// =====================================================

function showToast(msg) {
  const toast = document.getElementById("copyToast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1500);
}

// --- Auto Title Generator ---
async function autoGenerateTitle() {
  const seed = document.getElementById("autoTitleInput").value.trim();
  if (!seed) return;

  const btn = document.getElementById("autoTitleBtn");
  const container = document.getElementById("autoTitleResults");
  btn.disabled = true;
  btn.textContent = "Working...";

  const MIN_RATINGS = parseInt(document.getElementById("minRatingInput").value) || 500;
  const TOP_TO_VISIT = parseInt(document.getElementById("topProductInput").value) || 20;
  const PAGES_PER_KEYWORD = parseInt(document.getElementById("maxPagesInput").value) || 10;
  const MAX_KEYWORDS = parseInt(document.getElementById("maxKeywordsInput").value) || 40;

  function updateStatus(step, title, detail, detail2, progress) {
    container.innerHTML = `
      <p style="font-size:12px;color:#570A57;text-align:center;margin-top:8px;font-weight:700;">${step}</p>
      <p style="font-size:11px;color:#333;text-align:center;font-weight:600;">${title}</p>
      ${detail ? `<p style="font-size:10px;color:#e65100;text-align:center;">${detail}</p>` : ""}
      ${detail2 ? `<p style="font-size:10px;color:#2e7d32;text-align:center;">${detail2}</p>` : ""}
      ${progress >= 0 ? `<div class="progress-bar" style="margin-top:6px;"><div class="progress-fill" style="width:${progress}%"></div></div>` : ""}`;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // === STEP 1: Generate 40 keywords ===
    updateStatus("Step 1/4", `"${seed}" ke liye keywords generate ho rahe hain...`, "", "", -1);

    const variations = generateVariations(seed).slice(0, MAX_KEYWORDS);
    let kwPreview = variations.slice(0, 10).map((v) => `"${v}"`).join(", ");
    if (variations.length > 10) kwPreview += `, ... +${variations.length - 10} more`;

    container.innerHTML = `<div style="margin-top:8px;">
      <p style="font-size:12px;color:#570A57;text-align:center;font-weight:700;">Step 1/4: ${variations.length} keywords ready</p>
      <p style="font-size:10px;color:#666;text-align:center;margin-top:4px;line-height:1.5;">${kwPreview}</p>
      <p style="font-size:10px;color:#888;text-align:center;margin-top:6px;">3 seconds mein search shuru hoga...</p>
    </div>`;
    await new Promise((r) => setTimeout(r, 3000));

    // === STEP 2: Search every keyword, scroll 10 pages, collect ALL products ===
    const allProducts = [];
    const seenIds = new Set();
    let accessDeniedCount = 0;
    let duplicateCount = 0;
    let irrelevantCount = 0;

    for (let i = 0; i < variations.length; i++) {
      const kw = variations[i];
      const searchUrl = "https://www.meesho.com/search?q=" + encodeURIComponent(kw);

      await chrome.tabs.update(tab.id, { url: searchUrl });
      await waitForPageLoad(tab.id);
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));

      // Check Access Denied
      try {
        const [pageCheck] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.title.includes("Access Denied") || document.body.innerText.includes("Access Denied"),
        });
        if (pageCheck.result) {
          accessDeniedCount++;
          updateStatus("Step 2/4", `Access Denied! ${20 * accessDeniedCount} sec wait...`, `Keyword: "${kw}" (${i + 1}/${variations.length})`, `Meesho ne block kiya, thoda wait karo`, -1);
          await new Promise((r) => setTimeout(r, 20000 * accessDeniedCount));
          await chrome.tabs.update(tab.id, { url: searchUrl });
          await waitForPageLoad(tab.id);
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          accessDeniedCount = 0;
        }
      } catch {}

      // Scroll 10 pages to load ~200 products per keyword
      for (let page = 0; page < PAGES_PER_KEYWORD; page++) {
        const overallProgress = Math.round(((i * PAGES_PER_KEYWORD + page + 1) / (variations.length * PAGES_PER_KEYWORD)) * 100);
        updateStatus(
          "Step 2/4: Search & Collect",
          `Keyword "${kw}" (${i + 1}/${variations.length})`,
          `Page ${page + 1}/${PAGES_PER_KEYWORD} scroll kar raha hai...`,
          `Total ${allProducts.length} unique products collected`,
          overallProgress
        );

        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              // Scroll to absolute bottom to trigger infinite scroll
              window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            },
          });
        } catch {}
        // Wait 2.5 sec for Meesho to load new products after scroll
        await new Promise((r) => setTimeout(r, 2500));
      }

      // Extract ALL products from page after scrolling
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractSearchProducts,
      });

      const products = result[0].result || [];
      let newCount = 0;
      let kwDupes = 0;
      let kwIrrelevant = 0;
      const seedWords = seed.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      products.forEach((p) => {
        p.searchKeyword = kw;
        const uniqueKey = p.productId || p.href || (p.name || "").toLowerCase();
        if (!uniqueKey) return;
        if (seenIds.has(uniqueKey)) { duplicateCount++; kwDupes++; return; }
        // Skip unrelated products (e.g. Meesho shows random items)
        const titleLower = (p.name || "").toLowerCase();
        if (seedWords.length > 0 && !seedWords.some((sw) => titleLower.includes(sw))) { irrelevantCount++; kwIrrelevant++; return; }
        seenIds.add(uniqueKey);
        allProducts.push(p);
        newCount++;
      });

      updateStatus(
        "Step 2/4: Search & Collect",
        `Keyword "${kw}" (${i + 1}/${variations.length}) done`,
        `+${newCount} new | ${kwDupes} duplicate | ${kwIrrelevant} unrelated skip`,
        `Total: ${allProducts.length} unique | ${duplicateCount} duplicates | ${irrelevantCount} unrelated`,
        Math.round(((i + 1) / variations.length) * 100)
      );
      await new Promise((r) => setTimeout(r, 300));
    }

    if (allProducts.length === 0) {
      container.innerHTML = '<p style="font-size:11px;color:#c62828;text-align:center;">Koi product nahi mila. Keyword change karo ya Meesho open karo pehle.</p>';
      btn.disabled = false;
      btn.textContent = "Generate";
      return;
    }

    // === STEP 3: Filter by Min Ratings, sort, pick top N ===
    const filtered = allProducts.filter((p) => (p.ratingCount || 0) >= MIN_RATINGS);

    if (filtered.length === 0) {
      // Show what we found so user can adjust
      allProducts.sort((a, b) => (b.ratingCount || 0) - (a.ratingCount || 0));
      const topRating = allProducts[0]?.ratingCount || 0;
      container.innerHTML = `<div style="text-align:center;margin-top:10px;">
        <p style="font-size:12px;color:#e65100;font-weight:700;">${allProducts.length} products mile, lekin kisi mein ${MIN_RATINGS}+ ratings nahi hai!</p>
        <p style="font-size:11px;color:#666;margin-top:6px;">Sabse zyada ratings: <strong>${topRating.toLocaleString()}</strong></p>
        <p style="font-size:11px;color:#570A57;font-weight:600;margin-top:8px;">Min Ratings kam karo (try: ${Math.max(10, Math.floor(topRating / 2))}) aur phir Generate karo.</p>
      </div>`;
      btn.disabled = false;
      btn.textContent = "Generate";
      return;
    }

    filtered.sort((a, b) => (b.ratingCount || 0) - (a.ratingCount || 0));
    const winners = filtered.slice(0, TOP_TO_VISIT);

    updateStatus(
      "Step 3/4: Filtering",
      `${allProducts.length} total | ${filtered.length} with ${MIN_RATINGS}+ ratings`,
      `Top ${winners.length} products select kiye | Highest: ${(winners[0]?.ratingCount || 0).toLocaleString()} ratings`,
      "",
      -1
    );
    await new Promise((r) => setTimeout(r, 2000));

    // === STEP 4: Visit top products to get FULL titles ===
    const productsToVisit = winners.filter((p) => (p.slug && p.productId) || p.href);
    let fullTitleCount = 0;

    for (let i = 0; i < productsToVisit.length; i++) {
      const p = productsToVisit[i];
      const productUrl = p.slug && p.productId
        ? `https://www.meesho.com/${p.slug}/p/${p.productId}`
        : p.href ? `https://www.meesho.com${p.href}` : null;
      if (!productUrl) continue;

      updateStatus(
        "Step 4/4: Full Title Extract",
        `Product ${i + 1}/${productsToVisit.length} open kar raha hai...`,
        `${fullTitleCount} full titles extracted | Current: ${(p.ratingCount || 0).toLocaleString()} ratings`,
        `"${(p.name || "").substring(0, 50)}..."`,
        Math.round(((i + 1) / productsToVisit.length) * 100)
      );

      try {
        await chrome.tabs.update(tab.id, { url: productUrl });
        await waitForPageLoad(tab.id);
        // Wait 3-5 sec for Meesho to FULLY render product data (not just HTML shell)
        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));

        // Check current page URL
        const [urlCheck] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.location.href,
        });
        const currentUrl = urlCheck.result || "";

        // Check Access Denied
        if (currentUrl.includes("Access Denied") || currentUrl.includes("error")) {
          updateStatus("Step 4/4", `Access Denied! 20 sec wait...`, `Product ${i + 1}/${productsToVisit.length}`, "", -1);
          await new Promise((r) => setTimeout(r, 20000));
          await chrome.tabs.update(tab.id, { url: productUrl });
          await waitForPageLoad(tab.id);
          await new Promise((r) => setTimeout(r, 4000));
        }

        const [adCheck] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.title.includes("Access Denied") || document.body.innerText.substring(0, 200).includes("Access Denied"),
        });
        if (adCheck.result) {
          updateStatus("Step 4/4", `Access Denied! 20 sec wait...`, `Product ${i + 1}/${productsToVisit.length}`, "", -1);
          await new Promise((r) => setTimeout(r, 20000));
          await chrome.tabs.update(tab.id, { url: productUrl });
          await waitForPageLoad(tab.id);
          await new Promise((r) => setTimeout(r, 4000));
        }

        // Wait for product title to actually appear on page before extracting
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            return new Promise((resolve) => {
              let tries = 0;
              const check = () => {
                tries++;
                // Check if product title is visible (og:title set OR h1 exists OR __NEXT_DATA__ has product)
                const og = document.querySelector('meta[property="og:title"]');
                const h1 = document.querySelector('h1');
                if ((og && og.content && og.content.length > 15) || (h1 && h1.textContent.length > 10) || tries > 10) {
                  resolve(true);
                } else {
                  setTimeout(check, 500);
                }
              };
              check();
            });
          },
        });

        const fullResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractFullProductTitle,
        });

        const fullData = fullResult[0].result;
        if (fullData && fullData.name && fullData.name.length > 10) {
          // Verify full title is same product (not stale data from previous page)
          const fullLower = fullData.name.toLowerCase();
          const seedWords2 = seed.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
          const isRelated = seedWords2.some((sw) => fullLower.includes(sw));
          if (!isRelated) continue; // Full title is for wrong product, skip

          const idx = winners.findIndex((w) => w.name === p.name || (w.productId && w.productId === p.productId));
          if (idx !== -1) {
            winners[idx].fullTitle = fullData.name;
            if (fullData.ratingCount > 0) winners[idx].ratingCount = fullData.ratingCount;
            if (fullData.price > 0) winners[idx].price = fullData.price;
            fullTitleCount++;
          }
        }
      } catch {}
    }

    // === BUILD RESULTS: Only CSV/TXT download + product list ===
    let html = '';

    // Summary
    html += `<div class="info-note note-green" style="margin:8px 0;text-align:center;">
      <strong>${variations.length}</strong> keywords searched | <strong>${allProducts.length}</strong> unique products<br>
      <strong>${duplicateCount}</strong> duplicates skipped | <strong>${irrelevantCount}</strong> unrelated skipped<br>
      <strong>${filtered.length}</strong> with ${MIN_RATINGS}+ ratings | <strong>${fullTitleCount}</strong> full titles extracted
    </div>`;

    // Download buttons
    html += `<div style="display:flex;gap:8px;margin:10px 0;">
      <button class="seo-btn" id="downloadWinnersCSV" style="flex:1;padding:10px;font-size:12px;">Download CSV</button>
      <button class="seo-btn-outline" id="downloadWinnersTXT" style="flex:1;padding:10px;font-size:12px;">Download TXT</button>
    </div>`;

    // Top Products list with full titles (scrollable)
    html += `<div class="seo-section-title" style="margin-top:10px;font-size:12px;">Top ${winners.length} Best Sellers (${MIN_RATINGS}+ ratings)</div>`;
    html += `<div style="max-height:400px;overflow-y:auto;border:1px solid #e0e0e0;border-radius:8px;padding:6px;">`;

    winners.forEach((p, i) => {
      const productUrl = p.slug && p.productId
        ? `https://www.meesho.com/${p.slug}/p/${p.productId}`
        : (p.href ? `https://www.meesho.com${p.href}` : "");
      const displayTitle = p.fullTitle || p.name || "Unknown";

      html += `<div class="competitor-card" style="margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:10px;color:#570A57;font-weight:800;">#${i + 1}</span>
          <span style="font-size:10px;color:#2e7d32;font-weight:700;">${(p.ratingCount || 0).toLocaleString()} ratings | Rs.${p.price || 0}</span>
        </div>
        <div style="font-size:11px;line-height:1.4;margin-top:4px;color:#333;">${escapeHtml(displayTitle)}</div>
        ${p.fullTitle ? '<span style="font-size:8px;color:#2e7d32;font-weight:600;">FULL TITLE</span>' : '<span style="font-size:8px;color:#e65100;">short title (search page se)</span>'}
        <div style="margin-top:4px;">
          ${productUrl ? `<a href="${productUrl}" target="_blank" style="font-size:10px;color:#570A57;text-decoration:none;font-weight:600;">Meesho pe dekho →</a>` : ""}
          <span style="font-size:9px;color:#888;margin-left:8px;">keyword: "${p.searchKeyword || seed}"</span>
        </div>
      </div>`;
    });

    html += `</div>`; // close scrollable container
    html += `<p style="font-size:10px;color:#aaa;margin-top:8px;text-align:center;">Ye sab top sellers hain jinke titles se aap apna product title optimize kar sakte ho</p>`;

    // Store winners data globally for download
    window._autoTitleWinners = winners;
    window._autoTitleSeed = seed;
    window._autoTitleStats = { keywords: variations.length, totalProducts: allProducts.length, filtered: filtered.length, fullTitles: fullTitleCount, minRatings: MIN_RATINGS };

    container.innerHTML = html;

    // Attach download handlers
    document.getElementById("downloadWinnersCSV").addEventListener("click", downloadWinnersCSV);
    document.getElementById("downloadWinnersTXT").addEventListener("click", downloadWinnersTXT);

  } catch (err) {
    container.innerHTML = `<p style="font-size:11px;color:#c62828;text-align:center;">Error: ${err.message}. Meesho.com open karo pehle.</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate";
  }
}

function downloadWinnersCSV() {
  const winners = window._autoTitleWinners || [];
  const seed = window._autoTitleSeed || "product";
  const stats = window._autoTitleStats || {};
  if (winners.length === 0) return;

  let csv = "Rank,Ratings,Price,Search Keyword,Full Title,Product URL\n";
  winners.forEach((p, i) => {
    const title = (p.fullTitle || p.name || "").replace(/"/g, '""');
    const url = p.slug && p.productId
      ? `https://www.meesho.com/${p.slug}/p/${p.productId}`
      : (p.href ? `https://www.meesho.com${p.href}` : "");
    csv += `${i + 1},${p.ratingCount || 0},${p.price || 0},"${p.searchKeyword || seed}","${title}","${url}"\n`;
  });

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `meesho-top-sellers-${seed.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("CSV downloaded!");
}

function downloadWinnersTXT() {
  const winners = window._autoTitleWinners || [];
  const seed = window._autoTitleSeed || "product";
  const stats = window._autoTitleStats || {};
  if (winners.length === 0) return;

  let txt = `Meesho Top Sellers Analysis - "${seed}"\n`;
  txt += `Date: ${new Date().toLocaleDateString()}\n`;
  txt += `Keywords searched: ${stats.keywords} | Products scanned: ${stats.totalProducts}\n`;
  txt += `Products with ${stats.minRatings}+ ratings: ${stats.filtered} | Full titles extracted: ${stats.fullTitles}\n`;
  txt += `${"=".repeat(80)}\n\n`;

  winners.forEach((p, i) => {
    const title = p.fullTitle || p.name || "Unknown";
    const url = p.slug && p.productId
      ? `https://www.meesho.com/${p.slug}/p/${p.productId}`
      : (p.href ? `https://www.meesho.com${p.href}` : "N/A");
    txt += `#${i + 1} | ${(p.ratingCount || 0).toLocaleString()} ratings | Rs.${p.price || 0}\n`;
    txt += `Title: ${title}\n`;
    txt += `Keyword: ${p.searchKeyword || seed}\n`;
    txt += `URL: ${url}\n`;
    txt += `${"-".repeat(60)}\n`;
  });

  // Extract all unique words from full titles for keyword reference
  const stopWords = new Set(["for", "and", "the", "with", "set", "of", "in", "a", "an", "to", "is", "on", "at", "by", "or", "&", "-", "|", "/", "free", "delivery", "pack", "1", "2", "3"]);
  const wordFreq = {};
  winners.forEach((p) => {
    const title = (p.fullTitle || p.name || "").toLowerCase();
    title.split(/[\s,\-|()\/]+/).filter((w) => w.length > 2 && !stopWords.has(w)).forEach((w) => {
      wordFreq[w] = (wordFreq[w] || 0) + 1;
    });
  });
  const sortedWords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]);

  txt += `\n${"=".repeat(80)}\n`;
  txt += `WINNING KEYWORDS (from top sellers' titles)\n`;
  txt += `${"=".repeat(80)}\n`;
  sortedWords.slice(0, 30).forEach(([word, count]) => {
    txt += `${word} (${count}x used)\n`;
  });

  const blob = new Blob([txt], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `meesho-top-sellers-${seed.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("TXT downloaded!");
}

function generateVariations(seed) {
  const seedLower = seed.toLowerCase();
  const seedWords = seedLower.split(/\s+/);
  const variations = new Set([seed]);

  // === AUDIENCE modifiers ===
  const audiences = ["for women", "for men", "for girls", "for boys", "for kids", "for ladies", "unisex"];

  // === PRICE modifiers ===
  const prices = ["under 500", "under 300", "under 200", "under 1000", "under 100", "low price", "cheap"];

  // === PACK/QUANTITY modifiers ===
  const packs = ["combo", "combo pack", "set", "set of 2", "pack of 2", "pack of 3", "pack of 5", "pair"];

  // === STYLE/TREND modifiers ===
  const styles = ["stylish", "latest", "trendy", "new", "designer", "branded", "premium", "fancy", "traditional", "modern", "classic", "luxury"];

  // === MATERIAL modifiers (category-aware) ===
  const materials = ["cotton", "silk", "printed", "embroidered", "rayon", "polyester", "georgette", "chiffon", "leather", "steel", "wooden", "plastic", "metal"];

  // === OCCASION modifiers ===
  const occasions = ["party wear", "casual", "daily use", "office", "wedding", "festive", "summer", "winter", "formal", "sports"];

  // === FEATURE modifiers (electronics/gadgets) ===
  const features = ["mini", "portable", "rechargeable", "wireless", "USB", "Bluetooth", "waterproof", "adjustable", "foldable"];

  // === SIZE modifiers ===
  const sizes = ["large", "small", "xl", "free size", "medium", "big"];

  // === BUYING INTENT modifiers ===
  const intents = ["best", "top rated", "most selling", "new arrival", "offer", "discount", "wholesale", "bulk"];

  // Detect category to choose relevant modifiers
  const isClothing = /(kurti|saree|lehenga|dress|shirt|top|jeans|t-shirt|kurta|suit|frock|gown|blouse|pant|palazzo)/i.test(seedLower);
  const isElectronics = /(fan|earphone|headphone|charger|cable|light|lamp|speaker|watch|trimmer|shaver|iron|blender|mixer)/i.test(seedLower);
  const isAccessory = /(ring|necklace|earring|bracelet|bangle|chain|pendant|watch|bag|purse|wallet|belt|cap|hat|sunglasses|shoe|sandal|slipper)/i.test(seedLower);
  const isHome = /(bedsheet|curtain|pillow|towel|mat|organizer|container|bottle|mug|cup|plate|kitchen|decor|rack|shelf)/i.test(seedLower);

  // Build modifier list based on category
  const allModifiers = [];

  // Audience modifiers ONLY for clothing/accessories (not electronics/home)
  const isGenderRelevant = isClothing || isAccessory;
  if (isGenderRelevant) {
    allModifiers.push(...audiences);
  }

  allModifiers.push(...prices);
  allModifiers.push(...packs);
  allModifiers.push(...styles);
  allModifiers.push(...intents);

  if (isClothing) {
    allModifiers.push(...materials.filter((m) => ["cotton", "silk", "rayon", "georgette", "chiffon", "printed", "embroidered"].includes(m)));
    allModifiers.push(...occasions);
    allModifiers.push(...sizes);
  } else if (isElectronics) {
    allModifiers.push(...features);
    // Electronics-specific: USE CASE based keywords instead of audience
    allModifiers.push(...["home", "office", "travel", "outdoor", "car", "desk", "table", "wall mount", "ceiling", "standing"]);
    allModifiers.push(...["high speed", "low noise", "silent", "powerful", "3 speed", "5 speed"]);
    allModifiers.push(...["with light", "with stand", "with clip", "with battery", "with charger"]);
    allModifiers.push(...sizes);
  } else if (isAccessory) {
    allModifiers.push(...materials.filter((m) => ["leather", "steel", "metal", "wooden", "plastic"].includes(m)));
    allModifiers.push(...occasions.filter((m) => ["party wear", "daily use", "wedding", "festive", "casual"].includes(m)));
    allModifiers.push(...sizes);
  } else if (isHome) {
    allModifiers.push(...materials.filter((m) => ["cotton", "polyester", "steel", "plastic", "wooden"].includes(m)));
    allModifiers.push(...sizes);
    allModifiers.push(...["kitchen", "bedroom", "bathroom", "living room", "balcony", "outdoor"]);
  } else {
    // Generic - add a bit of everything but NO audiences
    allModifiers.push(...materials.slice(0, 5));
    allModifiers.push(...occasions.slice(0, 4));
    allModifiers.push(...features.slice(0, 4));
    allModifiers.push(...sizes.slice(0, 3));
  }

  // === LEVEL 1: seed + single modifier (e.g. "trimmer for men") ===
  allModifiers.forEach((mod) => variations.add(seed + " " + mod));

  // === LEVEL 2: modifier + seed (e.g. "best trimmer") ===
  const prefixes = ["best", "stylish", "cotton", "printed", "mini", "portable", "latest", "trendy", "top", "new", "cheap", "premium", "branded", "original"];
  prefixes.forEach((mod) => variations.add(mod + " " + seed));

  // === LEVEL 3: Cross combos based on category ===
  const topPrices = ["under 500", "under 300", "under 200", "under 1000"];

  if (isGenderRelevant) {
    // Clothing/Accessories: audience + price combos make sense
    const topAudiences = ["for women", "for men", "for girls", "for boys", "for kids"];
    topAudiences.forEach((aud) => {
      topPrices.forEach((price) => {
        variations.add(seed + " " + aud + " " + price);
      });
    });

    // === LEVEL 4: seed + audience + material ===
    if (isClothing) {
      ["women", "men", "girls"].forEach((aud) => {
        ["cotton", "silk", "printed", "embroidered", "rayon", "georgette"].forEach((mat) => {
          variations.add(seed + " " + mat + " for " + aud);
        });
      });
      ["party wear", "casual", "wedding", "office", "daily use"].forEach((occ) => {
        ["women", "men"].forEach((aud) => {
          variations.add(seed + " " + occ + " for " + aud);
        });
      });
    } else if (isAccessory) {
      ["women", "men", "girls"].forEach((aud) => {
        ["leather", "steel", "metal", "premium", "stylish"].forEach((mat) => {
          variations.add(seed + " " + mat + " for " + aud);
        });
      });
    }

    // LEVEL 6: intent + audience
    ["best", "top rated", "most selling", "new arrival"].forEach((intent) => {
      ["for women", "for men", "for girls"].forEach((aud) => {
        variations.add(intent + " " + seed + " " + aud);
      });
    });
  } else {
    // Electronics/Home/Generic: USE CASE + price combos (no gender)
    const useCases = isElectronics
      ? ["home", "office", "travel", "outdoor", "car", "desk", "kitchen", "bedroom"]
      : isHome
      ? ["kitchen", "bedroom", "bathroom", "living room", "balcony"]
      : ["home", "office", "outdoor", "travel", "daily use"];

    useCases.forEach((place) => {
      variations.add(seed + " for " + place);
      topPrices.slice(0, 2).forEach((price) => {
        variations.add(seed + " for " + place + " " + price);
      });
    });

    // Electronics: feature + use case combos
    if (isElectronics) {
      ["USB", "rechargeable", "wireless", "portable", "mini"].forEach((feat) => {
        useCases.slice(0, 4).forEach((place) => {
          variations.add(seed + " " + feat + " " + place);
        });
      });
      // Speed/power variants
      ["high speed", "silent", "powerful", "3 speed"].forEach((spec) => {
        variations.add(seed + " " + spec);
      });
    }

    // Home: material + room combos
    if (isHome) {
      ["cotton", "steel", "plastic", "wooden"].forEach((mat) => {
        useCases.slice(0, 3).forEach((room) => {
          variations.add(seed + " " + mat + " " + room);
        });
      });
    }

    // Intent combos (no audience)
    ["best", "top rated", "most selling", "new arrival"].forEach((intent) => {
      variations.add(intent + " " + seed);
      useCases.slice(0, 3).forEach((place) => {
        variations.add(intent + " " + seed + " " + place);
      });
    });
  }

  // === LEVEL 5: seed + style + pack ===
  ["combo", "set of 2", "pack of 2", "pack of 3"].forEach((pack) => {
    ["stylish", "premium", "best", "latest"].forEach((style) => {
      variations.add(seed + " " + pack + " " + style);
    });
  });

  // Individual seed words as standalone searches (if multi-word seed)
  if (seedWords.length >= 2) {
    seedWords.forEach((w) => {
      if (w.length > 3) variations.add(w);
    });
    // Reverse seed word order
    variations.add(seedWords.slice().reverse().join(" "));
  }

  // Return max 100 (seller should not go beyond this)
  return [...variations].slice(0, 100);
}

function capitalize(str) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- Trending Keywords from Meesho Homepage ---
async function fetchTrending() {
  const btn = document.getElementById("trendingBtn");
  const container = document.getElementById("trendingResults");
  btn.disabled = true;
  btn.textContent = "Loading...";
  container.innerHTML = '<p style="font-size:11px;color:#888;text-align:center;margin-top:8px;">Going to Meesho homepage...</p>';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Navigate to Meesho homepage
    await chrome.tabs.update(tab.id, { url: "https://www.meesho.com/" });
    await waitForPageLoad(tab.id);
    // Scroll to load categories
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollTo(0, 800) }); } catch {}
    await new Promise((r) => setTimeout(r, 2000));

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeTrendingFromHomepage,
    });

    const trending = result[0].result || { categories: [], keywords: [] };

    let html = '';

    if (trending.categories.length > 0) {
      html += '<div class="seo-section-title" style="margin-top:8px;font-size:11px;">Trending Categories</div>';
      html += '<div class="keyword-cloud">';
      trending.categories.forEach((cat, i) => {
        const colors = ["tag-purple", "tag-blue", "tag-green", "tag-orange"];
        html += `<span class="keyword-tag ${colors[i % 4]}" onclick="copyKeyword(this)" title="Click to copy">${escapeHtml(cat)}</span>`;
      });
      html += '</div>';
    }

    if (trending.keywords.length > 0) {
      html += '<div class="seo-section-title" style="margin-top:10px;font-size:11px;">Popular Search Keywords</div>';
      html += '<div class="keyword-cloud">';
      trending.keywords.forEach((kw, i) => {
        const colors = ["tag-green", "tag-orange", "tag-purple", "tag-blue"];
        html += `<span class="keyword-tag ${colors[i % 4]}" onclick="copyKeyword(this)" title="Click to copy">${escapeHtml(kw)}</span>`;
      });
      html += '</div>';
    }

    if (!html) {
      html = '<p style="font-size:11px;color:#888;text-align:center;margin-top:8px;">Could not find trending data. Try reloading Meesho homepage.</p>';
    }

    html += '<p style="font-size:9px;color:#aaa;margin-top:8px;text-align:center;">Source: Meesho homepage categories & navigation</p>';
    container.innerHTML = html;

  } catch (err) {
    container.innerHTML = `<p style="font-size:11px;color:#c62828;text-align:center;margin-top:8px;">Error: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Show Trending Categories & Keywords";
  }
}

// Runs in page context - scrapes trending data from Meesho homepage
function scrapeTrendingFromHomepage() {
  const categories = [];
  const keywords = [];
  const seen = new Set();

  // Scrape navigation categories
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute("href") || "";
    const text = a.textContent.trim();
    // Category links like /women-western, /kurti-saree, etc.
    if (href.match(/^\/[a-z\-]+$/) && text.length > 2 && text.length < 40 && !text.match(/^(Home|Profile|Cart|Login|Sign|Help|About|Contact|Download|Become|Investor|Popular|Smart|Cash|Lowest|Budget|Trending|Original)/i)) {
      const clean = text.replace(/\s+/g, " ").trim();
      if (!seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        categories.push(clean);
      }
    }
  });

  // Filter out non-product generic words
  const junkWords = /^(smart shopping|cash on delivery|lowest prices?|free delivery|easy return|7 days|original brands?|popular brands?|trending now|budget buys?|download|app|play store|app store|customer|support|help|about|privacy|terms|copyright|all rights|mallbadge|badge|star|icon|clock|offer.*icon|top rated|daily essential|verified|trusted|secure|payment|refund|return policy|sell on|become a|supplier|invite)/i;

  // Scrape banner/card text for trending items
  document.querySelectorAll('img[alt]').forEach((img) => {
    const alt = img.getAttribute("alt") || "";
    if (alt.length > 5 && alt.length < 50 && !alt.match(/^(logo|icon|banner|meesho|image|img|photo|badge|star|arrow|close|menu|search|cart|profile|check|tick|cross|offer|clock|play|google|apple|facebook|instagram|twitter)/i) && !junkWords.test(alt) && !alt.match(/icon$/i)) {
      const clean = alt.replace(/\s+/g, " ").trim();
      if (!seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        keywords.push(clean);
      }
    }
  });

  // Scrape visible text blocks that look like category/keyword headings
  document.querySelectorAll('h2, h3, h4, [class*="heading"], [class*="title"]').forEach((el) => {
    const text = el.textContent.trim();
    if (text.length > 3 && text.length < 50 && !text.match(/^(Meesho|Download|Sign|Login|Become)/i) && !junkWords.test(text)) {
      if (!seen.has(text.toLowerCase())) {
        seen.add(text.toLowerCase());
        keywords.push(text);
      }
    }
  });

  // Also scrape from placeholder/search suggestions
  const searchInput = document.querySelector('input[placeholder*="Search"], input[placeholder*="Saree"]');
  if (searchInput) {
    const placeholder = searchInput.getAttribute("placeholder") || "";
    const matches = placeholder.match(/(?:Try\s+)?(.+)/i);
    if (matches) {
      matches[1].split(/[,|]/).forEach((w) => {
        const clean = w.trim();
        if (clean.length > 2 && !seen.has(clean.toLowerCase())) {
          seen.add(clean.toLowerCase());
          keywords.push(clean);
        }
      });
    }
  }

  return { categories: categories.slice(0, 20), keywords: keywords.slice(0, 20) };
}

// --- Keyword Research (Meesho Autocomplete + Demand Data) ---
async function fetchAutocomplete() {
  const keyword = document.getElementById("keywordInput").value.trim();
  if (!keyword) return;

  const btn = document.getElementById("keywordSearchBtn");
  const container = document.getElementById("autocompleteResults");
  btn.disabled = true;
  btn.textContent = "Searching...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Step 1: Generate keyword variations (same as Auto Title Generator - reliable)
    const analyzeCount = parseInt(document.getElementById("kwAnalyzeCount").value) || 15;
    const allVariations = generateVariations(keyword);
    const keywordsToAnalyze = allVariations.slice(0, analyzeCount);
    cachedKeywords = allVariations; // Store all for keyword cloud

    // Show keywords immediately
    container.innerHTML = renderKeywordResults(cachedKeywords, null);
    container.innerHTML += `<p id="demandStatus" style="font-size:11px;color:#570A57;text-align:center;margin-top:8px;font-weight:600;">Analyzing demand for ${keywordsToAnalyze.length} keywords...</p>
      <div class="progress-bar" style="margin-top:6px;"><div class="progress-fill" id="demandProgress" style="width:0%"></div></div>`;

    // Step 2: Visit each keyword's search page, use extractSearchProducts for real data
    const demandData = [];

    for (let i = 0; i < keywordsToAnalyze.length; i++) {
      const kw = keywordsToAnalyze[i];
      const statusEl = document.getElementById("demandStatus");
      const progressEl = document.getElementById("demandProgress");
      if (statusEl) statusEl.textContent = `Analyzing ${i + 1}/${keywordsToAnalyze.length}: "${kw}"...`;
      if (progressEl) progressEl.style.width = `${Math.round(((i + 1) / keywordsToAnalyze.length) * 100)}%`;

      const searchUrl = "https://www.meesho.com/search?q=" + encodeURIComponent(kw);
      await chrome.tabs.update(tab.id, { url: searchUrl });
      await waitForPageLoad(tab.id);
      // Wait for products to load first
      await new Promise((r) => setTimeout(r, 3000));
      // Then scroll to load more products
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }) });
      } catch {}
      // Wait for scrolled products to load
      await new Promise((r) => setTimeout(r, 2500));

      // Use extractSearchProducts - same function that works in Auto Title Generator
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractSearchProducts,
      });

      const products = result[0].result || [];
      // Filter relevant products only
      const seedWords = keyword.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const relevant = products.filter((p) => {
        const titleLower = (p.name || "").toLowerCase();
        return seedWords.some((sw) => titleLower.includes(sw));
      });

      const prices = relevant.map((p) => p.price).filter((p) => p > 0);
      const ratings = relevant.map((p) => p.ratingCount || 0).filter((r) => r > 0).sort((a, b) => b - a);
      const topRating = ratings[0] || 0;
      const totalRatingsTop5 = ratings.slice(0, 5).reduce((a, b) => a + b, 0);
      const avgPrice = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;

      demandData.push({
        keyword: kw,
        totalProducts: relevant.length,
        avgRatings: topRating,
        topProductRatings: totalRatingsTop5,
        avgPrice,
        demandScore: 0,
      });

      await new Promise((r) => setTimeout(r, 500));
    }

    // Calculate demand score (0-100)
    const maxRatings = Math.max(...demandData.map((d) => d.topProductRatings), 1);
    const maxProducts = Math.max(...demandData.map((d) => d.totalProducts), 1);
    demandData.forEach((d) => {
      const demandFromRatings = (d.topProductRatings / maxRatings) * 60;
      const productBonus = Math.min(d.totalProducts / 10, 1) * 20; // More products = more demand
      const ratingBonus = Math.min(d.avgRatings / 1000, 1) * 20;
      d.demandScore = Math.round(Math.min(demandFromRatings + productBonus + ratingBonus, 100));
      d.demandScore = Math.max(d.demandScore, 5);
    });

    demandData.sort((a, b) => b.demandScore - a.demandScore);

    // Re-render with demand data
    container.innerHTML = renderKeywordResults(cachedKeywords, demandData);

  } catch (err) {
    container.innerHTML = `<p style="font-size:11px;color:#c62828;text-align:center;">Error: ${err.message}. Meesho.com open karo pehle.</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Search";
  }
}

function renderKeywordResults(keywords, demandData) {
  let html = '';

  // Demand table (if available)
  if (demandData && demandData.length > 0) {
    html += '<div class="seo-section-title" style="font-size:11px;margin-bottom:4px;">Keyword Demand Analysis</div>';
    html += '<p style="font-size:10px;color:#888;margin-bottom:6px;">Real Meesho search data - products found, top seller ratings, avg price</p>';
    html += '<table class="keyword-table"><tr><th>Keyword</th><th>Demand</th><th>Products</th><th>#1 Seller Ratings</th><th>Avg Price</th></tr>';
    demandData.forEach((d) => {
      let demandColor, demandLabel;
      if (d.demandScore >= 70) { demandColor = "#2e7d32"; demandLabel = "HIGH"; }
      else if (d.demandScore >= 40) { demandColor = "#e65100"; demandLabel = "MED"; }
      else { demandColor = "#c62828"; demandLabel = "LOW"; }

      html += `<tr>
        <td><strong>${escapeHtml(d.keyword)}</strong></td>
        <td><span style="color:${demandColor};font-weight:800;">${d.demandScore}</span> <span style="font-size:9px;color:${demandColor}">${demandLabel}</span></td>
        <td>${d.totalProducts.toLocaleString()}</td>
        <td>${d.avgRatings.toLocaleString()}</td>
        <td>Rs.${d.avgPrice}</td>
      </tr>`;
    });
    html += '</table>';

    html += '<p style="font-size:9px;color:#aaa;margin-top:4px;">Demand Score: Higher = more buyers searching. Based on top product ratings (sales proxy) and competition level.</p>';
    html += '<div style="height:8px"></div>';
  }

  // Keyword cloud (scrollable)
  html += `<div class="seo-section-title" style="font-size:11px;">All Keywords (${keywords.length})</div>`;
  html += '<div class="keyword-cloud" style="max-height:200px;overflow-y:auto;border:1px solid #e0e0e0;border-radius:8px;padding:8px;">';
  const tagColors = ["tag-purple", "tag-blue", "tag-green", "tag-orange"];
  keywords.forEach((kw, i) => {
    const color = tagColors[i % tagColors.length];
    html += `<span class="keyword-tag ${color}" onclick="copyKeyword(this)" title="Click to copy">${escapeHtml(kw)}</span>`;
  });
  html += '</div>';
  html += `<p style="font-size:10px;color:#aaa;margin-top:8px;text-align:center;">${keywords.length} keywords found | Click to copy</p>`;
  html += `<button class="seo-btn-outline" style="width:100%;margin-top:8px;padding:7px" onclick="copyAllKeywords()">Copy All Keywords</button>`;

  return html;
}

// This runs inside the Meesho page context - tries multiple API endpoints
function fetchMeeshoSuggestions(keyword) {
  const endpoints = [
    "https://www.meesho.com/api/v1/products/search_suggestions?q=" + encodeURIComponent(keyword),
    "https://www.meesho.com/api/v1/search/suggestions?q=" + encodeURIComponent(keyword),
    "https://www.meesho.com/api/v2/search/suggestions?q=" + encodeURIComponent(keyword),
  ];

  // Try suggestion APIs one by one
  function tryEndpoint(index) {
    if (index >= endpoints.length) return Promise.resolve(null);
    return fetch(endpoints[index], { headers: { "Accept": "application/json" } })
      .then((r) => {
        if (!r.ok) throw new Error("not ok");
        return r.json();
      })
      .then((data) => {
        // Extract suggestions from various response shapes
        const suggestions = data.suggestions || data.data?.suggestions || data.result?.suggestions || [];
        if (Array.isArray(suggestions) && suggestions.length > 0) return suggestions;
        if (Array.isArray(data) && data.length > 0) return data;
        throw new Error("empty");
      })
      .catch(() => tryEndpoint(index + 1));
  }

  return tryEndpoint(0).then((suggestions) => {
    if (suggestions && suggestions.length > 0) return suggestions;

    // Fallback: extract keywords from __NEXT_DATA__ on current search page
    // or fetch the search page and extract product names
    const el = document.querySelector("#__NEXT_DATA__");
    if (el) {
      try {
        const json = JSON.parse(el.textContent);
        // Try to find search suggestions in page data
        const pageState = json.props?.pageProps?.initialState || {};

        // Check for trending/popular searches in page data
        const trending = pageState.trending?.data || pageState.popularSearches?.data || [];
        if (trending.length > 0) {
          return trending.slice(0, 15).map((t) => ({ keyword: t.name || t.keyword || t }));
        }
      } catch {}
    }

    // Return null so the caller knows to try the search page scraping fallback
    return null;
  });
}

// Runs in page context - scrapes product data from rendered DOM
function extractKeywordsFromSearch(seedKeyword) {
  // Scrape visible product cards from the page
  const titles = [];
  // Try multiple selectors that Meesho uses for product cards
  const selectors = [
    '[data-testid="product-card"] p', '[class*="ProductTitle"]',
    '[class*="product"] [class*="name"]', '[class*="product"] [class*="title"]',
    '[class*="Card"] p:first-child', 'a[href*="/p/"] p',
    'div[class*="sc-"] p'
  ];

  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach((el) => {
      const text = el.textContent.trim();
      if (text.length > 10 && text.length < 300) titles.push(text);
    });
    if (titles.length > 5) break;
  }

  // Fallback: get all text from product-like elements
  if (titles.length === 0) {
    document.querySelectorAll('a[href*="/p/"]').forEach((a) => {
      const text = a.textContent.trim().split('\n')[0].trim();
      if (text.length > 10 && text.length < 300 && !text.match(/^\d/)) titles.push(text);
    });
  }

  if (titles.length === 0) return [];

  const seed = seedKeyword.toLowerCase();
  const phraseCount = {};
  const wordCount = {};
  const stopWords = new Set([
    "for", "and", "the", "with", "of", "in", "a", "an", "to", "is",
    "on", "at", "by", "or", "&", "-", "|", "/", "free", "shipping",
    "best", "top", "quality", "brand", "original", "genuine", "buy"
  ]);

  titles.forEach((title) => {
    const words = title.toLowerCase().split(/[\s,\-|()\/]+/).filter((w) => w.length > 2 && !stopWords.has(w));
    words.forEach((w) => { wordCount[w] = (wordCount[w] || 0) + 1; });
    for (let i = 0; i < words.length - 1; i++) {
      const phrase = words[i] + " " + words[i + 1];
      phraseCount[phrase] = (phraseCount[phrase] || 0) + 1;
    }
  });

  const keywords = [{ keyword: seedKeyword }];

  Object.entries(phraseCount).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .forEach(([phrase]) => keywords.push({ keyword: phrase }));

  Object.entries(wordCount).filter(([w]) => w !== seed && w.length > 2).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([word]) => {
      const combo = seed + " " + word;
      if (!keywords.find((k) => k.keyword === combo)) keywords.push({ keyword: combo });
    });

  return keywords.slice(0, 20);
}

// Runs in page context - extracts demand signals by scraping rendered DOM
function extractDemandSignals() {
  const text = document.body.innerText || "";

  // Total products count
  const totalMatch = text.match(/([\d,]+)\s*Products?\b/i) || text.match(/Showing.*?([\d,]+)/i);
  const totalProducts = totalMatch ? parseInt(totalMatch[1].replace(/,/g, "")) : 0;

  // Scrape prices from visible product cards
  const prices = [];
  document.querySelectorAll('span, p').forEach((el) => {
    const t = el.textContent.trim();
    const priceMatch = t.match(/^[\u20B9Rs.]*\s*(\d{2,6})$/);
    if (priceMatch && !el.closest('strike') && !el.querySelector('strike')) {
      prices.push(parseInt(priceMatch[1]));
    }
  });

  // Scrape ratings
  const ratings = [];
  document.querySelectorAll('span, p, div').forEach((el) => {
    const t = el.textContent.trim();
    // Match patterns like "4.2 ★" or "4.2★" or rating numbers
    const ratingMatch = t.match(/^([\d.]+)\s*[\u2605\u2B50]/);
    if (ratingMatch) {
      const r = parseFloat(ratingMatch[1]);
      if (r > 0 && r <= 5) ratings.push(r);
    }
    // Match review/rating counts like "1,234 Reviews" or "5.6k Ratings"
    const countMatch = t.match(/([\d,.]+[kK]?)\s*(Reviews?|Ratings?)/i);
    if (countMatch) {
      let num = countMatch[1].replace(/,/g, "");
      if (num.match(/[kK]$/)) num = parseFloat(num) * 1000;
      else num = parseInt(num);
      if (num > 0) ratings.push(num);
    }
  });

  // Calculate signals
  const topProductRatings = ratings.slice(0, 6).reduce((a, b) => a + b, 0);
  const avgPrice = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
  const avgRatings = ratings.length > 0 ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length) : 0;

  return {
    totalProducts: totalProducts || prices.length,
    avgRatings,
    topProductRatings: Math.round(topProductRatings),
    avgPrice,
  };
}

function copyKeyword(el) {
  navigator.clipboard.writeText(el.textContent);
  showToast("Copied: " + el.textContent);
}

function copyAllKeywords() {
  if (cachedKeywords.length > 0) {
    navigator.clipboard.writeText(cachedKeywords.join(", "));
    showToast("All " + cachedKeywords.length + " keywords copied!");
  }
}

// --- Competitor Keyword Analysis ---
async function analyzeCompetitors() {
  const keyword = document.getElementById("competitorInput").value.trim();
  if (!keyword) return;

  const btn = document.getElementById("competitorBtn");
  const container = document.getElementById("competitorResults");
  btn.disabled = true;
  btn.textContent = "Analyzing...";
  container.innerHTML = '<p style="font-size:11px;color:#888;text-align:center;">Fetching top products...</p>';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Navigate to search page and extract product data
    const searchUrl = "https://www.meesho.com/search?q=" + encodeURIComponent(keyword);
    await chrome.tabs.update(tab.id, { url: searchUrl });
    await waitForPageLoad(tab.id);
    // Scroll to load products
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollTo(0, 1500) }); } catch {}
    await new Promise((r) => setTimeout(r, 2500));

    // Extract products from search results
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractSearchProducts,
    });

    const products = result[0].result || [];
    if (products.length === 0) {
      container.innerHTML = '<p style="font-size:11px;color:#c62828;text-align:center;">No products found for this keyword.</p>';
      return;
    }

    // Analyze keywords from top product titles
    const stopWords = new Set([
      "for", "and", "the", "with", "set", "of", "in", "a", "an", "to",
      "is", "on", "at", "by", "or", "no", "not", "all", "but", "so",
      "up", "out", "if", "its", "&", "-", "|", "/", "men", "women",
      "pack", "combo", "pcs", "pc", "free", "size", "new"
    ]);

    const wordFreq = {};
    const bigramFreq = {};
    const titles = [];

    products.forEach((p) => {
      const title = (p.name || "").toLowerCase().trim();
      titles.push({ name: p.name, price: p.price, rating: p.rating, ratings: p.ratingCount });

      const words = title.split(/[\s,\-|()\/]+/).filter((w) => w.length > 1);

      words.forEach((w) => {
        if (!stopWords.has(w) && w.length > 2) {
          wordFreq[w] = (wordFreq[w] || 0) + 1;
        }
      });

      // Bigrams (2-word phrases)
      for (let i = 0; i < words.length - 1; i++) {
        if (!stopWords.has(words[i]) && !stopWords.has(words[i + 1])) {
          const bigram = words[i] + " " + words[i + 1];
          bigramFreq[bigram] = (bigramFreq[bigram] || 0) + 1;
        }
      }
    });

    const topWords = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    const topBigrams = Object.entries(bigramFreq)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    // Build results HTML
    let html = '';

    // === PRICE STRATEGY ===
    const pricesArr = titles.map((t) => t.price).filter((p) => p > 0).sort((a, b) => a - b);
    if (pricesArr.length > 0) {
      const minPrice = pricesArr[0];
      const maxPrice = pricesArr[pricesArr.length - 1];
      const avgPrice = Math.round(pricesArr.reduce((a, b) => a + b, 0) / pricesArr.length);
      // Sweet spot = slightly below average (where most sales happen)
      const sweetSpot = Math.round(avgPrice * 0.85);
      // Top 3 products' prices
      const top3Prices = titles.slice(0, 3).filter((t) => t.price > 0);

      html += '<div class="seo-section-title" style="margin-top:6px;font-size:11px;">Price Strategy</div>';
      html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;text-align:center;margin-bottom:8px;">';
      html += `<div class="stat"><div class="stat-val" style="font-size:13px;color:#2e7d32;">Rs.${sweetSpot}</div><div class="stat-label">Sweet Spot</div></div>`;
      html += `<div class="stat"><div class="stat-val" style="font-size:13px;">Rs.${minPrice}</div><div class="stat-label">Lowest</div></div>`;
      html += `<div class="stat"><div class="stat-val" style="font-size:13px;">Rs.${avgPrice}</div><div class="stat-label">Average</div></div>`;
      html += `<div class="stat"><div class="stat-val" style="font-size:13px;">Rs.${maxPrice}</div><div class="stat-label">Highest</div></div>`;
      html += '</div>';

      if (top3Prices.length > 0) {
        html += '<p style="font-size:10px;color:#2e7d32;font-weight:600;margin-bottom:4px;">Top 3 Products Prices:</p>';
        top3Prices.forEach((t, i) => {
          html += `<p style="font-size:10px;color:#666;margin:2px 0;">#${i + 1} Rs.${t.price} - ${t.ratings > 0 ? t.ratings.toLocaleString() + " ratings" : "New"}</p>`;
        });
        html += `<p style="font-size:10px;color:#570A57;font-weight:700;margin-top:6px;">Suggestion: Price your product around Rs.${sweetSpot}-${avgPrice} to be competitive</p>`;
      }
    }

    // Top keyword phrases
    if (topBigrams.length > 0) {
      html += '<div class="seo-section-title" style="margin-top:10px;font-size:11px;">Top Keyword Phrases</div>';
      html += '<div class="keyword-cloud">';
      topBigrams.forEach(([phrase, count]) => {
        html += `<span class="keyword-tag tag-purple" onclick="copyKeyword(this)" title="${count}x used - Click to copy">${escapeHtml(phrase)} (${count}x)</span>`;
      });
      html += '</div>';
    }

    // Top single keywords
    html += '<div class="seo-section-title" style="margin-top:10px;font-size:11px;">Most Used Words in Titles</div>';
    html += '<table class="keyword-table"><tr><th>Keyword</th><th>Count</th><th>% Titles</th></tr>';
    topWords.forEach(([word, count]) => {
      const pct = Math.round((count / products.length) * 100);
      html += `<tr><td><strong>${escapeHtml(word)}</strong></td><td>${count}</td><td>${pct}%</td></tr>`;
    });
    html += '</table>';

    // Top 5 competitor titles
    html += '<div class="seo-section-title" style="margin-top:10px;font-size:11px;">Top Competitor Titles</div>';
    titles.slice(0, 5).forEach((t) => {
      html += `<div class="competitor-card">
        <div class="competitor-title">${escapeHtml(t.name)}</div>
        <div class="competitor-meta">
          <span>Rs.${t.price}</span>
          <span>${t.rating > 0 ? t.rating + " star" : "No rating"}</span>
          <span>${(t.ratings || 0).toLocaleString()} ratings</span>
        </div>
      </div>`;
    });

    html += `<p style="font-size:10px;color:#aaa;margin-top:8px;text-align:center;">Analyzed ${products.length} products</p>`;

    container.innerHTML = html;

  } catch (err) {
    container.innerHTML = `<p style="font-size:11px;color:#c62828;text-align:center;">Error: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Analyze";
  }
}

// Runs in page context - extracts products from Meesho search pages
function extractSearchProducts() {
  const products = [];

  // Method 1: Try __NEXT_DATA__ first (most reliable)
  const nextDataEl = document.querySelector("#__NEXT_DATA__");
  if (nextDataEl) {
    try {
      const json = JSON.parse(nextDataEl.textContent);
      // Deep search for product arrays in the JSON
      const found = findProductArrays(json, 0);
      if (found.length > 0) {
        found.forEach((p) => {
          products.push({
            name: (p.name || p.product_name || p.title || "").trim(),
            price: p.min_catalog_price || p.min_product_price || p.price || p.discounted_price || 0,
            rating: (p.catalog_reviews_summary?.average_rating) || p.average_rating || p.rating || 0,
            ratingCount: (p.catalog_reviews_summary?.rating_count) || p.rating_count || p.ratings || 0,
            reviewCount: (p.catalog_reviews_summary?.review_count) || p.review_count || 0,
            slug: p.slug || "",
            productId: p.product_id || p.id || "",
          });
        });
      }
    } catch {}
  }

  // Method 2: If __NEXT_DATA__ didn't work, scrape rendered DOM
  if (products.length === 0) {
    // Find all product card containers
    const links = document.querySelectorAll('a[href*="/p/"]');
    const seen = new Set();

    links.forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (seen.has(href)) return;
      seen.add(href);

      // Walk up to find the product card container
      let card = link;
      for (let i = 0; i < 5; i++) {
        if (card.parentElement) card = card.parentElement;
        // Stop when card is wide enough to be a product card
        if (card.offsetWidth > 100) break;
      }

      const allText = card.innerText || "";
      const lines = allText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

      // Product name: longest line that's not a price/rating/delivery text
      let name = "";
      for (const line of lines) {
        if (line.length > 10 && line.length < 300
            && !line.match(/^[\u20B9Rs.\d]/)
            && !line.match(/^\d+%/)
            && !line.match(/^Free/i)
            && !line.match(/^(Reviews?|Ratings?|Delivery)/i)) {
          name = line;
          break;
        }
      }
      if (!name) return;

      // Price: find Rs or rupee symbol followed by digits
      let price = 0;
      for (const line of lines) {
        const m = line.match(/[\u20B9Rs.]+\s*(\d{2,6})/);
        if (m) { price = parseInt(m[1]); break; }
      }

      // Rating and rating count
      // NOTE: Meesho search cards show "2824 Reviews" but this is actually RATING COUNT
      // Real review count is lower and only visible on product page (e.g., "2824 Ratings, 1429 Reviews")
      let rating = 0, ratingCount = 0;
      for (const line of lines) {
        const rm = line.match(/([\d.]+)\s*[\u2605\u2B50]/);
        if (rm) rating = parseFloat(rm[1]);
        // "X Reviews" on search cards = actually rating count (Meesho mislabels it)
        const cm = line.match(/([\d,.]+[kK]?)\s*(Reviews?|Ratings?)/i);
        if (cm) {
          let num = cm[1].replace(/,/g, "");
          ratingCount = num.match(/[kK]$/) ? parseFloat(num) * 1000 : parseInt(num);
        }
      }

      products.push({ name, price, rating, ratingCount, href });
    });
  }

  // Method 3: If DOM scraping also failed, try raw text extraction
  if (products.length === 0) {
    // Last resort: find product-like text blocks near /p/ links
    document.querySelectorAll('a[href*="/p/"]').forEach((a) => {
      const text = a.textContent.trim();
      const lines = text.split('\n').filter((l) => l.trim().length > 5);
      if (lines.length > 0 && lines[0].length > 10 && lines[0].length < 300) {
        const priceMatch = text.match(/[\u20B9Rs.]\s*(\d+)/);
        products.push({
          name: lines[0].trim(),
          price: priceMatch ? parseInt(priceMatch[1]) : 0,
          rating: 0,
          ratingCount: 0,
        });
      }
    });
  }

  return products;
}

// Runs in page context - extracts full product title from a product page
function extractFullProductTitle() {
  let name = "", price = 0, ratingCount = 0;
  const candidates = []; // Collect all possible titles, pick the best one

  // Method 1: og:title meta tag (most reliable for SEO - this IS the product title)
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    const t = (ogTitle.getAttribute("content") || "").trim();
    // Remove " | Meesho" or "- Meesho" suffix
    const clean = t.replace(/\s*[\|\-]\s*Meesho.*$/i, "").trim();
    if (clean.length > 10) candidates.push({ src: "og:title", text: clean });
  }

  // Method 2: The visible product title on the page (what user sees)
  // Meesho shows title in a specific area near the price
  const h1 = document.querySelector('h1');
  if (h1 && h1.textContent.trim().length > 10) {
    candidates.push({ src: "h1", text: h1.textContent.trim() });
  }

  // Method 3: Look for the title element that appears before the price
  // Meesho product pages have title as a <p> or <span> near the top
  const priceEl = document.querySelector('h4, [class*="price"], [class*="Price"]');
  if (priceEl) {
    let prev = priceEl.previousElementSibling;
    for (let i = 0; i < 5 && prev; i++) {
      const t = prev.textContent.trim();
      if (t.length > 20 && t.length < 500 && !t.match(/^[\u20B9Rs.\d]/)) {
        candidates.push({ src: "before-price", text: t });
        break;
      }
      prev = prev.previousElementSibling;
    }
  }

  // Method 4: __NEXT_DATA__ structured data
  const el = document.querySelector("#__NEXT_DATA__");
  if (el) {
    try {
      const json = JSON.parse(el.textContent);
      // Try known paths for product data
      const paths = [
        json.props?.pageProps?.productData,
        json.props?.pageProps?.initialState?.product?.product,
        json.props?.pageProps?.initialState?.catalog?.catalogData,
        json.props?.pageProps?.product,
        json.props?.pageProps?.catalog,
      ];
      for (const product of paths) {
        if (!product) continue;
        const n = product.name || product.product_name || product.title || "";
        if (n.length > 10) {
          candidates.push({ src: "nextdata", text: n.trim() });
          price = product.min_catalog_price || product.min_product_price || product.price || product.discounted_price || price;
          const cr = product.catalog_reviews_summary || {};
          ratingCount = cr.rating_count || product.rating_count || ratingCount;
          break;
        }
      }
    } catch {}
  }

  // Method 5: document.title (browser tab title)
  if (document.title && document.title.length > 15) {
    const clean = document.title.replace(/\s*[\|\-]\s*Meesho.*$/i, "").replace(/^Buy\s+/i, "").trim();
    if (clean.length > 10) candidates.push({ src: "doc-title", text: clean });
  }

  // Pick the LONGEST candidate (longer = more keywords = better for SEO analysis)
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.text.length - a.text.length);
    name = candidates[0].text;
  }

  // Get rating count from page text if not found in __NEXT_DATA__
  if (ratingCount === 0) {
    const bodyText = document.body.innerText || "";
    const rm = bodyText.match(/([\d,]+)\s*Ratings?/i);
    if (rm) ratingCount = parseInt(rm[1].replace(/,/g, ""));
  }

  // Get price from page text if not found
  if (price === 0) {
    const bodyText = document.body.innerText || "";
    const pm = bodyText.match(/[\u20B9Rs.]\s*(\d{2,6})/);
    if (pm) price = parseInt(pm[1]);
  }

  return { name, price, ratingCount };
}

// Deep search helper: recursively finds arrays of product-like objects in any JSON structure
function findProductArrays(obj, depth) {
  if (depth > 8 || !obj || typeof obj !== "object") return [];

  // Check if this is an array of product objects
  if (Array.isArray(obj) && obj.length > 0) {
    const first = obj[0];
    if (first && typeof first === "object" && (first.name || first.product_name || first.title) && (first.min_catalog_price || first.min_product_price || first.price || first.discounted_price)) {
      return obj;
    }
  }

  // Recurse into known Meesho paths first, then everything else
  const priorityKeys = ["products", "catalogs", "data", "items", "results", "listing", "searchListing", "shopListing", "pageProps", "initialState", "props"];
  const allKeys = Object.keys(obj);
  const orderedKeys = [...priorityKeys.filter((k) => allKeys.includes(k)), ...allKeys.filter((k) => !priorityKeys.includes(k))];

  for (const key of orderedKeys) {
    const val = obj[key];
    if (!val || typeof val !== "object") continue;

    // Handle nested product arrays like products[0].products
    if (Array.isArray(val) && val.length > 0 && Array.isArray(val[0]?.products)) {
      return val[0].products;
    }

    const found = findProductArrays(val, depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

// --- Title Optimizer ---
function updateTitleStats() {
  const title = document.getElementById("titleInput").value;
  const charCount = title.length;
  const wordCount = title.trim() ? title.trim().split(/\s+/).length : 0;

  document.getElementById("titleCharCount").textContent = `${charCount} / 200 characters`;
  document.getElementById("titleWordCount").textContent = `${wordCount} words`;

  // Color the char count
  const charEl = document.getElementById("titleCharCount");
  if (charCount > 200) charEl.style.color = "#c62828";
  else if (charCount > 150) charEl.style.color = "#e65100";
  else charEl.style.color = "#999";
}

function analyzeTitle() {
  const title = document.getElementById("titleInput").value.trim();
  if (!title) return;

  const checks = [];
  let score = 0;
  const maxScore = 100;

  const charCount = title.length;
  const wordCount = title.split(/\s+/).length;
  const titleLower = title.toLowerCase();
  const words = title.split(/[\s,\-|()\/]+/).filter((w) => w.length > 1);

  // 0. Gibberish/spam detection - check if words are real
  // Real words have vowels and consonants in normal patterns
  // Gibberish like "vjhghgkg jhgjhguytrtruvvjb" has no vowels or random patterns
  const realWordCount = words.filter((w) => {
    if (w.length <= 2) return true; // short words are fine
    const lower = w.toLowerCase();
    // Must have at least 1 vowel per 4 consonants
    const vowels = (lower.match(/[aeiou]/g) || []).length;
    const consonants = (lower.match(/[bcdfghjklmnpqrstvwxyz]/g) || []).length;
    if (consonants > 0 && vowels === 0) return false; // no vowels = gibberish
    if (consonants > 4 * vowels) return false; // too many consonants
    // Check for repeated chars (3+ same char in a row)
    if (/(.)\1{2,}/.test(lower)) return false;
    // Check for no repeating 2-char patterns
    if (/(.{2})\1{2,}/.test(lower)) return false;
    return true;
  }).length;

  const gibberishRatio = words.length > 0 ? (words.length - realWordCount) / words.length : 0;
  if (gibberishRatio > 0.3) {
    // More than 30% gibberish words - heavy penalty
    score -= 40;
    checks.push({ pass: false, text: `${words.length - realWordCount} gibberish/fake words detected! Use real product words only` });
  }

  // 1. Title Length (20 points)
  if (charCount >= 80 && charCount <= 180) {
    score += 20;
    checks.push({ pass: true, text: `Good length (${charCount} chars) - ideal is 80-180` });
  } else if (charCount >= 50 && charCount < 80) {
    score += 10;
    checks.push({ pass: "warn", text: `Title is short (${charCount} chars) - try 80-180 for best results` });
  } else if (charCount > 180 && charCount <= 200) {
    score += 15;
    checks.push({ pass: "warn", text: `Title is a bit long (${charCount} chars) - keep under 180` });
  } else if (charCount > 200) {
    score += 5;
    checks.push({ pass: false, text: `Title too long (${charCount} chars) - Meesho may truncate it` });
  } else {
    checks.push({ pass: false, text: `Title too short (${charCount} chars) - add more details` });
  }

  // 2. Word Count (15 points)
  if (wordCount >= 8 && wordCount <= 20) {
    score += 15;
    checks.push({ pass: true, text: `Good word count (${wordCount} words)` });
  } else if (wordCount >= 5 && wordCount < 8) {
    score += 8;
    checks.push({ pass: "warn", text: `Add more descriptive words (${wordCount} words, ideal 8-20)` });
  } else if (wordCount > 20) {
    score += 8;
    checks.push({ pass: "warn", text: `Too many words (${wordCount}) - keep it focused` });
  } else {
    checks.push({ pass: false, text: `Very few words (${wordCount}) - add more keywords` });
  }

  // 3. No Special Characters spam (10 points)
  const specialChars = (title.match(/[!@#$%^&*(){}[\]<>~`]/g) || []).length;
  if (specialChars === 0) {
    score += 10;
    checks.push({ pass: true, text: "Clean title - no spammy special characters" });
  } else if (specialChars <= 3) {
    score += 5;
    checks.push({ pass: "warn", text: `${specialChars} special characters found - keep minimal` });
  } else {
    checks.push({ pass: false, text: `Too many special characters (${specialChars}) - remove them` });
  }

  // 4. Not ALL CAPS (10 points)
  const capsRatio = (title.match(/[A-Z]/g) || []).length / Math.max(title.replace(/\s/g, "").length, 1);
  if (capsRatio < 0.5) {
    score += 10;
    checks.push({ pass: true, text: "Good capitalization - not all caps" });
  } else {
    checks.push({ pass: false, text: "Avoid ALL CAPS - use normal capitalization" });
  }

  // 5. Has numbers/sizes (10 points) - helpful for Meesho
  const hasNumbers = /\d/.test(title);
  const hasSizeWords = /(pack|pcs|piece|set|ml|gm|kg|inch|cm|ltr|meter|mtr)/i.test(title);
  if (hasNumbers || hasSizeWords) {
    score += 10;
    checks.push({ pass: true, text: "Has quantity/size info - helps buyers decide" });
  } else {
    score += 3;
    checks.push({ pass: "warn", text: "Consider adding pack size, quantity, or dimensions" });
  }

  // 6. Has descriptors - material/feature/spec (10 points)
  // Check ALL types of descriptors - no category needed
  const materialWords = (title.match(/(cotton|silk|georgette|rayon|polyester|crepe|chiffon|linen|wool|leather|steel|plastic|wooden|metal|rubber|nylon|acrylic|ceramic|glass|aluminium|iron|brass|copper|jute|velvet|satin|denim|fleece|foam|fiber)/gi) || []);
  const featureWords = (title.match(/(USB|rechargeable|wireless|bluetooth|portable|mini|waterproof|adjustable|foldable|automatic|digital|LED|solar|magnetic|anti-slip|non-stick|BPA free|eco friendly|organic|handmade|machine washable|scratch proof|shockproof|dustproof)/gi) || []);
  const specWords = (title.match(/(\d+\s*(ml|gm|kg|inch|cm|mm|ltr|meter|mtr|watt|volt|mAh|GB|MB|GSM|RPM|HP|W|V|A))/gi) || []);

  const totalDescriptors = materialWords.length + featureWords.length + specWords.length;
  if (totalDescriptors >= 3) {
    score += 10;
    checks.push({ pass: true, text: `Has ${totalDescriptors} descriptors (material/features/specs) - excellent for search` });
  } else if (totalDescriptors >= 1) {
    score += 6;
    checks.push({ pass: "warn", text: `Has ${totalDescriptors} descriptor(s) - add more (material, features, or specs)` });
  } else {
    score += 2;
    checks.push({ pass: false, text: "No descriptors found - add material, features, or specs (e.g. cotton, USB, 500ml)" });
  }

  // 7. Has audience OR use case (10 points)
  const hasAudience = /(women|men|girls|boys|kids|baby|ladies|gents|unisex|children|toddler|infant|adult|teen)/i.test(title);
  const hasUseCase = /(home|office|travel|outdoor|car|desk|table|kitchen|bedroom|bathroom|gym|workout|camping|school|college|party|wedding|casual|daily|sports|garden|balcony|living room|indoor|gift)/i.test(title);

  if (hasAudience && hasUseCase) {
    score += 10;
    checks.push({ pass: true, text: "Has both audience & use case - maximum search visibility" });
  } else if (hasAudience) {
    score += 8;
    checks.push({ pass: true, text: "Has target audience - good for search" });
  } else if (hasUseCase) {
    score += 8;
    checks.push({ pass: true, text: "Has use case - helps buyers find it" });
  } else {
    score += 2;
    checks.push({ pass: "warn", text: "Add who it's for (women, kids, etc.) or where to use (home, office, etc.)" });
  }

  // 8. Keyword match from autocomplete (15 points)
  if (cachedKeywords.length > 0) {
    // Match whole keywords properly - each word of the keyword must be in the title
    const matchedKw = cachedKeywords.filter((kw) => {
      const kwWords = kw.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      return kwWords.length > 0 && kwWords.every((w) => titleLower.includes(w));
    });
    if (matchedKw.length >= 3) {
      score += 15;
      checks.push({ pass: true, text: `Matches ${matchedKw.length} trending keywords` });
    } else if (matchedKw.length >= 1) {
      score += 8;
      checks.push({ pass: "warn", text: `Matches ${matchedKw.length} keyword(s) - try adding more trending keywords` });
    } else {
      checks.push({ pass: false, text: "No trending keywords matched - search keywords first" });
    }

    // Show matched keywords
    if (matchedKw.length > 0) {
      let kwHtml = '<div class="keyword-cloud" style="margin-top:4px">';
      matchedKw.forEach((kw) => {
        kwHtml += `<span class="keyword-tag tag-green">${escapeHtml(kw)}</span>`;
      });
      kwHtml += '</div>';
      document.getElementById("seoKeywordsUsed").innerHTML = kwHtml;
    } else {
      document.getElementById("seoKeywordsUsed").innerHTML = '';
    }
  } else {
    score += 5; // Neutral if no keywords fetched
    checks.push({ pass: "warn", text: "Search keywords first to check keyword match" });
    document.getElementById("seoKeywordsUsed").innerHTML = '';
  }

  // Calculate final score
  score = Math.min(score, maxScore);

  // Update score UI
  const scoreFill = document.getElementById("seoScoreFill");
  const scoreLabel = document.getElementById("seoScoreLabel");
  scoreFill.style.width = score + "%";

  let scoreColor, scoreText;
  if (score >= 80) {
    scoreColor = "#2e7d32";
    scoreText = score + "/100 - Excellent!";
  } else if (score >= 60) {
    scoreColor = "#e65100";
    scoreText = score + "/100 - Good, can improve";
  } else if (score >= 40) {
    scoreColor = "#ef6c00";
    scoreText = score + "/100 - Needs work";
  } else {
    scoreColor = "#c62828";
    scoreText = score + "/100 - Poor, fix issues below";
  }

  scoreFill.style.background = scoreColor;
  scoreLabel.style.color = scoreColor;
  scoreLabel.textContent = scoreText;

  // Show tips
  const tipsEl = document.getElementById("seoTips");
  tipsEl.innerHTML = "";
  checks.forEach((c) => {
    const li = document.createElement("li");
    let iconClass, iconText;
    if (c.pass === true) {
      iconClass = "tip-pass";
      iconText = "OK";
    } else if (c.pass === "warn") {
      iconClass = "tip-warn";
      iconText = "!!";
    } else {
      iconClass = "tip-fail";
      iconText = "X";
    }
    li.innerHTML = `<span class="tip-icon ${iconClass}">${iconText}</span> ${escapeHtml(c.text)}`;
    tipsEl.appendChild(li);
  });
}
