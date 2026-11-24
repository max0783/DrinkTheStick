const fs = require("fs");
const path = require("path");
const https = require("https");
const ExcelJS = require("exceljs");
const puppeteer = require("puppeteer");

const COSTA_HEADERS = [
  "Compañía",
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

function resolveCostaSearchDates(filters = {}, baseDate = new Date()) {
  const d = new Date(baseDate);
  if (Number.isNaN(d.getTime())) {
    throw new Error("Invalid baseDate provided to resolveCostaSearchDates");
  }

  let fromDate = new Date(d);
  let toDate = addMonthsClamped(d, 18);

  if (filters && filters.dateFrom && filters.dateTo) {
    const parseDMY = (str) => {
      const parts = String(str).split(/[/.-]/);
      if (parts.length === 3) {
        return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
      }
      return new Date(str);
    };
    const parsedFrom = parseDMY(filters.dateFrom);
    const parsedTo = parseDMY(filters.dateTo);
    if (!Number.isNaN(parsedFrom.getTime()) && !Number.isNaN(parsedTo.getTime())) {
      fromDate = parsedFrom;
      toDate = parsedTo;
    }
  } else {
    const preset = filters && filters.datePreset ? String(filters.datePreset) : "18m";
    if (preset === "6m") {
      toDate = addMonthsClamped(d, 6);
    } else if (preset === "12m") {
      toDate = addMonthsClamped(d, 12);
    } else if (preset === "summer") {
      const year = d.getFullYear();
      if (d.getMonth() <= 2) {
        fromDate = d;
        toDate = new Date(year, 2, 31, 23, 59, 59);
      } else {
        fromDate = new Date(year, 11, 1, 0, 0, 0);
        toDate = new Date(year + 1, 2, 31, 23, 59, 59);
      }
    }
  }

  return {
    fromIso: fromDate.toISOString(),
    toIso: toDate.toISOString(),
    departureDateFrom: formatDateDMY(fromDate),
    departureDateTo: formatDateDMY(toDate)
  };
}

function parseFilterCsv(raw) {
  const arr = Array.isArray(raw)
    ? raw.map((x) => String(x || "").trim())
    : String(raw || "").split(",").map((x) => x.trim());
  return [...new Set(arr.filter(Boolean))];
}

const DESTINATION_MAP = {
  SOA: "SA",
  SA: "SA",
  CAR: "CA",
  CA: "CA",
  MED: "CW OR CE",
  CW: "CW",
  CE: "CE",
  OC: "OC"
};

/**
 * Builds the Solr query URL for Costa Cruceros official search endpoint.
 *
 * @param {Object} [dates]
 * @param {number} [page=1]
 * @param {Object} [filters=null]
 * @param {number} [rows=100]
 * @returns {string}
 */
function buildCostaSearchUrl(dates, page = 1, filters = null, rows = 100) {
  const baseUrl = "https://www.costacruceros.com/search/costa_es_AR/cruisesearch";
  const params = [];

  // Departure date range
  const fromIso = dates?.fromIso || "NOW+2DAYS";
  const toIso = dates?.toIso || "*";
  params.push(`fq={!tag=departTag}departDate:[${encodeURIComponent(fromIso)}%20TO%20${encodeURIComponent(toIso)}]`);

  // Sold out exclusion
  params.push("fq=soldOut:(false)");

  // Price positive
  params.push("fq=(price_USD_anonymous:[1%20TO%20*])");

  // Embarkation ports
  const rawPorts = filters?.embkPort !== undefined ? parseFilterCsv(filters.embkPort) : ["BUE", "MVD"];
  if (rawPorts.length > 0 && !rawPorts.includes("ALL")) {
    const portQuery = rawPorts.map((p) => `\\${p}`).join("%20OR%20");
    params.push(`fq={!tag=embarkTag}embarkPortCode:(${portQuery})`);
  }

  // Destination / Area
  if (filters?.area) {
    const areas = parseFilterCsv(filters.area);
    if (areas.length > 0 && !areas.includes("ALL")) {
      const mapped = areas
        .map((a) => DESTINATION_MAP[a] || a)
        .flatMap((a) => a.split(" OR "))
        .map((c) => `\\${c.trim()}`)
        .join("%20OR%20");
      params.push(`fq=destinationIds:(${mapped})`);
    }
  }

  // Trip type (roundtrip vs oneway)
  if (filters?.tripType === "roundtrip" || filters?.tripType === "RT") {
    params.push("fq=sameEmbarkDisembarkPort:true");
  } else if (filters?.tripType === "oneway" || filters?.tripType === "OW") {
    params.push("fq=sameEmbarkDisembarkPort:false");
  }

  // Duration / Nights
  if (filters?.nights && filters.nights !== "ALL") {
    const nights = String(filters.nights).trim();
    if (nights === "1-5") {
      params.push("fq={!tag=durationTag}duration:([2%20TO%206])");
    } else if (nights === "6-7") {
      params.push("fq={!tag=durationTag}duration:([7%20TO%208])");
    } else if (nights === "8+") {
      params.push("fq={!tag=durationTag}duration:([9%20TO%20*])");
    }
  }

  // Sort and pagination
  params.push("sort=price_USD_anonymous%20asc");
  const actualRows = Number.isInteger(rows) && rows > 0 ? rows : 100;
  const start = Math.max(0, (page - 1) * actualRows);
  params.push(`rows=${actualRows}`);
  if (start > 0) {
    params.push(`start=${start}`);
  }

  return `${baseUrl}?${params.join("&")}`;
}

function buildCostaItineraryUrl(item) {
  if (!item || typeof item !== "object") {
    return "https://www.costacruceros.com/cruceros.html";
  }

  const rawPath = String(item.itineraryPath || "").trim();
  if (rawPath) {
    if (/^https?:\/\//i.test(rawPath)) {
      return rawPath;
    }
    const stripped = rawPath.replace(/^\/content\/costa\/master_website\/[a-z]{2}_[A-Z]{2}/i, "");
    const cleanPath = stripped.startsWith("/") ? stripped : `/${stripped}`;
    return `https://www.costacruceros.com${cleanPath}`;
  }

  const itineraryId = String(item.itineraryId || "").trim();
  const cruiseId = String(item.cruiseId || "").trim();
  if (itineraryId && cruiseId) {
    const shortCruiseId = cruiseId.includes("_") ? cruiseId.split("_")[0] : cruiseId;
    return `https://www.costacruceros.com/cruises/${itineraryId}/${shortCruiseId}.html`;
  }

  return "https://www.costacruceros.com/cruceros.html";
}

function parseCostaSearchResultItem(item, page = 1) {
  if (!item || typeof item !== "object") return null;
  if (item.isSoldOut === true || item.isSellable === false) return null;

  const cruiseId = String(item.cruiseId || `${item.itineraryId || "COSTA"}_${item.departureDate || Date.now()}`).trim();
  const destino = String(item.destinationName || item.destination || "América Del Sur").trim();
  const barco = String(item.shipName || "Costa Cruceros").trim();

  // Duration
  let duracion = "";
  if (item.dayAndNightName) {
    duracion = String(item.dayAndNightName).trim();
  } else if (item.duration) {
    const durNum = Number(item.duration);
    const nights = Math.max(1, durNum - 1);
    duracion = `${durNum} días (${nights} noche${nights > 1 ? "s" : ""})`;
  } else {
    duracion = "No especificada";
  }

  // Ports & Trip Type
  const depPortName = String(item.departurePortName || "Buenos Aires").trim();
  const arrPortName = String(item.arrivalPortName || depPortName).trim();
  const depCode = String(item.departurePortCode || "").trim().toUpperCase();
  const arrCode = String(item.arrivalPortCode || "").trim().toUpperCase();
  const solo_ida = Boolean(depCode && arrCode && depCode !== arrCode);

  let puerto_salida = depPortName;
  if (solo_ida) {
    puerto_salida = `${depPortName} → ${arrPortName} (Solo ida)`;
  }

  // Price
  const rawPrice = item.price_USD_anonymous || item.price_USD_anonymous_MYCRUISE || item.minPrice || 0;
  const priceVal = Math.round(Number(rawPrice));
  const precio = {
    moneda: "USD",
    valor: Number.isFinite(priceVal) && priceVal > 0 ? priceVal : 0
  };

  // Dates
  const fechas_disponibles = [];
  if (item.departureDate) {
    const raw = String(item.departureDate).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const [y, m, d] = raw.slice(0, 10).split('-');
      fechas_disponibles.push(`${d}/${m}/${y}`);
    } else {
      const dt = new Date(raw);
      if (!Number.isNaN(dt.getTime())) {
        fechas_disponibles.push(formatDateDMY(dt));
      }
    }
  }

  // Cabin
  const camarote = String(item.roomTypeName_USD_anonymous || item.roomTypeName || "Interior").trim();

  // Itinerary URL
  const url_itinerario = buildCostaItineraryUrl(item);

  // Promo
  const rawPromo = typeof item.cruiseThematic === "string"
    ? item.cruiseThematic.trim()
    : String(item.cruiseThematic?.text || "").trim();
  const promocion = rawPromo || null;

  return {
    compania: "Costa Cruceros",
    destino,
    duracion,
    barco,
    puerto_salida,
    solo_ida,
    moneda: "USD",
    precio,
    fechas_disponibles,
    promocion,
    url_itinerario,
    pagina: page,
    camarote,
    cruiseId
  };
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
  return /ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_CLOSED|ERR_CONNECTION_FAILED|ETIMEDOUT|ECONNRESET/i.test(msg);
}

/**
 * Performs an HTTPS GET request with JSON parsing and backoff retries.
 *
 * @param {string} url
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
function requestCostaJson(url, options = {}) {
  const maxRetries = Number.isInteger(options.retries) ? options.retries : 2;
  const timeoutMs = options.timeoutMs || 25000;

  return new Promise((resolve, reject) => {
    let attempt = 0;

    const execute = () => {
      const parsedUrl = new URL(url);
      const reqOpts = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "es-AR,es;q=0.9,en;q=0.8"
        },
        timeout: timeoutMs
      };

      const req = https.request(reqOpts, (res) => {
        let rawData = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          rawData += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            const httpErr = new Error(`HTTP Error ${res.statusCode} from Costa: ${rawData.slice(0, 200)}`);
            httpErr.statusCode = res.statusCode;
            return retryOrReject(httpErr);
          }
          try {
            const parsed = JSON.parse(rawData);
            resolve(parsed);
          } catch (jsonErr) {
            retryOrReject(new Error(`Failed to parse Costa JSON response: ${jsonErr.message}`));
          }
        });
      });

      req.on("timeout", () => {
        req.destroy(new Error(`Request to Costa timed out after ${timeoutMs}ms`));
      });

      req.on("error", (err) => {
        retryOrReject(err);
      });

      req.end();
    };

    const retryOrReject = (err) => {
      if (attempt < maxRetries && isTransientNetworkError(err)) {
        attempt++;
        const delay = 600 * Math.pow(2, attempt);
        console.warn(`[Costa Scraper] Reintentando conexión con Costa (${attempt}/${maxRetries}) en ${delay}ms...`);
        setTimeout(execute, delay);
      } else {
        reject(err);
      }
    };

    execute();
  });
}

/**
 * Creates an Excel report file styled for Costa Cruceros or unified reports.
 *
 * @param {Array<Object>} cruceros
 * @param {string} [outputPath='cruceros_costa.xlsx']
 * @returns {Promise<string>}
 */
async function createCostaExcelReport(cruceros = [], outputPath = "cruceros_costa.xlsx") {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "DrinkTheStick Bot";
  workbook.lastModifiedBy = "DrinkTheStick Bot";
  workbook.created = new Date();
  workbook.modified = new Date();

  const worksheet = workbook.addWorksheet("Cruceros Costa", {
    views: [{ showGridLines: true }]
  });

  worksheet.columns = [
    { header: "Compañía", key: "compania", width: 16 },
    { header: "Destino", key: "destino", width: 22 },
    { header: "Duración", key: "duracion", width: 18 },
    { header: "Barco", key: "barco", width: 20 },
    { header: "Puerto de Salida", key: "puerto_salida", width: 30 },
    { header: "Moneda", key: "moneda", width: 10 },
    { header: "Precio", key: "precio", width: 14 },
    { header: "Fechas Disponibles", key: "fechas_disponibles", width: 26 },
    { header: "Promoción", key: "promocion", width: 20 },
    { header: "URL Itinerario", key: "url_itinerario", width: 45 },
    { header: "Página", key: "pagina", width: 10 },
    { header: "Camarote", key: "camarote", width: 20 }
  ];

  // Header style: Costa Blue #003876, White text bold
  const headerRow = worksheet.getRow(1);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF003876" }
    };
    cell.font = {
      name: "Calibri",
      size: 11,
      bold: true,
      color: { argb: "FFFFFFFF" }
    };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = {
      bottom: { style: "medium", color: { argb: "FFFFB300" } }
    };
  });

  const sortedCruises = [...cruceros].sort((a, b) => {
    const pA = a.precio?.valor || 0;
    const pB = b.precio?.valor || 0;
    return pA - pB;
  });

  sortedCruises.forEach((c, idx) => {
    const fechasText = Array.isArray(c.fechas_disponibles)
      ? c.fechas_disponibles.join(", ")
      : String(c.fechas_disponibles || "");
    const precioVal = c.precio?.valor !== undefined ? c.precio.valor : Number(c.precio) || 0;

    const row = worksheet.addRow({
      compania: c.compania || "Costa Cruceros",
      destino: c.destino || "",
      duracion: c.duracion || "",
      barco: c.barco || "",
      puerto_salida: c.puerto_salida || "",
      moneda: c.moneda || c.precio?.moneda || "USD",
      precio: precioVal,
      fechas_disponibles: fechasText,
      promocion: c.promocion || "Estándar",
      url_itinerario: c.url_itinerario || "",
      pagina: c.pagina || 1,
      camarote: c.camarote || "Interior"
    });

    row.height = 20;
    const isEven = idx % 2 === 0;
    row.eachCell((cell, colNumber) => {
      cell.font = { name: "Calibri", size: 10 };
      cell.alignment = { vertical: "middle", horizontal: "left" };
      if (!isEven) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF8FAFC" }
        };
      }
      // Price column formatting
      if (colNumber === 7) {
        cell.numFmt = "$#,##0";
        cell.alignment = { vertical: "middle", horizontal: "right" };
      }
      // Link formatting
      if (colNumber === 10 && c.url_itinerario) {
        cell.value = {
          text: c.url_itinerario,
          hyperlink: c.url_itinerario
        };
        cell.font = { name: "Calibri", size: 10, color: { argb: "FF003876" }, underline: true };
      }
    });
  });

  await worksheet.workbook.xlsx.writeFile(outputPath);
  return path.resolve(outputPath);
}

/**
 * Main scraper entry point for Costa Cruceros.
 *
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
async function createCostaFile(options = {}) {
  const outputPath = options.outputPath || path.resolve(process.cwd(), "cruceros_costa.xlsx");
  const jsonPath = options.jsonPath || path.resolve(process.cwd(), "cruceros_costa.json");
  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : 5;
  const filters = options.filters || {};
  const dates = resolveCostaSearchDates(filters, options.baseDate || new Date());

  const allCruises = [];

  try {
    console.log(`[Costa Scraper] Consultando cruceros Costa (${dates.departureDateFrom} -> ${dates.departureDateTo})...`);

    let page = 1;
    let hasMore = true;

    while (page <= maxPages && hasMore) {
      const url = options.customUrl || buildCostaSearchUrl(dates, page, filters, 50);
      console.log(`[Costa Scraper] Buscando página ${page}: ${url}`);

      const response = await (options.requestFn || requestCostaJson)(url, {
        timeoutMs: options.timeoutMs,
        retries: options.retries
      });

      const searchResults = Array.isArray(response?.searchResults) ? response.searchResults : [];
      if (searchResults.length === 0) {
        hasMore = false;
        break;
      }

      for (const item of searchResults) {
        const parsed = parseCostaSearchResultItem(item, page);
        if (parsed && !allCruises.some((c) => c.cruiseId === parsed.cruiseId)) {
          allCruises.push(parsed);
        }
      }

      if (searchResults.length < 50 || options.customUrl) {
        hasMore = false;
      } else {
        page++;
      }
    }

    // Save Excel
    await (options.excelWriterFn || createCostaExcelReport)(allCruises, outputPath);

    // Save JSON
    const jsonOutput = {
      compania: "Costa Cruceros",
      total_cruceros: allCruises.length,
      fecha_scraping: new Date().toISOString(),
      cruceros: allCruises
    };
    fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), "utf8");

    console.log(`[Costa Scraper] Éxito: ${allCruises.length} cruceros Costa guardados.`);
    return {
      success: true,
      totalCruceros: allCruises.length,
      cruceros: allCruises,
      xlsxPath: path.resolve(outputPath),
      jsonPath: path.resolve(jsonPath)
    };
  } catch (error) {
    console.error(`[Costa Scraper Error]: ${error.message}`);
    return {
      success: false,
      errorCode: isConnectionRefusedError(error) ? "ECONNREFUSED" : "COSTA_SCRAPE_ERROR",
      error: error.message,
      totalCruceros: allCruises.length,
      cruceros: allCruises,
      xlsxPath: path.resolve(outputPath),
      jsonPath: path.resolve(jsonPath)
    };
  }
}

module.exports = {
  COSTA_HEADERS,
  DESTINATION_MAP,
  formatDateDMY,
  addMonthsClamped,
  resolveCostaSearchDates,
  buildCostaSearchUrl,
  buildCostaItineraryUrl,
  parseCostaSearchResultItem,
  isConnectionRefusedError,
  isTransientNetworkError,
  requestCostaJson,
  createCostaExcelReport,
  createCostaFile
};
