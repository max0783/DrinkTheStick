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

const getOptionValue = (opt) => (opt.value !== undefined ? opt.value : opt.code);

const MULTI_FILTER_META = {
  sub: {
    field: 'subcategory',
    list: FILTER_OPTIONS.subcategories,
    emptyToast: 'Buscador global',
    allowSlug: true,
    extraPatch: {}
  },
  area: {
    field: 'area',
    list: FILTER_OPTIONS.areas,
    emptyToast: 'Todos los destinos',
    allowSlug: false,
    extraPatch: { subcategory: '' }
  },
  port: {
    field: 'embkPort',
    list: FILTER_OPTIONS.ports,
    emptyToast: 'Cualquier salida',
    allowSlug: false,
    extraPatch: { subcategory: '' }
  },
  cab: {
    field: 'cabin',
    list: FILTER_OPTIONS.cabins,
    emptyToast: 'Todas las cabinas',
    allowSlug: false,
    extraPatch: {}
  },
  dur: {
    field: 'nights',
    list: FILTER_OPTIONS.nights,
    emptyToast: 'Todas las noches',
    allowSlug: false,
    extraPatch: {}
  }
};

function parseMultiValues(raw, allowedValues = null, allowSlug = false) {
  const parts = Array.isArray(raw)
    ? raw.map((v) => String(v || '').trim())
    : String(raw || '').split(',').map((v) => v.trim());

  const seen = new Set();
  const valid = [];
  for (const val of parts) {
    if (!val || seen.has(val)) continue;
    const ok = (!allowedValues && !allowSlug) ||
      (allowedValues && allowedValues.has(val)) ||
      (allowSlug && /^[a-z0-9-]+$/i.test(val));
    if (ok) {
      seen.add(val);
      valid.push(val);
    }
  }

  if (allowedValues) {
    const order = Array.from(allowedValues);
    valid.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
  }
  return valid;
}

function toggleMultiValue(currentCsv, value, allowedValues = null, allowSlug = false) {
  const list = parseMultiValues(currentCsv, allowedValues, allowSlug);
  const idx = list.indexOf(value);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(value);
  }
  return parseMultiValues(list, allowedValues, allowSlug).join(',');
}

let isJobRunning = false;
let scheduledJob = null;
let bot = null;
let activeLockPath = null;
let pollingRestartTimer = null;

const DEFAULT_POLLING_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];

function buildBotOptions(options = {}) {
  return {
    polling: options.polling !== undefined ? options.polling : true,
    request: {
      family: 4,
      ...(options.request || {})
    }
  };
}

function isTransientTelegramError(err) {
  if (!err) return false;
  const status = err?.response?.statusCode;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (status && status >= 400 && status < 500) return false;

  const code = String(err.code || '').toUpperCase();
  const msg = String(err.message || err || '');
  if (['EFATAL', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)) {
    return true;
  }
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|429 Too Many Requests|502 Bad Gateway|503 Service|504 Gateway Timeout|socket hang up/i.test(msg);
}

function extractRetryAfterMs(err) {
  const headerVal = Number(err?.response?.headers?.['retry-after']);
  if (Number.isFinite(headerVal) && headerVal > 0) return (headerVal + 1) * 1000;
  const match = String(err?.message || '').match(/retry after\s+(\d+)/i);
  if (match) return (Number(match[1]) + 1) * 1000;
  return 0;
}

async function callTelegramWithRetry(fn, opts = {}) {
  const maxRetries = Number.isInteger(opts.maxRetries) ? opts.maxRetries : 2;
  const baseDelayMs = Number(opts.delayMs) >= 0 ? Number(opts.delayMs) : 800;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientTelegramError(err) || attempt >= maxRetries) {
        throw err;
      }
      const retryAfter = extractRetryAfterMs(err);
      const delayMs = retryAfter > 0 ? retryAfter : baseDelayMs * Math.pow(2, attempt);
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

function getLockFilePath(overridePath) {
  return path.resolve(overridePath || path.join(process.cwd(), 'drinkthestick.pid'));
}

function acquireInstanceLock(overridePath) {
  const lockPath = getLockFilePath(overridePath);
  if (fs.existsSync(lockPath)) {
    const rawPid = Number(String(fs.readFileSync(lockPath, 'utf8') || '').trim());
    if (Number.isInteger(rawPid) && rawPid > 0 && rawPid !== process.pid) {
      try {
        process.kill(rawPid, 0);
        return { acquired: false, existingPid: rawPid, lockPath };
      } catch (err) {
        if (err && err.code === 'EPERM') {
          return { acquired: false, existingPid: rawPid, lockPath };
        }
        // Stale PID (ESRCH): safe to take over lock
      }
    }
  }
  fs.writeFileSync(lockPath, String(process.pid), 'utf8');
  return { acquired: true, pid: process.pid, lockPath };
}

function releaseInstanceLock(overridePath) {
  const lockPath = getLockFilePath(overridePath || activeLockPath);
  try {
    if (fs.existsSync(lockPath)) {
      const pidInFile = Number(String(fs.readFileSync(lockPath, 'utf8') || '').trim());
      if (!pidInFile || pidInFile === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch (_) {}
  if (!overridePath) activeLockPath = null;
}

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

  const validSubcategories = new Set(FILTER_OPTIONS.subcategories.map(getOptionValue).filter(Boolean));
  const validTripTypes = new Set(FILTER_OPTIONS.tripTypes.map(getOptionValue));
  const validAreas = new Set(FILTER_OPTIONS.areas.map(getOptionValue).filter(Boolean));
  const validPorts = new Set(FILTER_OPTIONS.ports.map(getOptionValue).filter(Boolean));
  const validDates = new Set(['6m', '12m', '18m', 'summer', 'custom']);
  const validCabins = new Set(FILTER_OPTIONS.cabins.map(getOptionValue).filter(Boolean));
  const validNights = new Set(FILTER_OPTIONS.nights.map(getOptionValue).filter(Boolean));

  const subcategory = src.subcategory !== undefined
    ? parseMultiValues(src.subcategory, validSubcategories, true).join(',')
    : defaults.subcategory;
  const tripType = src.tripType !== undefined && validTripTypes.has(String(src.tripType))
    ? String(src.tripType)
    : defaults.tripType;
  const area = src.area !== undefined
    ? parseMultiValues(src.area, validAreas).join(',')
    : defaults.area;
  const embkPort = src.embkPort !== undefined
    ? parseMultiValues(src.embkPort, validPorts).join(',')
    : defaults.embkPort;
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

  const cabin = src.cabin !== undefined
    ? parseMultiValues(src.cabin, validCabins).join(',')
    : defaults.cabin;
  const nights = src.nights !== undefined
    ? parseMultiValues(src.nights, validNights).join(',')
    : defaults.nights;

  let maxPrice = defaults.maxPrice;
  if (src.maxPrice === 0 || src.maxPrice === '0') {
    maxPrice = 0;
  } else if (src.maxPrice !== undefined && src.maxPrice !== null) {
    const num = Number(src.maxPrice);
    if (Number.isFinite(num) && num > 0) {
      maxPrice = Math.round(num);
    }
  }

  return {
    subcategory,
    tripType,
    area,
    embkPort,
    datePreset,
    dateFrom,
    dateTo,
    cabin,
    nights,
    maxPrice
  };
}

function getSearchFilterKey(filters) {
  const f = normalizeFilters(filters);
  return [
    f.subcategory,
    f.tripType,
    f.area,
    f.embkPort,
    f.datePreset,
    f.dateFrom,
    f.dateTo,
    f.cabin,
    f.nights
  ].join('|');
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
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
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

function extractCruiseId(offerOrUrl) {
  if (offerOrUrl && typeof offerOrUrl === 'object') {
    if (offerOrUrl.cruiseId) return String(offerOrUrl.cruiseId).trim();
    const candidateUrl = offerOrUrl.url || offerOrUrl.url_itinerario || '';
    return extractCruiseId(candidateUrl);
  }
  const urlStr = String(offerOrUrl || '').trim();
  if (!urlStr) return '';
  const match = urlStr.match(/[?&]cruiseId=([^&#]+)/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]).trim();
  } catch (_) {
    return match[1].trim();
  }
}

function normalizeItineraryUrl(rawUrl) {
  const urlStr = String(rawUrl || '').trim();
  if (!urlStr) return '';

  const cruiseId = extractCruiseId(urlStr);
  if (cruiseId && !/\/booking\b/i.test(urlStr)) {
    return `https://www.msccruceros.com.ar/booking?cruiseId=${encodeURIComponent(cruiseId)}&adults=2&children=0&infants=0&juniors=0`;
  }
  return urlStr;
}

function isSameCruiseVariant(a, b) {
  if (String(a?.camarote || 'Todas') !== String(b?.camarote || 'Todas')) return false;

  const idA = extractCruiseId(a);
  const idB = extractCruiseId(b);
  if (idA && idB) {
    return idA === idB;
  }

  return (
    String(a?.destino || '') === String(b?.destino || '') &&
    String(a?.barco || '') === String(b?.barco || '') &&
    getOfferDatesText(a) === getOfferDatesText(b)
  );
}

function isSameOffer(a, b) {
  return isSameCruiseVariant(a, b) && getOfferPrice(a) === getOfferPrice(b);
}

function isChatIdInList(chatIds, chatId) {
  return Array.isArray(chatIds)
    ? chatIds.some((id) => String(id) === String(chatId))
    : true;
}

function hasAlreadyNotifiedUser(sentOffers, offer, chatId) {
  const candidatePrice = getOfferPrice(offer);
  return sentOffers.some((so) => {
    if (!isSameCruiseVariant(so, offer)) return false;
    if (!isChatIdInList(so.chatIds, chatId)) return false;
    const sentPrice = getOfferPrice(so);
    return Number.isFinite(sentPrice) && Number.isFinite(candidatePrice)
      ? sentPrice <= candidatePrice
      : isSameOffer(so, offer);
  });
}

function findFilterLabel(list, value) {
  const found = list.find((item) => getOptionValue(item) === value);
  if (found) return found.label;
  return value ? `🏷 ${value}` : '';
}

function formatMultiFilterLabel(list, csvValue) {
  const values = parseMultiValues(csvValue, null, true);
  if (values.length === 0) return findFilterLabel(list, '');
  return values.map((val) => findFilterLabel(list, val)).join(', ');
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
    : `• Destino: ${formatMultiFilterLabel(FILTER_OPTIONS.areas, f.area)}\n• Salida: ${formatMultiFilterLabel(FILTER_OPTIONS.ports, f.embkPort)}`;

  return (
    `🎛 Tus filtros actuales:\n` +
    `• Subcategoría: ${formatMultiFilterLabel(FILTER_OPTIONS.subcategories, f.subcategory)}\n` +
    `• Tipo de viaje: ${findFilterLabel(FILTER_OPTIONS.tripTypes, f.tripType)}\n` +
    `${areaLine}\n` +
    `• Fechas: ${formatDatesFilterLabel(f)}\n` +
    `• Camarote: ${formatMultiFilterLabel(FILTER_OPTIONS.cabins, f.cabin)}\n` +
    `• Noches: ${formatMultiFilterLabel(FILTER_OPTIONS.nights, f.nights)}\n` +
    `• Precio máx.: ${formatPriceFilterLabel(f.maxPrice)}`
  );
}

function formatShortFilterCaption(filters) {
  const f = normalizeFilters(filters);
  const stripIcon = (txt) => txt.replace(/^[^\s]+\s/, '');
  const subLabel = parseMultiValues(f.subcategory, null, true)
    .map((v) => stripIcon(findFilterLabel(FILTER_OPTIONS.subcategories, v)))
    .join(', ') || 'Buscador global';
  const scopeParts = f.subcategory
    ? [subLabel]
    : [
        parseMultiValues(f.area).map((v) => stripIcon(findFilterLabel(FILTER_OPTIONS.areas, v))).join(', ') || 'Todos',
        parseMultiValues(f.embkPort).map((v) => stripIcon(findFilterLabel(FILTER_OPTIONS.ports, v))).join(', ') || 'Cualquiera'
      ];
  const parts = [
    ...scopeParts,
    f.tripType ? stripIcon(findFilterLabel(FILTER_OPTIONS.tripTypes, f.tripType)) : 'Ida/Vuelta y Solo ida',
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

  if (MULTI_FILTER_META[submenu]) {
    const meta = MULTI_FILTER_META[submenu];
    const selected = new Set(parseMultiValues(f[meta.field], null, Boolean(meta.allowSlug)));
    const items = meta.list.map((opt) => {
      const val = getOptionValue(opt);
      const isChecked = val === '' ? selected.size === 0 : selected.has(val);
      return btn(`${isChecked ? '✅ ' : ''}${opt.label}`, `flt:${submenu}:${opt.code}`);
    });
    const rows = chunkButtons(items, 2);
    if (submenu === 'sub') {
      rows.push([btn('🔍 Buscar sublinks de promos', 'flt:discover')]);
    }
    rows.push([btn('⬅️ Volver', 'flt:menu')]);
    return { inline_keyboard: rows };
  }

  if (submenu === 'trip') {
    const items = FILTER_OPTIONS.tripTypes.map((opt) => {
      const prefix = f.tripType === opt.value ? '✅ ' : '';
      return btn(`${prefix}${opt.label}`, `flt:trip:${opt.code}`);
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

    // Expand multi-value filters into shared atomic scrape specs
    const groupsMap = new Map();
    const hasCustomUrl = Boolean(options.scraperOptions && options.scraperOptions.customUrl);
    const hasFilterOverrideInScraperOpts = Boolean(options.scraperOptions && options.scraperOptions.filters);
    const memberRunState = new Map();

    if (targets.length === 0) {
      groupsMap.set('default', {
        filters: getDefaultFilters(options.maxOfferPrice),
        members: []
      });
    } else {
      for (const target of targets) {
        memberRunState.set(String(target.chatId), {
          member: target,
          totalCruceros: 0,
          rawCruises: [],
          matchingOffers: [],
          newOffersCount: 0,
          groupXlsxPaths: []
        });
        const specs = (hasCustomUrl || hasFilterOverrideInScraperOpts)
          ? [target.filters]
          : createFile.expandFilterCombos(target.filters);
        for (const spec of specs) {
          const key = hasCustomUrl ? '__CUSTOM__' : getSearchFilterKey(spec);
          if (!groupsMap.has(key)) {
            groupsMap.set(key, { filters: spec, members: [] });
          }
          const grp = groupsMap.get(key);
          if (!grp.members.some((m) => String(m.chatId) === String(target.chatId))) {
            grp.members.push(target);
          }
        }
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
        const err = new Error((scrapeResult && scrapeResult.error) || 'Scraping failed');
        err.code = scrapeResult?.errorCode || 'SCRAPE_ERROR';
        throw err;
      }

      const xlsxPath = scrapeResult.xlsxPath || path.resolve(process.cwd(), 'cruceros_msc.xlsx');
      if (!fs.existsSync(xlsxPath) || fs.statSync(xlsxPath).size === 0) {
        throw new Error(`Excel report missing or empty at ${xlsxPath}`);
      }

      lastXlsxPath = xlsxPath;
      totalCruceros += scrapeResult.totalCruceros || 0;

      const cruceros = Array.isArray(scrapeResult.cruceros) ? scrapeResult.cruceros : [];
      const fallbackCabin = group.filters.cabin || 'Todas';
      const normalizedCruises = cruceros.map((c) => ({
        ...c,
        camarote: c.camarote || fallbackCabin,
        url_itinerario: normalizeItineraryUrl(c.url_itinerario || c.url || '')
      }));
      const rawMappedOffers = normalizedCruises.map((c) => ({
        destino: c.destino,
        duracion: c.duracion,
        barco: c.barco,
        precio: getOfferPrice(c),
        moneda: c.precio?.moneda || 'USD',
        fechas: getOfferDatesText(c),
        url: c.url_itinerario,
        cruiseId: extractCruiseId(c.url_itinerario) || c.cruiseId || '',
        puerto: c.puerto_salida || c.puerto || 'No especificado',
        camarote: c.camarote,
        page: c.pagina || 1
      }));
      const mappedOffers = [];
      for (const candidate of rawMappedOffers) {
        if (!mappedOffers.some((existing) => isSameOffer(existing, candidate))) {
          mappedOffers.push(candidate);
        }
      }

      activeBroadcastOffers.push(...mappedOffers);

      if (!currentBot || group.members.length === 0) continue;

      // Reload latest persisted notification state after potentially long scrape
      sentOffers = loadSentOffers(offersPath);
      const nowIso = new Date().toISOString();

      for (const member of group.members) {
        const chatId = member.chatId;
        const maxPrice = member.filters.maxPrice;
        const state = memberRunState.get(String(chatId));
        const matchingOffers = maxPrice > 0
          ? mappedOffers.filter((o) => Number.isFinite(o.precio) && o.precio > 0 && o.precio <= maxPrice)
          : [];

        if (state) {
          state.totalCruceros += scrapeResult.totalCruceros || 0;
          state.groupXlsxPaths.push(xlsxPath);
          for (const nc of normalizedCruises) {
            const candidate = { ...nc, precio: getOfferPrice(nc) };
            if (!state.rawCruises.some((ex) => isSameOffer({ ...ex, precio: getOfferPrice(ex) }, candidate))) {
              state.rawCruises.push(nc);
            }
          }
          for (const mo of matchingOffers) {
            if (!state.matchingOffers.some((ex) => isSameOffer(ex, mo))) {
              state.matchingOffers.push(mo);
            }
          }
        }

        if (options.sendOffers !== false && typeof currentBot.sendMessage === 'function' && maxPrice > 0) {
          for (const offer of matchingOffers) {
            const existing = sentOffers.find((so) => isSameOffer(so, offer));
            const alreadyNotified = hasAlreadyNotifiedUser(sentOffers, offer, chatId);

            if (alreadyNotified) {
              if (existing) {
                existing.active = true;
                existing.lastSeenAt = nowIso;
                existing.url = offer.url || existing.url;
              }
              continue;
            }

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
              await callTelegramWithRetry(
                () => currentBot.sendMessage(chatId, msg),
                { delayMs: options.telegramRetryDelayMs }
              );
              offersSent++;
              if (state) state.newOffersCount++;

              if (existing) {
                if (!Array.isArray(existing.chatIds)) existing.chatIds = [];
                if (!isChatIdInList(existing.chatIds, chatId)) existing.chatIds.push(chatId);
                existing.active = true;
                existing.lastSeenAt = nowIso;
                existing.url = offer.url || existing.url;
              } else {
                sentOffers.push({
                  ...offer,
                  active: true,
                  lastSeenAt: nowIso,
                  chatIds: [chatId]
                });
              }
              saveSentOffers(sentOffers, offersPath);
            } catch (err) {
              console.error(`[ReportCycle] Error sending offer to chat ${chatId}:`, err.message);
            }
          }
        }
      }
    }

    // Deliver consolidated Excel (one combined file even when 2+ cabins/subcategories ran) and manual summary
    if (currentBot && memberRunState.size > 0) {
      const todayStr = new Date().toLocaleDateString('es-AR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
      const fileOptions = options.fileOptions || {
        filename: `cruceros_msc_${new Date().toISOString().slice(0, 10)}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      };

      for (const state of memberRunState.values()) {
        const chatId = state.member.chatId;
        const maxPrice = state.member.filters.maxPrice;

        if (typeof currentBot.sendDocument === 'function' && options.sendDocument === true) {
          let docPath = state.groupXlsxPaths[0] || lastXlsxPath;
          if (state.groupXlsxPaths.length > 1) {
            const mergedPath = path.join(os.tmpdir(), `dts_merged_${chatId}_${Date.now()}.xlsx`);
            await createFile.createExcelReport(state.rawCruises, mergedPath);
            tempFilesToClean.push(mergedPath);
            docPath = mergedPath;
          }
          const reportCount = state.groupXlsxPaths.length > 1 ? state.rawCruises.length : state.totalCruceros;
          const budgetLine = maxPrice > 0
            ? `\n💰 Con precio ≤ $${maxPrice} USD: ${state.matchingOffers.length}`
            : '';
          const caption = options.caption ||
            `📊 Reporte MSC Cruceros - ${todayStr}\n🎛 ${formatShortFilterCaption(state.member.filters)}\n🚢 Total encontrados: ${reportCount}${budgetLine}`;

          try {
            await callTelegramWithRetry(
              () => currentBot.sendDocument(chatId, docPath, { caption }, fileOptions),
              { delayMs: options.telegramRetryDelayMs }
            );
            documentsSent++;
          } catch (err) {
            console.error(`[ReportCycle] Error sending Excel to chat ${chatId}:`, err.message);
          }
        }

        if (options.notifyManualSummary && typeof currentBot.sendMessage === 'function' && state.newOffersCount === 0) {
          const infoMsg = maxPrice > 0
            ? (state.matchingOffers.length === 0
                ? `ℹ️ Búsqueda finalizada: ${state.totalCruceros} cruceros encontrados, pero ninguno por debajo de USD ${maxPrice}. Revisa el Excel o ajusta el precio en /filtros.`
                : `ℹ️ Búsqueda finalizada: ${state.matchingOffers.length} ofertas ≤ USD ${maxPrice} (ya te las había enviado antes; mira el Excel actualizado arriba).`)
            : `ℹ️ Búsqueda finalizada: ${state.totalCruceros} cruceros cargados en el Excel (tenés Precio máx. en "Sin límite").`;
          await callTelegramWithRetry(
            () => currentBot.sendMessage(chatId, infoMsg),
            { delayMs: options.telegramRetryDelayMs }
          ).catch(() => {});
        }
      }
    }

    // Update active state on full broadcast runs that returned results WITHOUT deleting history
    if (!isTargetedRun && totalCruceros > 0 && activeBroadcastOffers.length > 0 && options.sendOffers !== false) {
      const syncTime = new Date().toISOString();
      sentOffers = loadSentOffers(offersPath).map((so) => {
        const matched = activeBroadcastOffers.find((co) => isSameOffer(co, so));
        if (matched) {
          return {
            ...so,
            cruiseId: so.cruiseId || matched.cruiseId || extractCruiseId(matched),
            url: matched.url || normalizeItineraryUrl(so.url || ''),
            active: true,
            lastSeenAt: syncTime
          };
        }
        return {
          ...so,
          cruiseId: so.cruiseId || extractCruiseId(so),
          active: false
        };
      });
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
      errorCode: error.code || (createFile.isConnectionRefusedError(error) ? 'ECONNREFUSED' : 'CYCLE_ERROR'),
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
  sub: '🏷 Elige una o más subcategorías / promos (o Buscador global para usar Destino y Salida):',
  trip: '🔁 Selecciona tipo de itinerario (Ida y vuelta vs Solo ida):',
  area: '🗺 Destinos (hacia) — puedes elegir dos o más:',
  port: '⚓ Puertos de salida (desde) — puedes elegir uno o ambos:',
  date: '📅 Selecciona rango de fechas:',
  cab: '🛏 Categorías de camarote — puedes elegir dos o más:',
  dur: '🌙 Duración en noches — puedes elegir dos o más:',
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
    const currentSubs = new Set(parseMultiValues(getUserFilters(chatId, usersPath).subcategory, null, true));

    let text = `🏷 Sublinks de promociones encontrados en MSC (${discoveredPromos.length}):\n\n`;
    const promoButtons = discoveredPromos.map((item, idx) => {
      text += `${idx + 1}. ${item.label}\n   🔗 ${item.url}\n`;
      const prefix = currentSubs.has(item.slug) ? '✅ ' : '';
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

    const activeMatching = allSent.filter((o) => {
      if (o.active === false) return false;
      if (maxPrice > 0) {
        const p = getOfferPrice(o);
        return Number.isFinite(p) && p > 0 && p <= maxPrice;
      }
      return true;
    });

    // Show each cruise variant once (lowest active price if multiple recorded)
    const dedupedOffers = [];
    for (const offer of activeMatching) {
      const existingIdx = dedupedOffers.findIndex((d) => isSameCruiseVariant(d, offer));
      if (existingIdx === -1) {
        dedupedOffers.push(offer);
      } else if (getOfferPrice(offer) < getOfferPrice(dedupedOffers[existingIdx])) {
        dedupedOffers[existingIdx] = offer;
      }
    }

    if (dedupedOffers.length === 0) {
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

    for (let index = 0; index < Math.min(dedupedOffers.length, 15); index++) {
      const offer = dedupedOffers[index];
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
    const res = await runReportCycle({
      bot: botInstance,
      targetChatIds: [chatId],
      usersFilePath: usersPath,
      sentOffersFilePath: offersPath,
      scraperFn: options.scraperFn,
      maxOfferPrice: options.maxOfferPrice,
      telegramRetryDelayMs: options.telegramRetryDelayMs,
      sendDocument: true,
      notifyManualSummary: true
    });
    if (res && res.success === false && !res.skipped) {
      await botInstance.sendMessage(
        chatId,
        `⚠️ No pude completar la búsqueda en MSC (${res.error}). Probá nuevamente en unos minutos.`
      ).catch(() => {});
    }
  };

  const backoffSchedule = Array.isArray(options.pollingBackoffMs) && options.pollingBackoffMs.length > 0
    ? options.pollingBackoffMs
    : DEFAULT_POLLING_BACKOFF_MS;
  let pollingFailureStreak = 0;
  let lastLoggedPollMsg = '';

  const resetPollingBackoff = () => {
    pollingFailureStreak = 0;
    lastLoggedPollMsg = '';
  };

  botInstance.on('polling_error', (error) => {
    const errCode = error?.code || 'UNKNOWN';
    const errMsg = error?.message || String(error);
    const sig = `${errCode}:${errMsg}`;

    if (error?.response?.statusCode === 401 && typeof botInstance.stopPolling === 'function') {
      console.error('[Telegram Fatal] Unauthorized token. Stopping polling.');
      botInstance.stopPolling().catch(() => {});
      return;
    }

    if (sig !== lastLoggedPollMsg) {
      console.error(`[Telegram Polling Error] Code: ${errCode}, Message: ${errMsg}`);
      lastLoggedPollMsg = sig;
    }

    if (
      isTransientTelegramError(error) &&
      typeof botInstance.stopPolling === 'function' &&
      typeof botInstance.startPolling === 'function'
    ) {
      if (pollingRestartTimer) return;
      const retryAfterMs = extractRetryAfterMs(error);
      const stepDelay = backoffSchedule[Math.min(pollingFailureStreak, backoffSchedule.length - 1)];
      const waitMs = Math.max(retryAfterMs, stepDelay);
      pollingFailureStreak++;
      console.warn(`[Telegram Polling] Reintentando conexión en ${waitMs}ms (backoff #${pollingFailureStreak})...`);

      Promise.resolve(botInstance.stopPolling({ cancel: true }))
        .catch(() => {})
        .finally(() => {
          pollingRestartTimer = setTimeout(() => {
            pollingRestartTimer = null;
            Promise.resolve(botInstance.startPolling()).catch((startErr) => {
              console.error('[Telegram Polling] Error al reanudar polling:', startErr.message);
            });
          }, waitMs);
          if (typeof pollingRestartTimer.unref === 'function') pollingRestartTimer.unref();
        });
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
      const res = await runReportCycle({
        bot: botInstance,
        targetChatIds: [chatId],
        usersFilePath: usersPath,
        sentOffersFilePath: offersPath,
        scraperFn: options.scraperFn,
        maxOfferPrice: options.maxOfferPrice,
        telegramRetryDelayMs: options.telegramRetryDelayMs,
        sendDocument: true
      });
      if (res && res.success === false && !res.skipped) {
        await botInstance.sendMessage(
          chatId,
          `⚠️ No pude generar el reporte ahora (${res.error}). Probá nuevamente en unos minutos.`
        ).catch(() => {});
      }
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
    resetPollingBackoff();
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

      if (MULTI_FILTER_META[action]) {
        const meta = MULTI_FILTER_META[action];
        const opt = meta.list.find((item) => item.code === value);
        if (!opt) {
          await safeAnswerCallback(botInstance, query.id);
          return;
        }
        const val = getOptionValue(opt);
        const current = getUserFilters(chatId, usersPath);
        const allowedSet = new Set(meta.list.map(getOptionValue).filter(Boolean));
        if (val === '') {
          updateUserFilters(chatId, { [meta.field]: '', ...meta.extraPatch }, usersPath);
          await safeAnswerCallback(botInstance, query.id, meta.emptyToast);
          await sendFilterMenu(chatId, messageId, 'main');
          return;
        }
        const nextCsv = toggleMultiValue(current[meta.field], val, allowedSet, Boolean(meta.allowSlug));
        const updated = updateUserFilters(chatId, { [meta.field]: nextCsv, ...meta.extraPatch }, usersPath);
        const toast = (formatMultiFilterLabel(meta.list, updated[meta.field]) || meta.emptyToast).slice(0, 120);
        await safeAnswerCallback(botInstance, query.id, toast);
        await sendFilterMenu(chatId, messageId, action);
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
        const current = getUserFilters(chatId, usersPath);
        const validSubs = new Set(FILTER_OPTIONS.subcategories.map(getOptionValue).filter(Boolean));
        const nextCsv = toggleMultiValue(current.subcategory, item.slug, validSubs, true);
        updateUserFilters(chatId, { subcategory: nextCsv }, usersPath);
        const added = parseMultiValues(nextCsv, validSubs, true).includes(item.slug);
        await safeAnswerCallback(botInstance, query.id, `${added ? 'Activado' : 'Quitado'}: ${item.label}`);
        await sendFilterMenu(chatId, null, 'main', `${added ? '✅' : '☑️'} Subcategorías activas: ${nextCsv || 'Buscador global'}\n🔗 ${item.url}`);
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
    resetPollingBackoff();
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

  bot = new TelegramBot(token, buildBotOptions(options));
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

  if (pollingRestartTimer) {
    clearTimeout(pollingRestartTimer);
    pollingRestartTimer = null;
  }

  if (bot && typeof bot.isPolling === 'function' && bot.isPolling()) {
    try {
      await Promise.race([
        bot.stopPolling({ cancel: true }),
        new Promise((r) => setTimeout(r, 2000))
      ]);
      console.log('[Shutdown] Telegram bot polling stopped.');
    } catch (err) {
      console.error('[Shutdown] Error stopping polling:', err.message);
    }
  }

  if (activeLockPath) {
    releaseInstanceLock(activeLockPath);
  }

  if (process.env.NODE_ENV !== 'test') {
    process.exit(0);
  }
}

if (require.main === module) {
  const lock = acquireInstanceLock();
  if (!lock.acquired) {
    console.error(`❌ Ya hay otra instancia de DrinkTheStick ejecutándose (PID ${lock.existingPid}). Detenela antes de iniciar otra.`);
    process.exit(1);
  }
  activeLockPath = lock.lockPath;

  process.on('exit', () => {
    if (activeLockPath) releaseInstanceLock(activeLockPath);
  });
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
  parseMultiValues,
  toggleMultiValue,
  formatMultiFilterLabel,
  getSearchFilterKey,
  formatFilterSummary,
  buildFilterKeyboard,
  parseManualDateRange,
  parseManualPrice,
  normalizeItineraryUrl,
  isSameOffer,
  buildBotOptions,
  isTransientTelegramError,
  callTelegramWithRetry,
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
  acquireInstanceLock,
  releaseInstanceLock,
  isJobRunning: () => isJobRunning,
  getScheduledJob: () => scheduledJob,
  getBot: () => bot
};
