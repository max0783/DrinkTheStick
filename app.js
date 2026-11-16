process.env.NTBA_FIX_350 = process.env.NTBA_FIX_350 || '1';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const createFile = require('./msc_scrapper_excel');

const DEFAULT_CRON = '*/15 * * * *';
const DEFAULT_MAX_OFFER_PRICE = 800;
const DEFAULT_MAX_PAGES = Number(process.env.MAX_PAGES) > 0 ? Number(process.env.MAX_PAGES) : 5;

const FILTER_OPTIONS = {
  subcategories: [
    { code: 'ALL', value: '', label: '🌐 Buscador global' },
    { code: 'BF', value: 'black-friday', label: '🔥 Black Friday' },
    { code: 'ROM', value: 'la-romana', label: '🏝 BF La Romana' },
    { code: 'GV', value: 'grand-voyages', label: '🚢 Grand Voyages' },
    { code: 'T27', value: 'temporada-2728', label: '✨ Temp. 27/28' },
    { code: 'YCL', value: 'yacht-club', label: '💎 Promo Yacht Club' },
    { code: 'BR', value: 'brasil', label: '🇧🇷 Promo Brasil' }
  ],
  tripTypes: [
    { code: 'ALL', value: '', label: '🔁 Todos' },
    { code: 'RT', value: 'roundtrip', label: '🔄 Ida y vuelta' },
    { code: 'OW', value: 'oneway', label: '➡️ Solo ida' }
  ],
  areas: [
    { code: 'SOA', label: '🌎 Sudamérica' },
    { code: 'CAR', label: '🏝 Caribe' },
    { code: 'MED', label: '🏛 Mediterráneo' },
    { code: 'ALL', value: '', label: '🌍 Todos' }
  ],
  ports: [
    { code: 'BUE', value: 'BUE', label: '⚓ Buenos Aires' },
    { code: 'MVD', value: 'MVD', label: '⚓ Montevideo' },
    { code: 'BUE,MVD', value: 'BUE,MVD', label: '⚓ BUE + MVD' },
    { code: 'ALL', value: '', label: '🌐 Cualquiera' }
  ],
  dates: [
    { code: '6m', label: '📅 Próx. 6 meses' },
    { code: '12m', label: '📅 Próx. 12 meses' },
    { code: '18m', label: '📅 Próx. 18 meses' },
    { code: 'summer', label: '☀️ Verano próximo' },
    { code: 'custom', label: '✏️ Fecha manual' }
  ],
  cabins: [
    { code: 'ALL', value: '', label: '🛏 Todas' },
    { code: 'INT', value: 'Interior', label: '🚪 Interior' },
    { code: 'SEA', value: 'Vista al mar', label: '🌊 Vista al mar' },
    { code: 'BAL', value: 'Camarote con balcón', label: '🌅 Balcón' },
    { code: 'SUI', value: 'Suite', label: '👑 Suite' },
    { code: 'YCL', value: 'MSC Yacht Club', label: '💎 MSC Yacht Club' }
  ],
  nights: [
    { code: 'ALL', value: '', label: '🌙 Todas' },
    { code: '1-5', value: '1-5', label: '🌙 1 - 5 noches' },
    { code: '6-7', value: '6-7', label: '🌙 6 - 7 noches' },
    { code: '8+', value: '8+', label: '🌙 8+ noches' }
  ],
  prices: [600, 800, 1000, 1200, 1500, 2000, 0]
};

let isJobRunning = false;
let scheduledJob = null;
let bot = null;

function getUsersFilePath(overridePath) {
  return path.resolve(overridePath || path.join(process.cwd(), 'users.json'));
}

function getOffersFilePath(overridePath) {
  return path.resolve(overridePath || path.join(process.cwd(), 'sent_offers.json'));
}

function getMaxOfferPrice(overridePrice) {
  const candidate = overridePrice !== undefined ? overridePrice : process.env.MAX_OFFER_PRICE;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OFFER_PRICE;
}

function getDefaultFilters(overrideMaxPrice) {
  return {
    subcategory: '',
    tripType: '',
    area: 'SOA',
    embkPort: 'BUE,MVD',
    datePreset: '18m',
    dateFrom: '',
    dateTo: '',
    cabin: '',
    nights: '',
    maxPrice: getMaxOfferPrice(overrideMaxPrice)
  };
}

function normalizeFilters(raw = {}, overrideMaxPrice) {
  const defaults = getDefaultFilters(overrideMaxPrice);
  const src = raw && typeof raw === 'object' ? raw : {};

  const validSubcategories = new Set(FILTER_OPTIONS.subcategories.map((s) => s.value));
  const validTripTypes = new Set(FILTER_OPTIONS.tripTypes.map((t) => t.value));
  const validAreas = new Set(['SOA', 'CAR', 'MED', '']);
  const validPorts = new Set(['BUE', 'MVD', 'BUE,MVD', '']);
  const validDates = new Set(['6m', '12m', '18m', 'summer', 'custom']);
  const validCabins = new Set(FILTER_OPTIONS.cabins.map((c) => c.value));
  const validNights = new Set(FILTER_OPTIONS.nights.map((n) => n.value));

  const subRaw = src.subcategory !== undefined ? String(src.subcategory).trim() : '';
  const subcategory = src.subcategory !== undefined && (validSubcategories.has(subRaw) || /^[a-z0-9-]+$/i.test(subRaw))
    ? subRaw
    : defaults.subcategory;
  const tripType = src.tripType !== undefined && validTripTypes.has(String(src.tripType))
    ? String(src.tripType)
    : defaults.tripType;
  const area = src.area !== undefined && validAreas.has(String(src.area)) ? String(src.area) : defaults.area;
  const embkPort = src.embkPort !== undefined && validPorts.has(String(src.embkPort)) ? String(src.embkPort) : defaults.embkPort;
  let datePreset = src.datePreset !== undefined && validDates.has(String(src.datePreset)) ? String(src.datePreset) : defaults.datePreset;
  let dateFrom = typeof src.dateFrom === 'string' ? src.dateFrom.trim() : '';
  let dateTo = typeof src.dateTo === 'string' ? src.dateTo.trim() : '';

  if (datePreset === 'custom' && (!dateFrom || !dateTo)) {
    datePreset = '18m';
    dateFrom = '';
    dateTo = '';
  } else if (datePreset !== 'custom') {
    dateFrom = '';
    dateTo = '';
  }

  const cabin = src.cabin !== undefined && validCabins.has(String(src.cabin)) ? String(src.cabin) : defaults.cabin;
  const nights = src.nights !== undefined && validNights.has(String(src.nights)) ? String(src.nights) : defaults.nights;

  let maxPrice = defaults.maxPrice;
  if (src.maxPrice === 0 || src.maxPrice === '0') {
    maxPrice = 0;
  } else if (src.maxPrice !== undefined && src.maxPrice !== null) {
    const num = Number(src.maxPrice);
    if (Number.isFinite(num) && num > 0) {
      maxPrice = Math.round(num);
    }
  }

  return { subcategory, tripType, area, embkPort, datePreset, dateFrom, dateTo, cabin, nights, maxPrice };
}

function getSearchFilterKey(filters) {
  const f = normalizeFilters(filters);
  return [f.subcategory, f.tripType, f.area, f.embkPort, f.datePreset, f.dateFrom, f.dateTo, f.cabin, f.nights].join('|');
}

function loadJsonArray(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.warn(`[Storage] Error reading ${filePath}:`, err.message);
  }
  return [];
}

function saveJsonArray(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Storage] Error writing ${filePath}:`, err.message);
  }
}

function loadUserRecords(filePath) {
  const raw = loadJsonArray(getUsersFilePath(filePath));
  const seen = new Set();
  const records = [];

  for (const entry of raw) {
    const chatId = entry && typeof entry === 'object' ? entry.chatId : entry;
    if (chatId === undefined || chatId === null || chatId === '') continue;
    const key = String(chatId);
    if (seen.has(key)) continue;
    seen.add(key);

    const rawFilters = entry && typeof entry === 'object' ? entry.filters : {};
    records.push({ chatId, filters: normalizeFilters(rawFilters) });
  }

  return records;
}

function saveUserRecords(records, filePath) {
  const seen = new Set();
  const clean = [];
  for (const entry of records || []) {
    const chatId = entry && typeof entry === 'object' ? entry.chatId : entry;
    if (chatId === undefined || chatId === null || chatId === '') continue;
    const key = String(chatId);
    if (seen.has(key)) continue;
    seen.add(key);

    clean.push({
      chatId,
      filters: normalizeFilters(entry && typeof entry === 'object' ? entry.filters : {})
    });
  }
  saveJsonArray(getUsersFilePath(filePath), clean);
}

function loadUsers(filePath) {
  return loadUserRecords(filePath).map((r) => r.chatId);
}

function saveUsers(users, filePath) {
  const existingMap = new Map(
    loadUserRecords(filePath).map((r) => [String(r.chatId), r.filters])
  );
  const nextRecords = (users || []).map((entry) => {
    if (entry && typeof entry === 'object') return entry;
    return { chatId: entry, filters: existingMap.get(String(entry)) || getDefaultFilters() };
  });
  saveUserRecords(nextRecords, filePath);
}

function getUserFilters(chatId, filePath) {
  const rec = loadUserRecords(filePath).find((r) => String(r.chatId) === String(chatId));
  return rec ? rec.filters : getDefaultFilters();
}

function updateUserFilters(chatId, patch, filePath) {
  const records = loadUserRecords(filePath);
  const idx = records.findIndex((r) => String(r.chatId) === String(chatId));
  const current = idx >= 0 ? records[idx].filters : getDefaultFilters();
  const updated = normalizeFilters({ ...current, ...(patch || {}) });

  if (idx >= 0) {
    records[idx] = { chatId: records[idx].chatId, filters: updated };
    saveUserRecords(records, filePath);
  } else {
    records.push({ chatId, filters: updated });
    saveUserRecords(records, filePath);
  }
  return updated;
}

function resetUserFilters(chatId, filePath) {
  return updateUserFilters(chatId, getDefaultFilters(), filePath);
}

function loadSentOffers(filePath) {
  return loadJsonArray(getOffersFilePath(filePath));
}

function saveSentOffers(offers, filePath) {
  saveJsonArray(getOffersFilePath(filePath), offers);
}

function getOfferPrice(offer) {
  const raw = offer?.precio?.valor !== undefined ? offer.precio.valor : offer?.precio;
  const num = Number(raw);
  return Number.isFinite(num) ? num : NaN;
}

function getOfferDatesText(offer) {
  if (Array.isArray(offer?.fechas_disponibles)) {
    return offer.fechas_disponibles.join(', ');
  }
  return String(offer?.fechas || '');
}

function normalizeItineraryUrl(rawUrl) {
  const urlStr = String(rawUrl || '').trim();
  if (!urlStr) return '';

  const match = urlStr.match(/[?&]cruiseId=([^&#]+)/i);
  if (match) {
    let cruiseId = match[1];
    try {
      cruiseId = decodeURIComponent(cruiseId);
    } catch (_) {
      // Keep raw value if malformed URI sequence
    }
    if (!/\/booking\b/i.test(urlStr)) {
      return `https://www.msccruceros.com.ar/booking?cruiseId=${encodeURIComponent(cruiseId)}&adults=2&children=0&infants=0&juniors=0`;
    }
  }
  return urlStr;
}

function isSameOffer(a, b) {
  return (
    a.destino === b.destino &&
    getOfferPrice(a) === getOfferPrice(b) &&
    String(a.barco) === String(b.barco) &&
    getOfferDatesText(a) === getOfferDatesText(b) &&
    String(a.camarote || 'Todas') === String(b.camarote || 'Todas')
  );
}

function findFilterLabel(list, value) {
  const found = list.find((item) => (item.value !== undefined ? item.value : item.code) === value);
  if (found) return found.label;
  return value ? `🏷 ${value}` : '';
}

function formatPriceFilterLabel(maxPrice) {
  return Number(maxPrice) > 0 ? `USD ${maxPrice}` : 'Sin límite (solo Excel)';
}

function formatDatesFilterLabel(filters) {
  if (filters.datePreset === 'custom' && filters.dateFrom && filters.dateTo) {
    return `${filters.dateFrom} → ${filters.dateTo}`;
  }
  return findFilterLabel(FILTER_OPTIONS.dates, filters.datePreset || '18m');
}

function formatFilterSummary(filters) {
  const f = normalizeFilters(filters);
  const areaLine = f.subcategory
    ? '• Destino / Salida: (catálogo de subcategoría)'
    : `• Destino: ${findFilterLabel(FILTER_OPTIONS.areas, f.area)}\n• Salida: ${findFilterLabel(FILTER_OPTIONS.ports, f.embkPort)}`;

  return (
    `🎛 Tus filtros actuales:\n` +
    `• Subcategoría: ${findFilterLabel(FILTER_OPTIONS.subcategories, f.subcategory)}\n` +
    `• Tipo de viaje: ${findFilterLabel(FILTER_OPTIONS.tripTypes, f.tripType)}\n` +
    `${areaLine}\n` +
    `• Fechas: ${formatDatesFilterLabel(f)}\n` +
    `• Camarote: ${findFilterLabel(FILTER_OPTIONS.cabins, f.cabin)}\n` +
    `• Noches: ${findFilterLabel(FILTER_OPTIONS.nights, f.nights)}\n` +
    `• Precio máx.: ${formatPriceFilterLabel(f.maxPrice)}`
  );
}

function formatShortFilterCaption(filters) {
  const f = normalizeFilters(filters);
  const subLabel = findFilterLabel(FILTER_OPTIONS.subcategories, f.subcategory).replace(/^[^\s]+\s/, '');
  const scopeParts = f.subcategory
    ? [subLabel]
    : [
        findFilterLabel(FILTER_OPTIONS.areas, f.area).replace(/^[^\s]+\s/, ''),
        findFilterLabel(FILTER_OPTIONS.ports, f.embkPort).replace(/^[^\s]+\s/, '')
      ];
  const parts = [
    ...scopeParts,
    f.tripType ? findFilterLabel(FILTER_OPTIONS.tripTypes, f.tripType).replace(/^[^\s]+\s/, '') : 'Ida/Vuelta y Solo ida',
    f.cabin || 'Todas las cabinas',
    f.nights ? `${f.nights} noches` : 'Cualquier duración'
  ];
  return parts.join(' | ');
}

function chunkButtons(buttons, size = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += size) {
    rows.push(buttons.slice(i, i + size));
  }
  return rows;
}

function buildFilterKeyboard(filters, submenu = 'main') {
  const f = normalizeFilters(filters);
  const btn = (text, callback_data) => ({ text, callback_data });

  if (submenu === 'sub') {
    const items = FILTER_OPTIONS.subcategories.map((opt) => {
      const prefix = f.subcategory === opt.value ? '✅ ' : '';
      return btn(`${prefix}${opt.label}`, `flt:sub:${opt.code}`);
    });
    return {
      inline_keyboard: [
        ...chunkButtons(items, 2),
        [btn('🔍 Buscar sublinks de promos', 'flt:discover')],
        [btn('⬅️ Volver', 'flt:menu')]
      ]
    };
  }

  if (submenu === 'trip') {
    const items = FILTER_OPTIONS.tripTypes.map((opt) => {
      const prefix = f.tripType === opt.value ? '✅ ' : '';
      return btn(`${prefix}${opt.label}`, `flt:trip:${opt.code}`);
    });
    return { inline_keyboard: [...chunkButtons(items, 2), [btn('⬅️ Volver', 'flt:menu')]] };
  }

  if (submenu === 'area') {
    const items = FILTER_OPTIONS.areas.map((opt) => {
      const val = opt.value !== undefined ? opt.value : opt.code;
      const prefix = f.area === val ? '✅ ' : '';
      return btn(`${prefix}${opt.label}`, `flt:area:${opt.code}`);
    });
    return { inline_keyboard: [...chunkButtons(items, 2), [btn('⬅️ Volver', 'flt:menu')]] };
  }

  if (submenu === 'port') {
    const items = FILTER_OPTIONS.ports.map((opt) => {
      const prefix = f.embkPort === opt.value ? '✅ ' : '';
      return btn(`${prefix}${opt.label}`, `flt:port:${opt.code}`);
    });
    return { inline_keyboard: [...chunkButtons(items, 2), [btn('⬅️ Volver', 'flt:menu')]] };
  }

  if (submenu === 'date') {
    const items = FILTER_OPTIONS.dates.map((opt) => {
      const prefix = f.datePreset === opt.code ? '✅ ' : '';
      return btn(`${prefix}${opt.label}`, `flt:date:${opt.code}`);
    });
    return { inline_keyboard: [...chunkButtons(items, 2), [btn('⬅️ Volver', 'flt:menu')]] };
  }

  if (submenu === 'cab') {
    const items = FILTER_OPTIONS.cabins.map((opt) => {
      const prefix = f.cabin === opt.value ? '✅ ' : '';
      return btn(`${prefix}${opt.label}`, `flt:cab:${opt.code}`);
    });
    return { inline_keyboard: [...chunkButtons(items, 2), [btn('⬅️ Volver', 'flt:menu')]] };
  }

  if (submenu === 'dur') {
    const items = FILTER_OPTIONS.nights.map((opt) => {
      const prefix = f.nights === opt.value ? '✅ ' : '';
      return btn(`${prefix}${opt.label}`, `flt:dur:${opt.code}`);
    });
    return { inline_keyboard: [...chunkButtons(items, 2), [btn('⬅️ Volver', 'flt:menu')]] };
  }

  if (submenu === 'prc') {
    const items = FILTER_OPTIONS.prices.map((val) => {
      const prefix = f.maxPrice === val ? '✅ ' : '';
      const label = val > 0 ? `USD ${val}` : 'Sin límite';
      return btn(`${prefix}${label}`, `flt:prc:${val}`);
    });
    items.push(btn('✏️ Otro monto', 'flt:prc:CUSTOM'));
    return { inline_keyboard: [...chunkButtons(items, 2), [btn('⬅️ Volver', 'flt:menu')]] };
  }

  return {
    inline_keyboard: [
      [btn('🏷 Subcategoría / Promo', 'flt:open:sub'), btn('🔁 Tipo de viaje', 'flt:open:trip')],
      [btn('🗺 Destino (hacia)', 'flt:open:area'), btn('⚓ Salida (desde)', 'flt:open:port')],
      [btn('📅 Fechas', 'flt:open:date'), btn('🛏 Camarote', 'flt:open:cab')],
      [btn('🌙 Noches', 'flt:open:dur'), btn('💰 Precio máx.', 'flt:open:prc')],
      [btn('📊 Buscar (Excel)', 'flt:run'), btn('🔄 Restablecer', 'flt:reset')]
    ]
  };
}

function parseManualDateRange(text) {
  const matches = String(text || '').match(/(\d{1,2}\/\d{1,2}\/\d{4})/g);
  if (!matches || matches.length < 2) return null;

  const parseDMY = (str) => {
    const [dStr, mStr, yStr] = str.split('/');
    const day = Number(dStr);
    const month = Number(mStr);
    const year = Number(yStr);
    const dt = new Date(year, month - 1, day);
    if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
      return null;
    }
    const pad = (n) => String(n).padStart(2, '0');
    return { date: dt, formatted: `${pad(day)}/${pad(month)}/${year}` };
  };

  const from = parseDMY(matches[0]);
  const to = parseDMY(matches[1]);
  if (!from || !to || from.date > to.date) return null;

  return { dateFrom: from.formatted, dateTo: to.formatted };
}

function parseManualPrice(text) {
  const cleaned = String(text || '').trim().replace(/[^\d.,]/g, '');
  if (!cleaned) return null;
  let numeric = cleaned;
  if (/\d\.\d{3}/.test(cleaned)) {
    numeric = cleaned.replace(/\./g, '').replace(/,/g, '.');
  } else {
    numeric = cleaned.replace(/,/g, '');
  }
  const value = Math.round(Number(numeric));
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function runReportCycle(options = {}) {
  if (isJobRunning) {
    console.warn('[Mutex] Scraper job is already running. Skipping overlapping run.');
    return { success: false, skipped: true, reason: 'JOB_ALREADY_RUNNING' };
  }

  isJobRunning = true;
  const tempFilesToClean = [];

  try {
    const scraper = options.scraperFn || createFile;
    const currentBot = options.bot || bot;
    const usersPath = getUsersFilePath(options.usersFilePath);
    const offersPath = getOffersFilePath(options.sentOffersFilePath);
    const userRecords = loadUserRecords(usersPath);
    const recordById = new Map(userRecords.map((r) => [String(r.chatId), r]));
    const hasExplicitPriceOverride = options.maxOfferPrice !== undefined;
    const isTargetedRun = Array.isArray(options.targetChatIds);

    const targets = isTargetedRun
      ? [...new Set(options.targetChatIds)].map((chatId) => {
          const rec = recordById.get(String(chatId));
          const baseFilters = options.filtersOverride
            ? normalizeFilters(options.filtersOverride, options.maxOfferPrice)
            : (rec ? rec.filters : getDefaultFilters(options.maxOfferPrice));
          const effectiveFilters = hasExplicitPriceOverride
            ? { ...baseFilters, maxPrice: getMaxOfferPrice(options.maxOfferPrice) }
            : baseFilters;
          return { chatId, filters: effectiveFilters };
        })
      : userRecords.map((rec) => ({
          chatId: rec.chatId,
          filters: hasExplicitPriceOverride
            ? { ...rec.filters, maxPrice: getMaxOfferPrice(options.maxOfferPrice) }
            : rec.filters
        }));

    // Group targets by identical scrape parameters so shared filters run only once
    const groupsMap = new Map();
    const hasCustomUrl = Boolean(options.scraperOptions && options.scraperOptions.customUrl);

    if (targets.length === 0) {
      groupsMap.set('default', {
        filters: getDefaultFilters(options.maxOfferPrice),
        members: []
      });
    } else {
      for (const target of targets) {
        const key = hasCustomUrl ? '__CUSTOM__' : getSearchFilterKey(target.filters);
        if (!groupsMap.has(key)) {
          groupsMap.set(key, { filters: target.filters, members: [] });
        }
        groupsMap.get(key).members.push(target);
      }
    }

    const groups = Array.from(groupsMap.values());
    let totalCruceros = 0;
    let documentsSent = 0;
    let offersSent = 0;
    let lastXlsxPath = path.resolve(process.cwd(), 'cruceros_msc.xlsx');

    let sentOffers = loadSentOffers(offersPath);
    const activeBroadcastOffers = [];

    console.log(`[ReportCycle] Starting scraper run (${groups.length} filter group(s)) at ${new Date().toISOString()}...`);

    for (let idx = 0; idx < groups.length; idx++) {
      const group = groups[idx];
      const baseScraperOptions = options.scraperOptions || {};
      const scraperOpts = {
        maxPages: DEFAULT_MAX_PAGES,
        ...baseScraperOptions,
        filters: baseScraperOptions.filters || group.filters
      };

      if (groups.length > 1 && !baseScraperOptions.outputPath && idx > 0) {
        const tmpBase = path.join(os.tmpdir(), `dts_grp_${idx}_${Date.now()}`);
        scraperOpts.outputPath = `${tmpBase}.xlsx`;
        scraperOpts.jsonPath = `${tmpBase}.json`;
        tempFilesToClean.push(scraperOpts.outputPath, scraperOpts.jsonPath);
      }

      const scrapeResult = await scraper(scraperOpts);
      if (!scrapeResult || scrapeResult.success === false) {
        throw new Error((scrapeResult && scrapeResult.error) || 'Scraping failed');
      }

      const xlsxPath = scrapeResult.xlsxPath || path.resolve(process.cwd(), 'cruceros_msc.xlsx');
      if (!fs.existsSync(xlsxPath) || fs.statSync(xlsxPath).size === 0) {
        throw new Error(`Excel report missing or empty at ${xlsxPath}`);
      }

      lastXlsxPath = xlsxPath;
      totalCruceros += scrapeResult.totalCruceros || 0;

      const cruceros = Array.isArray(scrapeResult.cruceros) ? scrapeResult.cruceros : [];
      const mappedOffers = cruceros.map((c) => ({
        destino: c.destino,
        duracion: c.duracion,
        barco: c.barco,
        precio: getOfferPrice(c),
        moneda: c.precio?.moneda || 'USD',
        fechas: getOfferDatesText(c),
        url: normalizeItineraryUrl(c.url_itinerario || c.url || ''),
        puerto: c.puerto_salida || c.puerto || 'No especificado',
        camarote: c.camarote || group.filters.cabin || 'Todas',
        page: c.pagina || 1
      }));

      activeBroadcastOffers.push(...mappedOffers);

      if (!currentBot || group.members.length === 0) continue;

      const todayStr = new Date().toLocaleDateString('es-AR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
      const fileOptions = options.fileOptions || {
        filename: `cruceros_msc_${new Date().toISOString().slice(0, 10)}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      };

      for (const member of group.members) {
        const chatId = member.chatId;
        const maxPrice = member.filters.maxPrice;
        const matchingOffers = maxPrice > 0
          ? mappedOffers.filter((o) => Number.isFinite(o.precio) && o.precio > 0 && o.precio <= maxPrice)
          : [];

        if (typeof currentBot.sendDocument === 'function' && options.sendDocument === true) {
          const budgetLine = maxPrice > 0
            ? `\n💰 Con precio ≤ $${maxPrice} USD: ${matchingOffers.length}`
            : '';
          const caption = options.caption ||
            `📊 Reporte MSC Cruceros - ${todayStr}\n🎛 ${formatShortFilterCaption(member.filters)}\n🚢 Total encontrados: ${scrapeResult.totalCruceros || 0}${budgetLine}`;

          try {
            await currentBot.sendDocument(chatId, xlsxPath, { caption }, fileOptions);
            documentsSent++;
          } catch (err) {
            console.error(`[ReportCycle] Error sending Excel to chat ${chatId}:`, err.message);
          }
        }

        let userNewOffersCount = 0;
        if (options.sendOffers !== false && typeof currentBot.sendMessage === 'function' && maxPrice > 0) {
          for (const offer of matchingOffers) {
            const existing = sentOffers.find((so) => isSameOffer(so, offer));
            const alreadySentToUser = existing
              ? (Array.isArray(existing.chatIds) ? existing.chatIds.includes(chatId) : true)
              : false;

            if (alreadySentToUser) continue;

            const msg =
              `¡Nueva oferta encontrada!\n\n` +
              `🚢 Destino: ${offer.destino}\n` +
              `⏱ Duración: ${offer.duracion}\n` +
              `🛳 Barco: ${offer.barco}\n` +
              `🌊 Puerto de salida: ${offer.puerto}\n` +
              `🛏 Camarote: ${offer.camarote}\n` +
              `💰 Precio: ${offer.precio} ${offer.moneda}\n` +
              `📅 Fechas disponibles: ${offer.fechas}\n` +
              `🔗 Ver más: ${offer.url}`;

            try {
              await currentBot.sendMessage(chatId, msg);
              offersSent++;
              userNewOffersCount++;

              if (existing) {
                if (!Array.isArray(existing.chatIds)) existing.chatIds = [];
                if (!existing.chatIds.includes(chatId)) existing.chatIds.push(chatId);
              } else {
                sentOffers.push({ ...offer, chatIds: [chatId] });
              }
            } catch (err) {
              console.error(`[ReportCycle] Error sending offer to chat ${chatId}:`, err.message);
            }
          }
        }

        if (options.notifyManualSummary && typeof currentBot.sendMessage === 'function' && userNewOffersCount === 0) {
          const infoMsg = maxPrice > 0
            ? (matchingOffers.length === 0
                ? `ℹ️ Búsqueda finalizada: ${scrapeResult.totalCruceros || 0} cruceros encontrados, pero ninguno por debajo de USD ${maxPrice}. Revisa el Excel o ajusta el precio en /filtros.`
                : `ℹ️ Búsqueda finalizada: ${matchingOffers.length} ofertas ≤ USD ${maxPrice} (ya te las había enviado antes; mira el Excel actualizado arriba).`)
            : `ℹ️ Búsqueda finalizada: ${scrapeResult.totalCruceros || 0} cruceros cargados en el Excel (tenés Precio máx. en "Sin límite").`;
          await currentBot.sendMessage(chatId, infoMsg).catch(() => {});
        }
      }
    }

    // In full broadcast runs, prune offers that are no longer active under any group
    if (!isTargetedRun && activeBroadcastOffers.length >= 0 && targets.length > 0 && options.sendOffers !== false) {
      const anyMaxPrice = Math.max(0, ...targets.map((t) => Number(t.filters.maxPrice) || 0));
      sentOffers = sentOffers.filter((so) =>
        activeBroadcastOffers.some((co) =>
          isSameOffer(co, so) && (anyMaxPrice === 0 || getOfferPrice(co) <= anyMaxPrice)
        )
      );
      saveSentOffers(sentOffers, offersPath);
    } else if (targets.length > 0 && options.sendOffers !== false) {
      saveSentOffers(sentOffers, offersPath);
    }

    return {
      success: true,
      totalCruceros,
      recipientsCount: targets.length,
      documentsSent,
      offersSent,
      xlsxPath: lastXlsxPath
    };
  } catch (error) {
    console.error('[ReportCycle Error]:', error.message);
    return {
      success: false,
      error: error.message
    };
  } finally {
    for (const filePath of tempFilesToClean) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) {}
    }
    isJobRunning = false;
  }
}

function startScheduler(cronExpr = process.env.SCHEDULE_CRON || DEFAULT_CRON, cycleOptions = {}) {
  const expr = String(cronExpr || DEFAULT_CRON).trim() || DEFAULT_CRON;
  const scheduledOptions = { sendDocument: false, ...cycleOptions };
  scheduledJob = schedule.scheduleJob(expr, async () => {
    console.log(`[Scheduler] Triggered cycle at ${new Date().toISOString()}`);
    await runReportCycle(scheduledOptions);
  });

  if (!scheduledJob) {
    console.warn(`[Scheduler] Invalid cron expression '${expr}', falling back to '${DEFAULT_CRON}'`);
    scheduledJob = schedule.scheduleJob(DEFAULT_CRON, async () => {
      console.log(`[Scheduler] Triggered fallback cycle at ${new Date().toISOString()}`);
      await runReportCycle(scheduledOptions);
    });
  }

  return scheduledJob;
}

function stopScheduler() {
  if (scheduledJob) {
    try {
      scheduledJob.cancel();
    } catch (_) {}
    scheduledJob = null;
  }
}

async function safeAnswerCallback(botInstance, queryId, text) {
  if (!queryId || typeof botInstance.answerCallbackQuery !== 'function') return;
  try {
    await botInstance.answerCallbackQuery(queryId, text ? { text } : {});
  } catch (_) {}
}

async function safeEditMessage(botInstance, chatId, messageId, text, replyMarkup) {
  const opts = replyMarkup ? { reply_markup: replyMarkup } : {};
  if (messageId && typeof botInstance.editMessageText === 'function') {
    try {
      return await botInstance.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...opts
      });
    } catch (err) {
      if (/message is not modified/i.test(err.message || '')) return null;
    }
  }
  return botInstance.sendMessage(chatId, text, opts);
}

const SUBMENU_TITLES = {
  main: '⚙️ Configuración de filtros MSC Cruceros',
  sub: '🏷 Elige subcategoría o promoción de MSC (o Buscador global para usar Destino y Salida):',
  trip: '🔁 Selecciona tipo de itinerario (Ida y vuelta vs Solo ida):',
  area: '🗺 Selecciona el destino (hacia):',
  port: '⚓ Selecciona puerto de salida (desde):',
  date: '📅 Selecciona rango de fechas:',
  cab: '🛏 Selecciona categoría de camarote:',
  dur: '🌙 Selecciona duración en noches:',
  prc: '💰 Selecciona precio máximo para alertas (USD):'
};

function registerBotHandlers(botInstance, options = {}) {
  const usersPath = options.usersFilePath;
  const offersPath = options.sentOffersFilePath;
  const discoverFn = options.discoverPromoLinksFn || createFile.discoverPromoLinks;
  const pendingInputs = new Map();
  let discoveredPromos = [];

  const sendFilterMenu = async (chatId, messageId = null, submenu = 'main', prefix = '') => {
    const filters = getUserFilters(chatId, usersPath);
    const title = SUBMENU_TITLES[submenu] || SUBMENU_TITLES.main;
    const text = `${prefix ? `${prefix}\n\n` : ''}${title}\n\n${formatFilterSummary(filters)}`;
    const keyboard = buildFilterKeyboard(filters, submenu);
    return safeEditMessage(botInstance, chatId, messageId, text, keyboard);
  };

  const handleDiscoverPromos = async (chatId) => {
    await botInstance.sendMessage(chatId, '🔍 Buscando sublinks activos de promociones en MSC...');
    const res = await discoverFn();
    if (!res || res.success === false || !Array.isArray(res.links) || res.links.length === 0) {
      await botInstance.sendMessage(
        chatId,
        '❌ No se encontraron sublinks de promociones activos en este momento. Podés intentar nuevamente más tarde o usar el Buscador global en /filtros.'
      );
      return;
    }

    discoveredPromos = res.links.slice(0, 20);
    const currentSub = getUserFilters(chatId, usersPath).subcategory;

    let text = `🏷 Sublinks de promociones encontrados en MSC (${discoveredPromos.length}):\n\n`;
    const promoButtons = discoveredPromos.map((item, idx) => {
      text += `${idx + 1}. ${item.label}\n   🔗 ${item.url}\n`;
      const prefix = currentSub === item.slug ? '✅ ' : '';
      const shortLabel = item.label.length > 26 ? `${item.label.slice(0, 24)}…` : item.label;
      return { text: `${prefix}${shortLabel}`, callback_data: `flt:disc:${idx}` };
    });
    text += `\nTocá cualquiera para usarlo como tu filtro de Subcategoría:`;

    const reply_markup = {
      inline_keyboard: [
        ...chunkButtons(promoButtons, 2),
        [{ text: '⬅️ Volver a filtros', callback_data: 'flt:menu' }]
      ]
    };

    await botInstance.sendMessage(chatId, text, {
      disable_web_page_preview: true,
      reply_markup
    });
  };

  const handleOffersCommand = async (chatId) => {
    const userFilters = getUserFilters(chatId, usersPath);
    const maxPrice = options.maxOfferPrice !== undefined
      ? getMaxOfferPrice(options.maxOfferPrice)
      : userFilters.maxPrice;
    const allSent = loadSentOffers(offersPath);
    const activeForUser = maxPrice > 0
      ? allSent.filter((o) => {
          const p = getOfferPrice(o);
          return Number.isFinite(p) && p > 0 && p <= maxPrice;
        })
      : allSent;

    if (activeForUser.length === 0) {
      const limitText = maxPrice > 0
        ? `menores o iguales a $${maxPrice} USD`
        : 'registradas todavía';
      await botInstance.sendMessage(
        chatId,
        `❌ No hay ofertas activas ${limitText} en este momento.`
      );
      return;
    }

    const header = maxPrice > 0
      ? `📢 Ofertas actuales menores o iguales a $${maxPrice} USD:\n\n`
      : `📢 Ofertas registradas actualmente:\n\n`;
    let currentChunk = header;

    for (let index = 0; index < Math.min(activeForUser.length, 15); index++) {
      const offer = activeForUser[index];
      const priceVal = getOfferPrice(offer);
      const cur = offer.moneda || offer.precio?.moneda || 'USD';
      const port = offer.puerto || offer.puerto_salida || 'No especificado';
      const cabin = offer.camarote || 'Todas';
      const datesText = getOfferDatesText(offer);
      const link = normalizeItineraryUrl(offer.url || offer.url_itinerario || '');

      const block =
        `${index + 1}. ${offer.destino}\n` +
        `   💰 Precio: ${priceVal} ${cur}\n` +
        `   ⏱ Duración: ${offer.duracion} | 🛏 ${cabin}\n` +
        `   🛳 Barco: ${offer.barco}\n` +
        `   🌊 Puerto: ${port}\n` +
        (datesText ? `   📅 Fechas: ${datesText}\n` : '') +
        (link ? `   🔗 Ver más: ${link}\n` : '') +
        `\n`;

      if (currentChunk.length + block.length > 3600) {
        await botInstance.sendMessage(chatId, currentChunk, { disable_web_page_preview: true });
        currentChunk = '';
      }
      currentChunk += block;
    }

    if (currentChunk) {
      await botInstance.sendMessage(chatId, currentChunk, { disable_web_page_preview: true });
    }
  };

  const triggerManualSearch = async (chatId) => {
    if (isJobRunning) {
      await botInstance.sendMessage(chatId, '⏳ Un reporte ya está en proceso de generación. Por favor aguardá.');
      return;
    }
    const filters = getUserFilters(chatId, usersPath);
    await botInstance.sendMessage(
      chatId,
      `🔎 Buscando cruceros con tus filtros...\n🎛 ${formatShortFilterCaption(filters)}`
    );
    await runReportCycle({
      bot: botInstance,
      targetChatIds: [chatId],
      usersFilePath: usersPath,
      sentOffersFilePath: offersPath,
      scraperFn: options.scraperFn,
      maxOfferPrice: options.maxOfferPrice,
      sendDocument: true,
      notifyManualSummary: true
    });
  };

  botInstance.on('polling_error', (error) => {
    console.error(`[Telegram Polling Error] Code: ${error.code || 'UNKNOWN'}, Message: ${error.message}`);
    if (error.response && error.response.statusCode === 401 && typeof botInstance.stopPolling === 'function') {
      console.error('[Telegram Fatal] Unauthorized token. Stopping polling.');
      botInstance.stopPolling().catch(() => {});
    }
  });

  botInstance.onText(/^\/start/, async (msg) => {
    const chatId = msg?.chat?.id;
    if (chatId === undefined || chatId === null) return;
    pendingInputs.delete(String(chatId));

    try {
      const records = loadUserRecords(usersPath);
      const existing = records.find((r) => String(r.chatId) === String(chatId));
      const quickKeyboard = {
        inline_keyboard: [
          [
            { text: '⚙️ Configurar filtros', callback_data: 'flt:menu' },
            { text: '📊 Buscar (Excel)', callback_data: 'flt:run' }
          ],
          [{ text: '📢 Ver ofertas', callback_data: 'flt:offers' }]
        ]
      };

      if (!existing) {
        const defaults = getDefaultFilters(options.maxOfferPrice);
        records.push({ chatId, filters: defaults });
        saveUserRecords(records, usersPath);

        await botInstance.sendMessage(
          chatId,
          `¡Te has registrado para recibir alertas de ofertas de cruceros! Te avisaré cuando encuentre ofertas menores o iguales a $${defaults.maxPrice} USD.\n\nUsa /filtros para personalizar destino, salida, fechas, camarote o precio, y /report (o el botón "📊 Buscar (Excel)") cuando quieras recibir el archivo Excel.`,
          { reply_markup: quickKeyboard }
        );

        await runReportCycle({
          bot: botInstance,
          targetChatIds: [chatId],
          usersFilePath: usersPath,
          sentOffersFilePath: offersPath,
          scraperFn: options.scraperFn,
          maxOfferPrice: options.maxOfferPrice,
          sendDocument: false
        });
      } else {
        await botInstance.sendMessage(
          chatId,
          `Ya estás registrado para recibir notificaciones.\n\n${formatFilterSummary(existing.filters)}`,
          { reply_markup: quickKeyboard }
        );
      }
    } catch (err) {
      console.error('[Command Error /start]:', err.message);
    }
  });

  botInstance.onText(/^\/stop/, async (msg) => {
    const chatId = msg?.chat?.id;
    if (chatId === undefined || chatId === null) return;
    pendingInputs.delete(String(chatId));

    try {
      const records = loadUserRecords(usersPath).filter((r) => String(r.chatId) !== String(chatId));
      saveUserRecords(records, usersPath);
      await botInstance.sendMessage(chatId, 'Te has dado de baja de las notificaciones de ofertas.');
    } catch (err) {
      console.error('[Command Error /stop]:', err.message);
    }
  });

  botInstance.onText(/^\/(filtros|menu)/, async (msg) => {
    const chatId = msg?.chat?.id;
    if (chatId === undefined || chatId === null) return;
    pendingInputs.delete(String(chatId));

    try {
      await sendFilterMenu(chatId, null, 'main');
    } catch (err) {
      console.error('[Command Error /filtros]:', err.message);
    }
  });

  botInstance.onText(/^\/promos/, async (msg) => {
    const chatId = msg?.chat?.id;
    if (chatId === undefined || chatId === null) return;
    pendingInputs.delete(String(chatId));

    try {
      await handleDiscoverPromos(chatId);
    } catch (err) {
      console.error('[Command Error /promos]:', err.message);
    }
  });

  botInstance.onText(/^\/report/, async (msg) => {
    const chatId = msg?.chat?.id;
    if (chatId === undefined || chatId === null) return;
    pendingInputs.delete(String(chatId));

    try {
      if (isJobRunning) {
        await botInstance.sendMessage(chatId, '⏳ Un reporte ya está en proceso de generación. Por favor aguardá.');
        return;
      }
      await botInstance.sendMessage(chatId, '🚀 Iniciando generación de reporte...');
      await runReportCycle({
        bot: botInstance,
        targetChatIds: [chatId],
        usersFilePath: usersPath,
        sentOffersFilePath: offersPath,
        scraperFn: options.scraperFn,
        maxOfferPrice: options.maxOfferPrice,
        sendDocument: true
      });
    } catch (err) {
      console.error('[Command Error /report]:', err.message);
    }
  });

  botInstance.onText(/^\/offers/, async (msg) => {
    const chatId = msg?.chat?.id;
    if (chatId === undefined || chatId === null) return;
    pendingInputs.delete(String(chatId));

    try {
      await handleOffersCommand(chatId);
    } catch (err) {
      console.error('[Command Error /offers]:', err.message);
    }
  });

  botInstance.on('callback_query', async (query) => {
    const chatId = query?.message?.chat?.id;
    const messageId = query?.message?.message_id;
    const data = String(query?.data || '');
    if (chatId === undefined || chatId === null || !data.startsWith('flt:')) return;

    try {
      const parts = data.split(':');
      const action = parts[1];
      const value = parts.slice(2).join(':');

      if (action === 'menu') {
        pendingInputs.delete(String(chatId));
        await safeAnswerCallback(botInstance, query.id);
        await sendFilterMenu(chatId, messageId, 'main');
        return;
      }

      if (action === 'cancel_input') {
        pendingInputs.delete(String(chatId));
        await safeAnswerCallback(botInstance, query.id, 'Cancelado');
        await sendFilterMenu(chatId, messageId, 'main');
        return;
      }

      if (action === 'open') {
        pendingInputs.delete(String(chatId));
        await safeAnswerCallback(botInstance, query.id);
        await sendFilterMenu(chatId, messageId, value || 'main');
        return;
      }

      if (action === 'sub') {
        const opt = FILTER_OPTIONS.subcategories.find((s) => s.code === value);
        const subcategory = opt ? opt.value : '';
        updateUserFilters(chatId, { subcategory }, usersPath);
        await safeAnswerCallback(botInstance, query.id, `Subcategoría: ${opt ? opt.label : 'Global'}`);
        await sendFilterMenu(chatId, messageId, 'main');
        return;
      }

      if (action === 'discover') {
        await safeAnswerCallback(botInstance, query.id, 'Buscando promos en MSC...');
        await handleDiscoverPromos(chatId);
        return;
      }

      if (action === 'disc') {
        const idx = Number(value);
        const item = Number.isInteger(idx) ? discoveredPromos[idx] : null;
        if (!item) {
          await safeAnswerCallback(botInstance, query.id, 'Lista vencida, vuelve a buscar');
          await handleDiscoverPromos(chatId);
          return;
        }
        updateUserFilters(chatId, { subcategory: item.slug }, usersPath);
        await safeAnswerCallback(botInstance, query.id, `Seleccionado: ${item.label}`);
        await sendFilterMenu(chatId, null, 'main', `✅ Subcategoría seleccionada: ${item.label}\n🔗 ${item.url}`);
        return;
      }

      if (action === 'trip') {
        const opt = FILTER_OPTIONS.tripTypes.find((t) => t.code === value);
        const tripType = opt ? opt.value : '';
        updateUserFilters(chatId, { tripType }, usersPath);
        await safeAnswerCallback(botInstance, query.id, `Tipo: ${opt ? opt.label : 'Todos'}`);
        await sendFilterMenu(chatId, messageId, 'main');
        return;
      }

      if (action === 'area') {
        const opt = FILTER_OPTIONS.areas.find((a) => a.code === value);
        const area = opt ? (opt.value !== undefined ? opt.value : opt.code) : 'SOA';
        updateUserFilters(chatId, { area, subcategory: '' }, usersPath);
        await safeAnswerCallback(botInstance, query.id, `Destino: ${opt ? opt.label : area}`);
        await sendFilterMenu(chatId, messageId, 'main');
        return;
      }

      if (action === 'port') {
        const opt = FILTER_OPTIONS.ports.find((p) => p.code === value);
        const embkPort = opt ? opt.value : 'BUE,MVD';
        updateUserFilters(chatId, { embkPort, subcategory: '' }, usersPath);
        await safeAnswerCallback(botInstance, query.id, `Salida: ${opt ? opt.label : embkPort}`);
        await sendFilterMenu(chatId, messageId, 'main');
        return;
      }

      if (action === 'date') {
        if (value === 'custom') {
          pendingInputs.set(String(chatId), 'date');
          await safeAnswerCallback(botInstance, query.id);
          await botInstance.sendMessage(
            chatId,
            '📅 Escribe el rango de fechas deseado en formato:\nDD/MM/AAAA - DD/MM/AAAA\n\nEjemplo: 01/12/2026 - 31/03/2027',
            { reply_markup: { inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'flt:cancel_input' }]] } }
          );
          return;
        }
        updateUserFilters(chatId, { datePreset: value, dateFrom: '', dateTo: '' }, usersPath);
        await safeAnswerCallback(botInstance, query.id, 'Fechas actualizadas');
        await sendFilterMenu(chatId, messageId, 'main');
        return;
      }

      if (action === 'cab') {
        const opt = FILTER_OPTIONS.cabins.find((c) => c.code === value);
        const cabin = opt ? opt.value : '';
        updateUserFilters(chatId, { cabin }, usersPath);
        await safeAnswerCallback(botInstance, query.id, `Camarote: ${cabin || 'Todas'}`);
        await sendFilterMenu(chatId, messageId, 'main');
        return;
      }

      if (action === 'dur') {
        const opt = FILTER_OPTIONS.nights.find((n) => n.code === value);
        const nights = opt ? opt.value : '';
        updateUserFilters(chatId, { nights }, usersPath);
        await safeAnswerCallback(botInstance, query.id, `Noches: ${nights || 'Todas'}`);
        await sendFilterMenu(chatId, messageId, 'main');
        return;
      }

      if (action === 'prc') {
        if (value === 'CUSTOM') {
          pendingInputs.set(String(chatId), 'price');
          await safeAnswerCallback(botInstance, query.id);
          await botInstance.sendMessage(
            chatId,
            '💰 Escribe el precio máximo en USD (solo número).\n\nEjemplo: 1150',
            { reply_markup: { inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'flt:cancel_input' }]] } }
          );
          return;
        }
        const maxPrice = Number(value);
        updateUserFilters(chatId, { maxPrice: Number.isFinite(maxPrice) && maxPrice >= 0 ? maxPrice : DEFAULT_MAX_OFFER_PRICE }, usersPath);
        await safeAnswerCallback(botInstance, query.id, maxPrice > 0 ? `Precio máx.: USD ${maxPrice}` : 'Precio máx.: Sin límite');
        await sendFilterMenu(chatId, messageId, 'main');
        return;
      }

      if (action === 'reset') {
        pendingInputs.delete(String(chatId));
        resetUserFilters(chatId, usersPath);
        await safeAnswerCallback(botInstance, query.id, 'Filtros restablecidos');
        await sendFilterMenu(chatId, messageId, 'main', '🔄 Filtros restablecidos a valores iniciales.');
        return;
      }

      if (action === 'run') {
        await safeAnswerCallback(botInstance, query.id, isJobRunning ? 'Hay una búsqueda en curso' : 'Iniciando búsqueda...');
        await triggerManualSearch(chatId);
        return;
      }

      if (action === 'offers') {
        await safeAnswerCallback(botInstance, query.id);
        await handleOffersCommand(chatId);
      }
    } catch (err) {
      console.error('[Callback Error]:', err.message);
      await safeAnswerCallback(botInstance, query.id, 'Error al procesar acción');
    }
  });

  botInstance.on('message', async (msg) => {
    const chatId = msg?.chat?.id;
    const text = msg?.text;
    if (chatId === undefined || chatId === null || typeof text !== 'string') return;
    if (text.trim().startsWith('/')) return;

    const mode = pendingInputs.get(String(chatId));
    if (!mode) return;

    try {
      if (mode === 'date') {
        const range = parseManualDateRange(text);
        if (!range) {
          await botInstance.sendMessage(
            chatId,
            '❌ Formato de fechas inválido. Usa: DD/MM/AAAA - DD/MM/AAAA (con fecha inicial menor o igual a la final).\nEjemplo: 01/12/2026 - 31/03/2027',
            { reply_markup: { inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'flt:cancel_input' }]] } }
          );
          return;
        }
        pendingInputs.delete(String(chatId));
        updateUserFilters(chatId, { datePreset: 'custom', ...range }, usersPath);
        await sendFilterMenu(chatId, null, 'main', `✅ Rango guardado: ${range.dateFrom} → ${range.dateTo}`);
        return;
      }

      if (mode === 'price') {
        const price = parseManualPrice(text);
        if (!price) {
          await botInstance.sendMessage(
            chatId,
            '❌ Ingresa un monto válido en USD mayor a 0.\nEjemplo: 1150',
            { reply_markup: { inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'flt:cancel_input' }]] } }
          );
          return;
        }
        pendingInputs.delete(String(chatId));
        updateUserFilters(chatId, { maxPrice: price }, usersPath);
        await sendFilterMenu(chatId, null, 'main', `✅ Precio máximo guardado: USD ${price}`);
      }
    } catch (err) {
      console.error('[Message Input Error]:', err.message);
    }
  });

  return botInstance;
}

function initBot(token = (process.env.TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(), options = {}) {
  if (!token) {
    throw new Error('[Config Error] Telegram bot token is missing.');
  }

  bot = new TelegramBot(token, { polling: options.polling !== undefined ? options.polling : true });
  if (typeof bot.setMyCommands === 'function') {
    bot.setMyCommands([
      { command: 'filtros', description: 'Configurar destino, salida, fechas, camarote y precio' },
      { command: 'promos', description: 'Encontrar sublinks activos de promociones MSC' },
      { command: 'report', description: 'Generar y recibir Excel ahora (on-demand)' },
      { command: 'offers', description: 'Ver ofertas activas con enlaces según tu presupuesto' },
      { command: 'start', description: 'Suscribirse a alertas automáticas' },
      { command: 'stop', description: 'Cancelar suscripción' }
    ]).catch(() => {});
  }
  return registerBotHandlers(bot, options);
}

async function gracefulShutdown(signal = 'SIGINT') {
  console.log(`[Shutdown] Received ${signal}. Starting graceful shutdown...`);
  stopScheduler();

  if (bot && typeof bot.isPolling === 'function' && bot.isPolling()) {
    try {
      await bot.stopPolling();
      console.log('[Shutdown] Telegram bot polling stopped.');
    } catch (err) {
      console.error('[Shutdown] Error stopping polling:', err.message);
    }
  }

  if (process.env.NODE_ENV !== 'test') {
    process.exit(0);
  }
}

if (require.main === module) {
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  (async () => {
    try {
      initBot();
      startScheduler();
      console.log('🤖 DrinkTheStick Bot iniciado con éxito.');
      console.log(`⏰ Cron configurado: ${process.env.SCHEDULE_CRON || DEFAULT_CRON}`);

      if (process.env.RUN_ON_START !== 'false') {
        await runReportCycle();
      }
    } catch (err) {
      console.error('❌ Error al iniciar el bot:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = {
  DEFAULT_CRON,
  DEFAULT_MAX_OFFER_PRICE,
  FILTER_OPTIONS,
  getDefaultFilters,
  normalizeFilters,
  getSearchFilterKey,
  formatFilterSummary,
  buildFilterKeyboard,
  parseManualDateRange,
  parseManualPrice,
  normalizeItineraryUrl,
  initBot,
  registerBotHandlers,
  runReportCycle,
  startScheduler,
  stopScheduler,
  gracefulShutdown,
  loadUsers,
  saveUsers,
  loadUserRecords,
  saveUserRecords,
  getUserFilters,
  updateUserFilters,
  resetUserFilters,
  loadSentOffers,
  saveSentOffers,
  isJobRunning: () => isJobRunning,
  getScheduledJob: () => scheduledJob,
  getBot: () => bot
};
