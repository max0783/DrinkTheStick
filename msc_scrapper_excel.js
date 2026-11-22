const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const HEADERS = [
  "Destino",
  "Duración",
  "Barco",
  "Puerto de Salida",
  "Moneda",
  "Precio",
  "Fechas Disponibles",
  "Promoción",
  "URL Itinerario",
  "Página",
  "Camarote"
];

function formatDateDMY(dateObj) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(dateObj.getDate())}/${pad(dateObj.getMonth() + 1)}/${dateObj.getFullYear()}`;
}

function addMonthsClamped(baseDate, months) {
  const d = new Date(baseDate);
  const totalMonths = d.getMonth() + months;
  const futureYear = d.getFullYear() + Math.floor(totalMonths / 12);
  const futureMonth = totalMonths % 12;
  const lastDayOfMonth = new Date(futureYear, futureMonth + 1, 0).getDate();
  const futureDay = Math.min(d.getDate(), lastDayOfMonth);
  return new Date(futureYear, futureMonth, futureDay);
}

/**
 * Calculates rolling departure dates from a base date (+18 months by default).
 * Formats dates as DD/MM/YYYY with month-end and leap-year clamping.
 *
 * @param {Date} [baseDate=new Date()]
 * @returns {{ departureDateFrom: string, departureDateTo: string }}
 */
function calculateDepartureDates(baseDate = new Date()) {
  const d = new Date(baseDate);
  if (Number.isNaN(d.getTime())) {
    throw new Error("Invalid baseDate provided to calculateDepartureDates");
  }

  return {
    departureDateFrom: formatDateDMY(d),
    departureDateTo: formatDateDMY(addMonthsClamped(d, 18))
  };
}

/**
 * Resolves departure date range from preset or manual dates in filter config.
 *
 * @param {Object} [filters={}]
 * @param {Date} [baseDate=new Date()]
 * @returns {{ departureDateFrom: string, departureDateTo: string }}
 */
function resolveSearchDates(filters = {}, baseDate = new Date()) {
  if (filters && filters.dateFrom && filters.dateTo) {
    return {
      departureDateFrom: String(filters.dateFrom).trim(),
      departureDateTo: String(filters.dateTo).trim()
    };
  }

  const d = new Date(baseDate);
  if (Number.isNaN(d.getTime())) {
    throw new Error("Invalid baseDate provided to resolveSearchDates");
  }

  const preset = filters && filters.datePreset ? String(filters.datePreset) : "18m";
  if (preset === "6m") {
    return { departureDateFrom: formatDateDMY(d), departureDateTo: formatDateDMY(addMonthsClamped(d, 6)) };
  }
  if (preset === "12m") {
    return { departureDateFrom: formatDateDMY(d), departureDateTo: formatDateDMY(addMonthsClamped(d, 12)) };
  }
  if (preset === "summer") {
    const year = d.getFullYear();
    if (d.getMonth() <= 2) {
      return { departureDateFrom: formatDateDMY(d), departureDateTo: `31/03/${year}` };
    }
    return { departureDateFrom: `01/12/${year}`, departureDateTo: `31/03/${year + 1}` };
  }

  return calculateDepartureDates(d);
}

const SUBCATEGORY_URLS = {
  "black-friday": "https://www.msccruceros.com.ar/ofertas-cruceros/black-friday",
  "la-romana": "https://www.msccruceros.com.ar/ofertas-cruceros/msc-opera-la-romana",
  "grand-voyages": "https://www.msccruceros.com.ar/ofertas-cruceros/tarifa-especial--grand-voyage",
  "temporada-2728": "https://www.msccruceros.com.ar/ofertas-cruceros/temporada-2728",
  "yacht-club": "https://www.msccruceros.com.ar/ofertas-cruceros/msc-yacht-club",
  "brasil": "https://www.msccruceros.com.ar/ofertas-cruceros/cruceros-a-brasil",
  "cruceros-mediterraneo": "https://www.msccruceros.com.ar/ofertas-cruceros/cruceros-mediterraneo",
  "msc-world-asia": "https://www.msccruceros.com.ar/ofertas-cruceros/msc-world-asia"
};

const EXCLUDED_PROMO_SLUGS = new Set([
  "nuestras-tarifas",
  "voyagers-exclusives",
  "stay-and-cruise",
  "2026-cruises",
  "2027-cruises",
  "2028-cruises"
]);

function parseFilterCsv(raw) {
  const arr = Array.isArray(raw)
    ? raw.map((x) => String(x || "").trim())
    : String(raw || "").split(",").map((x) => x.trim());
  return [...new Set(arr.filter(Boolean))];
}

/**
 * Expands multi-value filter fields (`subcategory`, `cabin`, `nights`) into atomic
 * scrape specs while keeping comma-joined `area` and `embkPort` in a single URL.
 *
 * @param {Object|null} [filters=null]
 * @returns {Array<Object|null>}
 */
function expandFilterCombos(filters = null) {
  if (!filters || typeof filters !== "object") return [null];
  const normalizedArea = filters.area !== undefined ? parseFilterCsv(filters.area).join(",") : "SOA";
  const normalizedPort = filters.embkPort !== undefined ? parseFilterCsv(filters.embkPort).join(",") : "BUE,MVD";
  const subs = parseFilterCsv(filters.subcategory);
  const cabins = parseFilterCsv(filters.cabin);
  const nightsList = parseFilterCsv(filters.nights);

  const subTargets = subs.length > 0 ? subs : [""];
  const cabinTargets = cabins.length > 0 ? cabins : [""];
  const nightsTargets = nightsList.length > 0 ? nightsList : [""];

  const combos = [];
  for (const subcategory of subTargets) {
    for (const cabin of cabinTargets) {
      for (const nights of nightsTargets) {
        combos.push({
          ...filters,
          area: normalizedArea,
          embkPort: normalizedPort,
          subcategory,
          cabin,
          nights
        });
      }
    }
  }
  return combos;
}

/**
 * Builds the MSC search URL with encoded departure dates and search parameters.
 * Uses curated promo URL when `filters.subcategory` is selected (known alias or discovered slug);
 * otherwise routes through `/Search%20Result`.
 *
 * @param {{ departureDateFrom: string, departureDateTo: string }} dates
 * @param {number} [page=1]
 * @param {Object|null} [filters=null]
 * @returns {string}
 */
function buildSearchUrl(dates, page = 1, filters = null) {
  if (!filters || typeof filters !== "object") {
    const baseUrl = "https://www.msccruceros.com.ar/ofertas-cruceros/cruceros-a-brasil";
    const fromEnc = encodeURIComponent(dates.departureDateFrom);
    const toEnc = encodeURIComponent(dates.departureDateTo);
    return `${baseUrl}?departureDateFrom=${fromEnc}&departureDateTo=${toEnc}&passengers=2%7C0%7C0%7C0&area=SOA&embkPort=BUE%2CMVD&page=${page}`;
  }

  const subKey = parseFilterCsv(filters.subcategory)[0] || "";
  if (subKey) {
    let subUrl = SUBCATEGORY_URLS[subKey] || "";
    if (!subUrl && /^[a-z0-9-]+$/i.test(subKey)) {
      subUrl = `https://www.msccruceros.com.ar/ofertas-cruceros/${subKey}`;
    }
    if (subUrl) {
      return page > 1 ? `${subUrl}?page=${page}` : subUrl;
    }
  }

  const baseUrl = "https://www.msccruceros.com.ar/Search%20Result";
  const params = new URLSearchParams();
  params.set("departureDateFrom", dates.departureDateFrom);
  params.set("departureDateTo", dates.departureDateTo);
  params.set("passengers", "2|0|0|0");

  const area = filters.area !== undefined ? parseFilterCsv(filters.area).join(",") : "SOA";
  if (area) params.set("area", area);

  const embkPort = filters.embkPort !== undefined ? parseFilterCsv(filters.embkPort).join(",") : "BUE,MVD";
  if (embkPort) params.set("embkPort", embkPort);

  const cabin = parseFilterCsv(filters.cabin)[0] || "";
  if (cabin) params.set("cabins", cabin);

  params.set("page", String(page));
  return `${baseUrl}?${params.toString()}`;
}

/**
 * Parses raw price text (e.g. '771 USD', '1.150 USD', 'ARS 1.500.000', 'USD 1.234')
 * into a typed numeric object { moneda: string, valor: number }.
 *
 * @param {string} priceText
 * @returns {{ moneda: string, valor: number }}
 */
function parsePrice(priceText) {
  if (!priceText || typeof priceText !== "string" || !priceText.trim()) {
    return { moneda: "USD", valor: 0 };
  }

  const text = priceText.trim();
  let moneda = "USD";
  if (/ARS/i.test(text)) {
    moneda = "ARS";
  } else if (/EUR/i.test(text)) {
    moneda = "EUR";
  }

  // Remove Spanish thousand-separator dots (e.g. 1.150, 1.234, or 1.500.000)
  let numericStr = text;
  if (/\d\.\d{3}/.test(numericStr)) {
    numericStr = numericStr.replace(/\./g, "");
  }

  const cleaned = numericStr.replace(/[^\d.-]/g, "");
  const parsed = parseFloat(cleaned);
  const valor = Number.isNaN(parsed) ? 0 : (parsed % 1 === 0 ? parseInt(parsed, 10) : parsed);

  return {
    moneda,
    valor
  };
}

/**
 * Gracefully dismisses Didomi CMP cookie banner to prevent click interception.
 * Never throws if banner is absent or times out.
 *
 * @param {Object} page - Puppeteer page object
 * @param {number} [timeout=2500]
 * @returns {Promise<boolean>}
 */
async function dismissCookieBanner(page, timeout = 2500) {
  if (!page || typeof page.waitForSelector !== "function") {
    return false;
  }

  try {
    const agreeBtn = await page.waitForSelector("#didomi-notice-agree-button", {
      visible: true,
      timeout
    });
    if (agreeBtn) {
      await agreeBtn.click();
      if (typeof page.waitForFunction === "function") {
        await page.waitForFunction(() => {
          const host = document.getElementById("didomi-host");
          if (!host) return true;
          const style = window.getComputedStyle(host);
          return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
        }, { timeout: 2000 }).catch(() => {});
      }
      return true;
    }
  } catch (err) {
    // Banner not displayed or timed out
  }

  // Fallback: remove obstructing overlay if still rendered
  if (typeof page.evaluate === "function") {
    try {
      const removed = await page.evaluate(() => {
        const host = document.getElementById("didomi-host");
        if (host && window.getComputedStyle(host).display !== "none") {
          host.remove();
          return true;
        }
        return false;
      });
      if (removed) return true;
    } catch (evalErr) {}
  }

  return false;
}

/**
 * Robust Puppeteer 24.x browser launcher supporting host Chrome discovery,
 * custom binary paths, modern headless boolean, and stealth flags.
 *
 * @param {Object} [userOptions={}]
 * @returns {Promise<Object>}
 */
async function launchBrowser(userOptions = {}) {
  const isHeadless = userOptions.headless !== undefined
    ? Boolean(userOptions.headless)
    : (process.env.PUPPETEER_HEADLESS === "false" ? false : true);

  const baseArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--start-maximized"
  ];

  const defaultViewport = { width: 1440, height: 900 };
  const macHostChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  const strategies = [];
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    strategies.push({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH });
  }
  strategies.push({ channel: "chrome" });
  if (process.platform === "darwin" && fs.existsSync(macHostChrome)) {
    strategies.push({ executablePath: macHostChrome });
  }
  strategies.push({});

  let lastErr = null;
  for (const extra of strategies) {
    try {
      return await puppeteer.launch({
        headless: isHeadless,
        defaultViewport,
        args: baseArgs,
        ...extra
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function isConnectionRefusedError(err) {
  const msg = String(err?.message || err || "");
  return err?.code === "ECONNREFUSED" || /ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(msg);
}

function isTransientNetworkError(err) {
  const msg = String(err?.message || err || "");
  const code = String(err?.code || "");
  if (isConnectionRefusedError(err)) return true;
  if (["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].includes(code)) return true;
  return /ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_CLOSED|ERR_CONNECTION_FAILED|Navigation timeout|Timed out|ETIMEDOUT|ECONNRESET/i.test(msg);
}

function formatNetworkError(err, url = "") {
  const raw = String(err?.message || err || "Error desconocido de red");
  if (isConnectionRefusedError(err)) {
    return url
      ? `Conexión rechazada (ECONNREFUSED) al conectar con ${url}: ${raw}`
      : `Conexión rechazada (ECONNREFUSED): ${raw}`;
  }
  return raw;
}

/**
 * Navigates to a URL with exponential backoff retries on transient connection errors
 * such as net::ERR_CONNECTION_REFUSED / ECONNRESET / timeouts.
 *
 * @param {Object} page
 * @param {string} url
 * @param {Object} [options={}]
 * @returns {Promise<*>}
 */
async function navigateWithRetry(page, url, options = {}) {
  const maxRetries = Number.isInteger(options.navigationRetries) && options.navigationRetries >= 0
    ? options.navigationRetries
    : 2;
  const baseDelayMs = Number(options.retryDelayMs) >= 0 ? Number(options.retryDelayMs) : 1200;
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 45000;
  const waitUntil = options.waitUntil || "domcontentloaded";

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await page.goto(url, { waitUntil, timeout });
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || attempt >= maxRetries) {
        throw err;
      }
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `[Scraper Retry] Intento ${attempt + 1}/${maxRetries + 1} falló para ${url} (${err.message}). Reintentando en ${delayMs}ms...`
      );
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

/**
 * Configures the Puppeteer page with realistic desktop User-Agent,
 * language headers, and viewport dimensions.
 *
 * @param {Object} browser
 * @returns {Promise<Object>}
 */
async function setupPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "es-AR,es;q=0.9,en;q=0.8"
  });
  return page;
}

/**
 * Executes inside page context to extract all cruise cards on the current page.
 * Target: Vue 3 / ItineraryCardRevamp SPA layout.
 *
 * @param {number} currentPageNum
 * @returns {Array<Object>}
 */
function extractCruisesFromDOM(currentPageNum) {
  const cards = document.querySelectorAll(".cruise-card:not(.tw-animate-pulse)");

  return Array.from(cards).map((card) => {
    // 1. Destination
    const destEl = card.querySelector(".description__title") ||
                   card.querySelector(".poster__title");
    const destino = destEl ? destEl.textContent.trim() : "Sudamérica";

    // 2. Duration
    const durEl = card.querySelector(".description .badge span") ||
                  card.querySelector(".poster .badge span") ||
                  card.querySelector(".badge__text");
    const duracion = durEl ? durEl.textContent.trim() : "";

    // 3. Ship name (excluding inline SVG icon and excess whitespace)
    const shipEl = card.querySelector(".ship-name");
    const barco = shipEl ? shipEl.textContent.replace(/\s+/g, " ").trim() : "";

    // 4. Departure port (supports both roundtrip and one-way "DESDE ... HACIA ...")
    const portWrapper = card.querySelector(".description .tw-text-sm") ||
                        card.querySelector(".tw-text-sm");
    let puerto_salida = "";
    let solo_ida = false;
    if (portWrapper) {
      const rawText = portWrapper.textContent.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      const spans = Array.from(portWrapper.querySelectorAll("span"));
      if (/HACIA\s*:/i.test(rawText) || /VIAJE DE IDA DESDE/i.test(rawText)) {
        solo_ida = true;
        const match = rawText.match(/(?:VIAJE DE IDA DESDE|DESDE)\s*:\s*(.+?)\s+HACIA\s*:\s*(.+)$/i);
        if (match) {
          puerto_salida = `${match[1].trim()} → ${match[2].trim()} (Solo ida)`;
        } else if (spans.length >= 4) {
          puerto_salida = `${spans[1].textContent.trim()} → ${spans[3].textContent.trim()} (Solo ida)`;
        } else {
          puerto_salida = rawText;
        }
      } else if (spans.length > 1) {
        puerto_salida = spans[spans.length - 1].textContent.trim();
      } else {
        puerto_salida = rawText
          .replace(/VIAJE DE IDA Y VUELTA DESDE:?/i, "")
          .replace(/IDA Y VUELTA DESDE:?/i, "")
          .replace(/SALIDA DESDE:?/i, "")
          .replace(/DESDE:?/i, "")
          .trim();
      }
    }

    // 5. Raw Price string
    const priceEl = card.querySelector(".prices__main-price span") ||
                    card.querySelector(".prices__main-price");
    const rawPrice = priceEl ? priceEl.textContent.trim() : "";

    // 6. Available dates array
    const dateButtons = card.querySelectorAll("button.date-item, .departure-dates__date-item");
    const fechas_disponibles = Array.from(dateButtons).map((btn) => {
      const labels = btn.querySelectorAll(".date-item__label");
      if (labels.length > 0) {
        return Array.from(labels).map((l) => l.textContent.trim()).join(" ");
      }
      return btn.textContent.replace(/\s+/g, " ").trim();
    }).filter(Boolean);

    // 7. Promotion (with duration badge exclusion)
    const bestPriceBadge = card.querySelector(".badge--theme--bestprice");
    let promocion = bestPriceBadge ? bestPriceBadge.textContent.trim() : null;
    if (!promocion) {
      const ribbons = card.querySelector(".poster__ribbons");
      if (ribbons && ribbons.textContent.trim()) {
        promocion = ribbons.textContent.trim();
      } else {
        const badges = card.querySelectorAll(".price-section .badge, .poster .badge, .badge");
        for (const b of badges) {
          const txt = b.textContent.trim();
          if (txt && !/noches|días|dias/i.test(txt)) {
            promocion = txt;
            break;
          }
        }
      }
    }

    // 8. Itinerary URL / cruise ID deep link
    const descEl = card.querySelector(".description");
    const cruiseId = descEl?.getAttribute("cruise-id") ||
                     card.querySelector(".date-item")?.getAttribute("data-id") ||
                     card.getAttribute("data-cruise-id") || "";
    const origin = window.location.hostname.includes("msccruceros")
      ? window.location.origin
      : "https://www.msccruceros.com.ar";
    const pageUrlBase = window.location.hostname.includes("msccruceros")
      ? `${window.location.origin}${window.location.pathname}`
      : "https://www.msccruceros.com.ar/ofertas-cruceros/cruceros-a-brasil";
    const url_itinerario = cruiseId
      ? `${origin}/booking?cruiseId=${encodeURIComponent(cruiseId)}&adults=2&children=0&infants=0&juniors=0`
      : pageUrlBase;

    return {
      destino,
      duracion,
      barco,
      puerto_salida,
      solo_ida,
      rawPrice,
      fechas_disponibles,
      promocion,
      url_itinerario,
      pagina: currentPageNum
    };
  });
}

/**
 * Generates a professionally styled Excel spreadsheet using ExcelJS.
 *
 * @param {Array<Object>} cruceros - Array of cruise data objects
 * @param {string} [outputPath='cruceros_msc.xlsx'] - File path
 * @returns {Promise<{ success: boolean, rowCount: number, outputPath: string }>}
 */
async function createExcelReport(cruceros = [], outputPath = "cruceros_msc.xlsx") {
  const resolvedPath = path.resolve(outputPath);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "DrinkTheStick";
  workbook.lastModifiedBy = "DrinkTheStick";
  workbook.created = new Date();
  workbook.modified = new Date();

  // Freeze Row 1 so headers remain visible when scrolling
  const worksheet = workbook.addWorksheet("Cruceros MSC", {
    views: [{ state: "frozen", ySplit: 1 }]
  });

  // Define columns with standard initial widths and keys
  worksheet.columns = [
    { header: "Destino", key: "destino", width: 25 },
    { header: "Duración", key: "duracion", width: 14 },
    { header: "Barco", key: "barco", width: 20 },
    { header: "Puerto de Salida", key: "puerto_salida", width: 25 },
    { header: "Moneda", key: "moneda", width: 10 },
    { header: "Precio", key: "precio", width: 15 },
    { header: "Fechas Disponibles", key: "fechas_disponibles", width: 45 },
    { header: "Promoción", key: "promocion", width: 25 },
    { header: "URL Itinerario", key: "url_itinerario", width: 55 },
    { header: "Página", key: "pagina", width: 10 },
    { header: "Camarote", key: "camarote", width: 20 }
  ];

  // Professional Header Styling: MSC Navy Blue #002B49, Bold White Font, Row Height 24
  const headerRow = worksheet.getRow(1);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF002B49" }
    };
    cell.font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
      size: 11,
      name: "Calibri"
    };
    cell.alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true
    };
    cell.border = {
      top: { style: "thin", color: { argb: "FFCCCCCC" } },
      bottom: { style: "medium", color: { argb: "FF001726" } },
      left: { style: "thin", color: { argb: "FFCCCCCC" } },
      right: { style: "thin", color: { argb: "FFCCCCCC" } }
    };
  });

  // Populate data rows
  for (const c of cruceros) {
    // 1. Ensure genuine numeric price
    let valorNumerico = 0;
    if (c.precio && typeof c.precio.valor === "number") {
      valorNumerico = c.precio.valor;
    } else if (c.precio && c.precio.valor !== undefined && c.precio.valor !== null) {
      const parsed = parseFloat(String(c.precio.valor).replace(/[^\d.-]/g, ""));
      valorNumerico = Number.isNaN(parsed) ? 0 : parsed;
    }

    // 2. Format available dates
    const fechasStr = Array.isArray(c.fechas_disponibles)
      ? c.fechas_disponibles.join(", ")
      : (c.fechas_disponibles || "");

    // 3. Format promotion (N/A for null/undefined)
    const promoStr = (c.promocion === null || c.promocion === undefined)
      ? "N/A"
      : String(c.promocion);

    const row = worksheet.addRow({
      destino: c.destino || "",
      duracion: c.duracion || "",
      barco: c.barco || "",
      puerto_salida: c.puerto_salida || c.puerto || "",
      moneda: (c.precio && c.precio.moneda) || "USD",
      precio: valorNumerico,
      fechas_disponibles: fechasStr,
      promocion: promoStr,
      url_itinerario: c.url_itinerario || c.url || "",
      pagina: c.pagina || 1,
      camarote: c.camarote || "Todas"
    });

    // Apply per-cell formatting, alignment, and number format
    row.eachCell((cell, colNumber) => {
      let horizontal = "left";
      if (colNumber === 6) {
        // Col 6: Precio -> Right-aligned number with thousands separator
        horizontal = "right";
        cell.numFmt = "#,##0";
      } else if (colNumber === 2 || colNumber === 5 || colNumber === 10 || colNumber === 11) {
        // Col 2: Duración, Col 5: Moneda, Col 10: Página, Col 11: Camarote -> Center
        horizontal = "center";
      }

      cell.alignment = {
        vertical: "middle",
        horizontal,
        wrapText: true
      };

      cell.border = {
        bottom: { style: "thin", color: { argb: "FFEFEFEF" } }
      };
    });
  }

  // Auto-fit column widths (minimum width >= 10, capped at 60 for URLs)
  worksheet.columns.forEach((column) => {
    let maxLength = column.header ? column.header.length : 10;
    column.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber > 1) {
        const valStr = cell.value !== null && cell.value !== undefined ? String(cell.value) : "";
        if (valStr.length > maxLength) {
          maxLength = valStr.length;
        }
      }
    });
    const targetWidth = Math.max(maxLength + 3, column.width || 10);
    column.width = Math.min(Math.max(targetWidth, 10), 60);
  });

  await workbook.xlsx.writeFile(resolvedPath);

  return {
    success: true,
    rowCount: cruceros.length,
    outputPath: resolvedPath
  };
}

/**
 * Applies interactive UI filters (nights & cabin category) via MSC's advanced filter drawer.
 *
 * @param {import('puppeteer').Page} page
 * @param {Object} [filters={}]
 * @returns {Promise<boolean>}
 */
async function applySearchFiltersOnPage(page, filters = {}) {
  const cabinTarget = filters && filters.cabin ? String(filters.cabin).trim() : "";
  const nightsTarget = filters && filters.nights ? String(filters.nights).trim() : "";
  if (!page || (!cabinTarget && !nightsTarget)) return false;

  const filterBtnSelector = '[automation-id="search-advanced-filters-button"]';
  const hasFilterButton = await page
    .waitForSelector(filterBtnSelector, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (!hasFilterButton) {
    console.warn("[Scraper] Botón de filtros avanzados no encontrado en la página; se omite filtro UI.");
    return false;
  }

  await page.click(filterBtnSelector);
  await page.waitForSelector(".filters-dropdown .checkbox-label", { timeout: 4000 }).catch(() =>
    page.waitForSelector(".filters-dropdown", { timeout: 2000 }).catch(() => {})
  );
  await new Promise((r) => setTimeout(r, 300));

  const selectionResult = await page.evaluate((cabin, nights) => {
    const selectCheckbox = (containerSelector, targetText) => {
      if (!targetText) return true;
      const needle = targetText.toLowerCase();
      const labels = Array.from(document.querySelectorAll(`${containerSelector} .checkbox-label`));
      const match =
        labels.find((el) => el.textContent.trim().toLowerCase() === needle) ||
        labels.find((el) => el.textContent.trim().toLowerCase().includes(needle));
      if (!match) return false;
      match.scrollIntoView({ block: "center" });
      match.click();
      return true;
    };

    const nightsClicked = selectCheckbox('[automation-id="search-nights"]', nights);
    const cabinClicked = selectCheckbox('[automation-id="search-cabins"]', cabin);
    return { nightsClicked, cabinClicked };
  }, cabinTarget, nightsTarget);

  if (!selectionResult.nightsClicked || !selectionResult.cabinClicked) {
    console.warn(`[Scraper] Algún filtro UI no coincidió (nights=${selectionResult.nightsClicked}, cabin=${selectionResult.cabinClicked}).`);
  }

  await new Promise((r) => setTimeout(r, 300));

  const prevSignature = await page.evaluate(() => {
    const counter = document.querySelector(".pagination-wrp__counter");
    const firstCard = document.querySelector(".cruise-card:not(.tw-animate-pulse)");
    return `${counter ? counter.textContent.trim() : ""}||${firstCard ? firstCard.textContent.trim() : ""}`;
  });

  const applyClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll(".filters-dropdown button, .advanced-search-app button"));
    const targetBtn = buttons.find((btn) => !btn.disabled && /aplicar|buscar/i.test(btn.textContent || ""));
    if (!targetBtn) return false;
    targetBtn.click();
    return true;
  });

  if (applyClicked) {
    await Promise.race([
      page.waitForFunction(
        (prev) => {
          if (document.querySelector(".no-results-banner")) return true;
          const counter = document.querySelector(".pagination-wrp__counter");
          const firstCard = document.querySelector(".cruise-card:not(.tw-animate-pulse)");
          const nextSig = `${counter ? counter.textContent.trim() : ""}||${firstCard ? firstCard.textContent.trim() : ""}`;
          return nextSig !== prev;
        },
        { timeout: 10000 },
        prevSignature
      ).catch(() => {}),
      page.waitForNetworkIdle({ idleTime: 700, timeout: 10000 }).catch(() => {})
    ]);
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 5000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }

  return Boolean(applyClicked);
}

/**
 * Crawls MSC's promotions hub to dynamically discover active `/ofertas-cruceros/<slug>` sublinks.
 *
 * @param {Object} [options={}]
 * @param {string} [options.sourceUrl] - Hub URL (defaults to msccruceros.com.ar/ofertas-cruceros)
 * @param {boolean} [options.headless=true]
 * @returns {Promise<{ success: boolean, sourceUrl: string, links: Array<{ slug: string, label: string, url: string }>, error?: string }>}
 */
async function discoverPromoLinks(options = {}) {
  const sourceUrl = options.sourceUrl || "https://www.msccruceros.com.ar/ofertas-cruceros";
  const headless = options.headless !== undefined ? Boolean(options.headless) : true;
  let browser = null;

  try {
    browser = await launchBrowser({ headless });
    const page = await setupPage(browser);
    await navigateWithRetry(page, sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
      navigationRetries: options.navigationRetries,
      retryDelayMs: options.retryDelayMs
    });
    await dismissCookieBanner(page);
    await new Promise((r) => setTimeout(r, 1200));

    const links = await page.evaluate((excluded) => {
      const excludedSet = new Set(excluded);
      const seen = new Set();
      const results = [];

      for (const a of document.querySelectorAll('a[href*="/ofertas-cruceros/"]')) {
        const cleanUrl = a.href.split("#")[0].split("?")[0].replace(/\/$/, "");
        if (cleanUrl.endsWith("/ofertas-cruceros")) continue;

        const slug = cleanUrl.split("/").pop() || "";
        if (!slug || !/^[a-z0-9-]+$/i.test(slug) || excludedSet.has(slug.toLowerCase()) || seen.has(slug)) {
          continue;
        }
        seen.add(slug);

        const rawLabel = (
          a.getAttribute("aria-label") ||
          a.querySelector("h1,h2,h3,h4,.title")?.textContent ||
          a.textContent ||
          slug
        ).replace(/\s+/g, " ").trim();

        const label = rawLabel
          .replace(/Reserv[aá]\s+(ya|ahora)$/i, "")
          .trim()
          .slice(0, 48) || slug;

        results.push({ slug, label, url: cleanUrl });
      }
      return results;
    }, Array.from(EXCLUDED_PROMO_SLUGS));

    return { success: true, sourceUrl, links };
  } catch (error) {
    console.error("[Promo Discovery Error]:", error.message);
    return { success: false, sourceUrl, links: [], error: error.message };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
}

async function scrapeSearchPass(page, targetUrl, filters, maxPages, navOptions = {}) {
  console.log(`[Scraper] Navegando a: ${targetUrl}`);

  await navigateWithRetry(page, targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
    navigationRetries: navOptions.navigationRetries,
    retryDelayMs: navOptions.retryDelayMs
  });

  // Dismiss Didomi Cookie Banner if present
  await dismissCookieBanner(page);

  if (filters) {
    const uiFilters = {
      ...filters,
      cabin: /[?&]cabins=/i.test(targetUrl) ? "" : filters.cabin
    };
    if (uiFilters.cabin || uiFilters.nights) {
      await applySearchFiltersOnPage(page, uiFilters);
    }
  }

  const passCruceros = [];
  let currentPage = 1;
  let hasNextPage = true;

  while (hasNextPage && currentPage <= maxPages) {
    console.log(`[Scraper] Procesando página ${currentPage}...`);

    // Wait for hydrated cruise cards (ignoring skeleton placeholders) or no-results banner
    try {
      await page.waitForSelector(".cruise-card:not(.tw-animate-pulse), .no-results-banner", {
        timeout: 15000
      });
    } catch (_) {}

    // Extract raw cruise data from DOM
    const pageCruises = await page.evaluate(extractCruisesFromDOM, currentPage);

    // Normalize prices and apply tripType filter
    const activeCabinLabel = filters && filters.cabin ? String(filters.cabin).trim() : "Todas";
    const tripTypeFilter = filters && filters.tripType ? String(filters.tripType).trim() : "";
    for (const item of pageCruises) {
      if (tripTypeFilter === "roundtrip" && item.solo_ida) continue;
      if (tripTypeFilter === "oneway" && !item.solo_ida) continue;
      const parsedPrice = parsePrice(item.rawPrice);
      delete item.rawPrice;
      item.precio = parsedPrice;
      item.camarote = activeCabinLabel;
      item.tipo_viaje = item.solo_ida ? "Solo ida" : "Ida y vuelta";
      passCruceros.push(item);
    }

    console.log(`[Scraper] ${pageCruises.length} cruceros encontrados en página ${currentPage} (Total pase: ${passCruceros.length})`);

    // Check pagination boundary
    if (currentPage >= maxPages) {
      hasNextPage = false;
      break;
    }

    // Check if next page exists and is enabled
    const canPaginate = await page.evaluate(() => {
      const nextItem = document.querySelector("li.right-arrow");
      if (!nextItem) return false;

      if (nextItem.classList.contains("disabled") ||
          nextItem.classList.contains("disabled-dots") ||
          nextItem.getAttribute("aria-disabled") === "true") {
        return false;
      }

      const style = window.getComputedStyle(nextItem);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }

      const pageNumbers = Array.from(document.querySelectorAll("li.number"));
      if (pageNumbers.length > 0) {
        const lastNumber = pageNumbers[pageNumbers.length - 1];
        if (lastNumber && lastNumber.classList.contains("active")) {
          return false;
        }
      }

      return !!nextItem.querySelector("a");
    });

    if (!canPaginate) {
      hasNextPage = false;
      break;
    }

    // Capture state before click for reactive transition synchronization
    const previousState = await page.evaluate(() => {
      const activeEl = document.querySelector("li.number.active");
      const activePage = activeEl ? activeEl.textContent.trim() : "";
      const counterEl = document.querySelector(".pagination-wrp__counter");
      const counterText = counterEl ? counterEl.textContent.trim() : "";
      return { activePage, counterText };
    });

    try {
      await page.evaluate(() => {
        const link = document.querySelector("li.right-arrow a");
        if (link) link.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      await new Promise(r => setTimeout(r, 200));
      await page.click("li.right-arrow a");

      // Await reactive Vue DOM change
      await page.waitForFunction(
        (prev) => {
          const currActiveEl = document.querySelector("li.number.active");
          const currActive = currActiveEl ? currActiveEl.textContent.trim() : "";
          if (currActive && currActive !== prev.activePage) return true;

          const currCounterEl = document.querySelector(".pagination-wrp__counter");
          const currCounter = currCounterEl ? currCounterEl.textContent.trim() : "";
          if (currCounter && currCounter !== prev.counterText) return true;

          return false;
        },
        { timeout: 15000 },
        previousState
      );

      await new Promise(r => setTimeout(r, 1000));
      currentPage++;
    } catch (paginationError) {
      console.warn(`[Scraper] Transición de paginación falló o finalizó en página ${currentPage}: ${paginationError.message}`);
      hasNextPage = false;
      break;
    }
  }

  return { cruceros: passCruceros, pagesProcessed: currentPage };
}

/**
 * Standardized scraper entry point conforming to PROJECT.md interface contract.
 *
 * @param {Object} [options={}]
 * @param {boolean} [options.headless=true] - Launch mode (true for background, false for debugging)
 * @param {number} [options.maxPages=Infinity] - Maximum pages to scrape
 * @param {string} [options.customUrl] - Custom search URL (overrides dynamic date URL)
 * @param {Object} [options.filters] - Optional user filters ({ area, embkPort, datePreset, dateFrom, dateTo, cabin, nights })
 * @param {string} [options.outputPath] - Target Excel path (defaults to cruceros_msc.xlsx)
 * @param {string} [options.jsonPath] - Target JSON path (defaults to cruceros_msc.json)
 * @returns {Promise<{
 *   success: boolean,
 *   totalCruceros: number,
 *   xlsxPath: string,
 *   jsonPath: string,
 *   cruceros: Array<Object>,
 *   error?: string
 * }>}
 */
async function createFile(options = {}) {
  const resolvedXlsxPath = path.resolve(options.outputPath || "cruceros_msc.xlsx");
  const resolvedJsonPath = path.resolve(options.jsonPath || "cruceros_msc.json");
  const headless = options.headless !== undefined ? Boolean(options.headless) : true;
  const maxPages = typeof options.maxPages === "number" && options.maxPages > 0 ? options.maxPages : Infinity;
  const filters = options.filters && typeof options.filters === "object" ? options.filters : null;

  let browser = null;
  let page = null;
  let allCruceros = [];
  let currentPage = 1;

  try {
    browser = await launchBrowser({ headless });
    page = await setupPage(browser);

    const combos = filters ? expandFilterCombos(filters) : [null];
    let totalPagesProcessed = 0;
    let succeededPasses = 0;
    const passErrors = [];
    const navOpts = {
      navigationRetries: options.navigationRetries,
      retryDelayMs: options.retryDelayMs
    };

    for (const spec of combos) {
      const searchDates = spec ? resolveSearchDates(spec) : calculateDepartureDates();
      const targetUrl = options.customUrl || buildSearchUrl(searchDates, 1, spec);
      try {
        if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
          if (browser) {
            try { await browser.close(); } catch (_) {}
          }
          browser = await launchBrowser({ headless });
          page = await setupPage(browser);
        }
        const passRes = await scrapeSearchPass(page, targetUrl, spec, maxPages, navOpts);
        allCruceros.push(...passRes.cruceros);
        totalPagesProcessed += passRes.pagesProcessed;
        succeededPasses++;
      } catch (passErr) {
        const errorCode = isConnectionRefusedError(passErr) ? "ECONNREFUSED" : (passErr.code || "SCRAPE_ERROR");
        passErrors.push({ spec, targetUrl, error: formatNetworkError(passErr, targetUrl), errorCode, rawError: passErr });
        console.warn(`[Scraper Pass Error] Falló pase (${spec?.cabin || "default"}): ${passErr.message}`);
      }
    }

    if (succeededPasses === 0 && passErrors.length > 0) {
      const firstErr = passErrors[0];
      const aggErr = new Error(firstErr.error);
      aggErr.code = firstErr.errorCode;
      aggErr.skipScreenshot = isConnectionRefusedError(firstErr.rawError);
      throw aggErr;
    }

    currentPage = Math.max(1, totalPagesProcessed);

    // Serialize JSON Output
    const jsonOutput = {
      total_cruceros: allCruceros.length,
      paginas_procesadas: currentPage,
      fecha_scraping: new Date().toISOString(),
      partial_errors: passErrors.length > 0 ? passErrors.map(({ rawError, ...rest }) => rest) : undefined,
      cruceros: allCruceros
    };
    await fs.promises.writeFile(resolvedJsonPath, JSON.stringify(jsonOutput, null, 2), "utf-8");

    // Generate Excel Report
    await createExcelReport(allCruceros, resolvedXlsxPath);

    return {
      success: true,
      totalCruceros: allCruceros.length,
      xlsxPath: resolvedXlsxPath,
      jsonPath: resolvedJsonPath,
      cruceros: allCruceros,
      partialErrors: passErrors.length > 0 ? passErrors.map(({ rawError, ...rest }) => rest) : undefined
    };
  } catch (error) {
    console.error("[Scraper Error]:", error.message);

    if (page && !error.skipScreenshot && !isConnectionRefusedError(error)) {
      try {
        await page.screenshot({ path: path.resolve(process.cwd(), "error-screenshot.png"), fullPage: true });
      } catch (_) {}
    }

    // Partial results resilience: save files if partial data collected
    if (allCruceros.length > 0) {
      try {
        const jsonOutput = {
          total_cruceros: allCruceros.length,
          paginas_procesadas: currentPage,
          fecha_scraping: new Date().toISOString(),
          error: error.message,
          cruceros: allCruceros
        };
        await fs.promises.writeFile(resolvedJsonPath, JSON.stringify(jsonOutput, null, 2), "utf-8");
        await createExcelReport(allCruceros, resolvedXlsxPath);
        console.log(`[Scraper] Guardados datos parciales (${allCruceros.length} cruceros) tras error.`);
      } catch (saveErr) {
        console.error("[Scraper] Error al guardar resultados parciales:", saveErr);
      }
    }

    return {
      success: false,
      totalCruceros: allCruceros.length,
      xlsxPath: resolvedXlsxPath,
      jsonPath: resolvedJsonPath,
      cruceros: allCruceros,
      errorCode: isConnectionRefusedError(error) ? "ECONNREFUSED" : (error.code || "SCRAPER_ERROR"),
      error: error.message
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
}

// Dual export support: function callable directly, or via properties
createFile.createFile = createFile;
createFile.createExcelReport = createExcelReport;
createFile.calculateDepartureDates = calculateDepartureDates;
createFile.resolveSearchDates = resolveSearchDates;
createFile.buildSearchUrl = buildSearchUrl;
createFile.expandFilterCombos = expandFilterCombos;
createFile.discoverPromoLinks = discoverPromoLinks;
createFile.SUBCATEGORY_URLS = SUBCATEGORY_URLS;
createFile.applySearchFiltersOnPage = applySearchFiltersOnPage;
createFile.dismissCookieBanner = dismissCookieBanner;
createFile.launchBrowser = launchBrowser;
createFile.setupPage = setupPage;
createFile.navigateWithRetry = navigateWithRetry;
createFile.isTransientNetworkError = isTransientNetworkError;
createFile.isConnectionRefusedError = isConnectionRefusedError;
createFile.parsePrice = parsePrice;
createFile.parsePriceString = parsePrice;
createFile.HEADERS = HEADERS;

module.exports = createFile;

// Support direct execution via npm run scrape
if (require.main === module) {
  createFile()
    .then((res) => {
      if (res.success) {
        console.log(`\n✅ Scraping finalizado con éxito: ${res.totalCruceros} cruceros.`);
        console.log(`📁 Excel: ${res.xlsxPath}`);
        console.log(`📁 JSON:  ${res.jsonPath}`);
        process.exit(0);
      } else {
        console.error(`\n⚠️ Scraping finalizó con errores: ${res.error}`);
        process.exit(res.totalCruceros > 0 ? 0 : 1);
      }
    })
    .catch((err) => {
      console.error("\n❌ Error fatal:", err);
      process.exit(1);
    });
}
