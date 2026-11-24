const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const app = require('../app');

function createMockBot() {
  const emitter = new EventEmitter();
  emitter.sentMessages = [];
  emitter.editedMessages = [];
  emitter.sentDocuments = [];
  emitter.answeredCallbacks = [];
  emitter.textHandlers = [];
  emitter.pollingStopped = false;

  emitter.onText = (regex, cb) => {
    emitter.textHandlers.push({ regex, cb });
  };

  emitter.simulateText = async (chatId, text) => {
    for (const h of emitter.textHandlers) {
      if (h.regex.test(text)) {
        await h.cb({ chat: { id: chatId }, text });
      }
    }
  };

  emitter.simulateCallback = async (chatId, data, messageId = 1) => {
    const query = {
      id: `cq_${emitter.answeredCallbacks.length + 1}`,
      data,
      message: { chat: { id: chatId }, message_id: messageId }
    };
    const listeners = emitter.listeners('callback_query');
    for (const fn of listeners) {
      await fn(query);
    }
  };

  emitter.simulateMessage = async (chatId, text) => {
    const msg = { chat: { id: chatId }, text };
    const listeners = emitter.listeners('message');
    for (const fn of listeners) {
      await fn(msg);
    }
  };

  emitter.sendMessage = async (chatId, text, options = {}) => {
    emitter.sentMessages.push({ chatId, text, options });
    return { message_id: emitter.sentMessages.length, chat: { id: chatId } };
  };

  emitter.editMessageText = async (text, options = {}) => {
    emitter.editedMessages.push({ text, options });
    return { message_id: options.message_id, chat: { id: options.chat_id } };
  };

  emitter.answerCallbackQuery = async (id, options = {}) => {
    emitter.answeredCallbacks.push({ id, options });
    return true;
  };

  emitter.sendDocument = async (chatId, docPath, options, fileOptions) => {
    emitter.sentDocuments.push({ chatId, docPath, options, fileOptions });
    return { message_id: emitter.sentDocuments.length, chat: { id: chatId } };
  };

  emitter.isPolling = () => !emitter.pollingStopped;
  emitter.stopPolling = async () => {
    emitter.pollingStopped = true;
  };

  return emitter;
}

describe('Telegram Bot & Multi-User Subscription Flow (app.js)', () => {
  let tmpDir;
  let usersFile;
  let offersFile;
  let xlsxFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dts-bot-test-'));
    usersFile = path.join(tmpDir, 'users.json');
    offersFile = path.join(tmpDir, 'sent_offers.json');
    xlsxFile = path.join(tmpDir, 'cruceros_msc.xlsx');
    fs.writeFileSync(xlsxFile, 'fake-xlsx-content');
  });

  afterEach(async () => {
    app.stopScheduler();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws clear config error when bot token is missing', () => {
    assert.throws(() => app.initBot(''), /Telegram bot token is missing/);
  });

  it('registers any user on /start, runs report cycle, and unsubscribes on /stop', async () => {
    const mockBot = createMockBot();
    const mockScraper = async () => ({
      success: true,
      totalCruceros: 2,
      xlsxPath: xlsxFile,
      cruceros: [
        {
          destino: 'Sudamérica',
          duracion: '8 Noches',
          barco: 'MSC Splendida',
          puerto_salida: 'Buenos Aires',
          precio: { moneda: 'USD', valor: 771 },
          fechas_disponibles: ['3 Dic 2026'],
          url_itinerario: 'https://www.msccruceros.com.ar',
          pagina: 1
        },
        {
          destino: 'Brasil',
          duracion: '9 Noches',
          barco: 'MSC Fantasia',
          puerto_salida: 'Buenos Aires',
          precio: { moneda: 'USD', valor: 1500 },
          fechas_disponibles: ['10 Ene 2027'],
          url_itinerario: 'https://www.msccruceros.com.ar',
          pagina: 1
        }
      ]
    });

    app.registerBotHandlers(mockBot, {
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: mockScraper
    });

    // Normal arbitrary chat IDs (NOT ending in 440) must be allowed to register and receive messages
    await mockBot.simulateText(11223344, '/start');
    await mockBot.simulateText(99887766, '/start');

    assert.deepStrictEqual(app.loadUsers(usersFile), [11223344, 99887766]);
    // Excel is on-demand only: /start subscribes and scans alerts without pushing unsolicited .xlsx
    assert.strictEqual(mockBot.sentDocuments.length, 0);
    assert.strictEqual(mockBot.sentMessages.filter((m) => m.text.includes('¡Nueva oferta encontrada!')).length, 2);

    // Duplicate /start tells user they are already registered
    await mockBot.simulateText(11223344, '/start');
    assert.ok(mockBot.sentMessages.some((m) => m.chatId === 11223344 && m.text.includes('Ya estás registrado')));

    // /stop removes user from users.json
    await mockBot.simulateText(11223344, '/stop');
    assert.deepStrictEqual(app.loadUsers(usersFile), [99887766]);
  });

  it('sends deduplicated alerts automatically and delivers Excel only on demand', async () => {
    const mockBot = createMockBot();
    app.saveUsers([10001, 20002], usersFile);

    const mockScraper = async () => ({
      success: true,
      totalCruceros: 2,
      xlsxPath: xlsxFile,
      cruceros: [
        {
          destino: 'Sudamérica',
          duracion: '8 Noches',
          barco: 'MSC Splendida',
          puerto_salida: 'Buenos Aires',
          precio: { moneda: 'USD', valor: 750 },
          fechas_disponibles: ['3 Dic 2026'],
          url_itinerario: 'https://www.msccruceros.com.ar',
          pagina: 1
        },
        {
          destino: 'Caribe',
          duracion: '10 Noches',
          barco: 'MSC Seascape',
          puerto_salida: 'Miami',
          precio: { moneda: 'USD', valor: 1200 },
          fechas_disponibles: ['15 Ene 2027'],
          url_itinerario: 'https://www.msccruceros.com.ar',
          pagina: 1
        }
      ]
    });

    // Scheduled / automatic cycle (sendDocument omitted) sends alerts only, zero Excel files
    const first = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: mockScraper,
      maxOfferPrice: 800
    });

    assert.strictEqual(first.success, true);
    assert.strictEqual(first.documentsSent, 0);
    assert.strictEqual(first.offersSent, 2); // 1 bargain offer sent to 2 users
    assert.strictEqual(app.loadSentOffers(offersFile).length, 1);

    // Second scheduled run deduplicates alert and still sends zero Excel files
    const second = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: mockScraper,
      maxOfferPrice: 800
    });

    assert.strictEqual(second.success, true);
    assert.strictEqual(second.documentsSent, 0);
    assert.strictEqual(second.offersSent, 0);

    // On-demand cycle (sendDocument: true) delivers the Excel report
    const onDemand = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: mockScraper,
      maxOfferPrice: 800,
      sendDocument: true
    });

    assert.strictEqual(onDemand.success, true);
    assert.strictEqual(onDemand.documentsSent, 2);
    assert.strictEqual(onDemand.offersSent, 0);

    // Partial/changed broadcast run where $750 disappears temporarily must NOT wipe persisted history
    const partialRes = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: async () => ({
        success: true,
        totalCruceros: 1,
        xlsxPath: xlsxFile,
        cruceros: [
          {
            destino: 'Caribe',
            duracion: '10 Noches',
            barco: 'MSC Seascape',
            puerto_salida: 'Miami',
            precio: { moneda: 'USD', valor: 1200 },
            fechas_disponibles: ['15 Ene 2027'],
            url_itinerario: 'https://www.msccruceros.com.ar/booking?cruiseId=CAR99&adults=2&children=0&infants=0&juniors=0',
            pagina: 1
          }
        ]
      }),
      maxOfferPrice: 800
    });
    assert.strictEqual(partialRes.success, true);
    const persistedInactive = app.loadSentOffers(offersFile);
    assert.strictEqual(persistedInactive.length, 1);
    assert.strictEqual(persistedInactive[0].active, false);
    assert.deepStrictEqual(persistedInactive[0].chatIds, [10001, 20002]);

    // When $750 returns on a later cycle (even inside a duplicate array), it MUST NOT re-send
    const returnedRes = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: mockScraper,
      maxOfferPrice: 800
    });
    assert.strictEqual(returnedRes.offersSent, 0);
    assert.strictEqual(app.loadSentOffers(offersFile)[0].active, true);
  });

  it('deduplicates by cruiseId across price increases and persists group 1 before group 2 error', async () => {
    const mockBot = createMockBot();
    app.saveUserRecords([
      { chatId: '10001', filters: { area: 'SOA', maxPrice: 900 } },
      { chatId: '20002', filters: { area: 'CAR', maxPrice: 900 } }
    ], usersFile);

    let callNum = 0;
    const partialCrashRes = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: async () => {
        callNum++;
        if (callNum === 2) throw new Error('Group 2 failed');
        return {
          success: true,
          totalCruceros: 2,
          xlsxPath: xlsxFile,
          cruceros: [
            {
              destino: 'Sudamérica',
              duracion: '8 Noches',
              barco: 'MSC Splendida',
              puerto_salida: 'Buenos Aires',
              precio: { moneda: 'USD', valor: 771 },
              fechas_disponibles: ['3 Dic 2026'],
              url_itinerario: 'https://www.msccruceros.com.ar/booking?cruiseId=SP01&adults=2&children=0&infants=0&juniors=0',
              pagina: 1
            },
            {
              // Duplicate in same scrape result
              destino: 'Brasil',
              duracion: '8 Noches',
              barco: 'MSC Splendida',
              puerto_salida: 'Buenos Aires',
              precio: { moneda: 'USD', valor: 771 },
              fechas_disponibles: ['03/12/2026'],
              url_itinerario: 'https://www.msccruceros.com.ar/booking?cruiseId=SP01&adults=2&children=0&infants=0&juniors=0',
              pagina: 1
            }
          ]
        };
      }
    });

    assert.strictEqual(partialCrashRes.success, false);
    assert.strictEqual(mockBot.sentMessages.length, 1); // Group 1 deduplicated intra-cycle
    assert.strictEqual(app.loadSentOffers(offersFile).length, 1); // Group 1 saved immediately before Group 2 crashed

    // Remove user 20002; test same cruiseId at slightly higher price ($811 <= $900) does NOT spam, while strict drop ($690) notifies
    app.saveUserRecords([{ chatId: 10001, filters: { area: 'SOA', maxPrice: 900 } }], usersFile);
    const bumpRes = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: async () => ({
        success: true,
        totalCruceros: 1,
        xlsxPath: xlsxFile,
        cruceros: [
          {
            destino: 'Brasil',
            duracion: '8 Noches',
            barco: 'MSC Splendida',
            puerto_salida: 'Buenos Aires',
            precio: { moneda: 'USD', valor: 811 },
            fechas_disponibles: ['03 Dic 2026'],
            url_itinerario: 'https://www.msccruceros.com.ar/booking?cruiseId=SP01&adults=2&children=0&infants=0&juniors=0',
            pagina: 1
          }
        ]
      })
    });
    assert.strictEqual(bumpRes.offersSent, 0);

    const dropRes = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: async () => ({
        success: true,
        totalCruceros: 1,
        xlsxPath: xlsxFile,
        cruceros: [
          {
            destino: 'Sudamérica',
            duracion: '8 Noches',
            barco: 'MSC Splendida',
            puerto_salida: 'Buenos Aires',
            precio: { moneda: 'USD', valor: 690 },
            fechas_disponibles: ['03 Dic 2026'],
            url_itinerario: 'https://www.msccruceros.com.ar/booking?cruiseId=SP01&adults=2&children=0&infants=0&juniors=0',
            pagina: 1
          }
        ]
      })
    });
    assert.strictEqual(dropRes.offersSent, 1);
  });

  it('handles /offers and /report commands cleanly', async () => {
    const mockBot = createMockBot();
    app.registerBotHandlers(mockBot, {
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: async () => ({
        success: true,
        totalCruceros: 1,
        xlsxPath: xlsxFile,
        cruceros: []
      })
    });

    await mockBot.simulateText(555111, '/offers');
    assert.ok(mockBot.sentMessages.some((m) => m.chatId === 555111 && m.text.includes('No hay ofertas activas')));

    app.saveSentOffers([
      {
        destino: 'Brasil',
        duracion: '8 Noches',
        barco: 'MSC Splendida',
        precio: 700,
        moneda: 'USD',
        puerto: 'Buenos Aires',
        fechas: '03 Dic 2026',
        url: 'https://www.msccruceros.com.ar/ofertas-cruceros/black-friday?cruiseId=SP01'
      }
    ], offersFile);
    await mockBot.simulateText(555111, '/offers');
    const offersMsg = mockBot.sentMessages.at(-1);
    assert.ok(offersMsg.text.includes('Brasil'));
    assert.ok(offersMsg.text.includes('https://www.msccruceros.com.ar/booking?cruiseId=SP01&adults=2&children=0&infants=0&juniors=0'));
    assert.strictEqual(offersMsg.options.disable_web_page_preview, true);

    assert.strictEqual(
      app.normalizeItineraryUrl('https://www.msccruceros.com.ar/booking?cruiseId=SV01&adults=2&children=0&infants=0&juniors=0'),
      'https://www.msccruceros.com.ar/booking?cruiseId=SV01&adults=2&children=0&infants=0&juniors=0'
    );
    assert.strictEqual(app.normalizeItineraryUrl(''), '');

    await mockBot.simulateText(555111, '/report');
    assert.strictEqual(mockBot.sentDocuments.length, 1);
    assert.strictEqual(mockBot.sentDocuments[0].chatId, 555111);
  });

  it('discovers promo sublinks via /promos and flt:discover and applies chosen slug', async () => {
    const mockBot = createMockBot();
    app.registerBotHandlers(mockBot, {
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      discoverPromoLinksFn: async () => ({
        success: true,
        links: [
          { slug: 'cyber-week', label: 'Cyber Week', url: 'https://www.msccruceros.com.ar/ofertas-cruceros/cyber-week' },
          { slug: 'black-friday', label: 'Black Friday', url: 'https://www.msccruceros.com.ar/ofertas-cruceros/black-friday' }
        ]
      })
    });

    await mockBot.simulateText(777888, '/promos');
    const listMsg = mockBot.sentMessages.at(-1);
    assert.ok(listMsg.text.includes('https://www.msccruceros.com.ar/ofertas-cruceros/cyber-week'));
    const discCallbacks = listMsg.options.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(discCallbacks.includes('flt:disc:0'));
    assert.ok(discCallbacks.every((cb) => Buffer.byteLength(cb, 'utf8') <= 64));

    await mockBot.simulateCallback(777888, 'flt:disc:0', listMsg.message_id);
    const updated = app.getUserFilters(777888, usersFile);
    assert.strictEqual(updated.subcategory, 'cyber-week');
  });

  it('recovers from stale instance lockfiles and blocks active duplicate PIDs cleanly', () => {
    const lockFile = path.join(tmpDir, 'test.pid');
    // Dead PID (unlikely to exist) should be overtaken cleanly
    fs.writeFileSync(lockFile, '999999', 'utf8');
    const rec = app.acquireInstanceLock(lockFile);
    assert.strictEqual(rec.acquired, true);
    assert.strictEqual(Number(fs.readFileSync(lockFile, 'utf8')), process.pid);

    // Simulate another live PID owning the lock using PPID (always alive)
    fs.writeFileSync(lockFile, String(process.ppid), 'utf8');
    const blocked = app.acquireInstanceLock(lockFile);
    assert.strictEqual(blocked.acquired, false);
    assert.strictEqual(blocked.existingPid, process.ppid);

    // Restore own PID and verify release cleans up file
    fs.writeFileSync(lockFile, String(process.pid), 'utf8');
    app.releaseInstanceLock(lockFile);
    assert.strictEqual(fs.existsSync(lockFile), false);
  });

  it('prevents overlapping runs with mutex and resets lock on scraper failure', async () => {
    let releaseScraper;
    const slowScraper = () => new Promise((resolve) => {
      releaseScraper = () => resolve({
        success: true,
        totalCruceros: 0,
        xlsxPath: xlsxFile,
        cruceros: []
      });
    });

    const p1 = app.runReportCycle({ scraperFn: slowScraper, usersFilePath: usersFile, sentOffersFilePath: offersFile });
    assert.strictEqual(app.isJobRunning(), true);

    const p2 = await app.runReportCycle({ scraperFn: slowScraper, usersFilePath: usersFile, sentOffersFilePath: offersFile });
    assert.strictEqual(p2.skipped, true);
    assert.strictEqual(p2.reason, 'JOB_ALREADY_RUNNING');

    releaseScraper();
    const r1 = await p1;
    assert.strictEqual(r1.success, true);
    assert.strictEqual(app.isJobRunning(), false);

    const failRes = await app.runReportCycle({
      scraperFn: async () => { throw new Error('Simulated crash'); },
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile
    });
    assert.strictEqual(failRes.success, false);
    assert.strictEqual(app.isJobRunning(), false);
  });

  it('starts and cancels scheduler cleanly including invalid cron fallback', () => {
    const job = app.startScheduler('invalid cron expression');
    assert.ok(job);
    app.stopScheduler();
    assert.strictEqual(app.getScheduledJob(), null);
  });

  it('migrates legacy users.json chat IDs and configures interactive per-user filters via buttons and text', async () => {
    // Simulate pre-existing legacy users.json containing a bare chatId
    fs.writeFileSync(usersFile, JSON.stringify([999888440]), 'utf8');
    assert.deepStrictEqual(app.loadUsers(usersFile), [999888440]);
    const initialFilters = app.getUserFilters(999888440, usersFile);
    assert.strictEqual(initialFilters.area, 'SOA');
    assert.strictEqual(initialFilters.cabin, '');

    const capturedScraperOpts = [];
    const mockBot = createMockBot();
    app.registerBotHandlers(mockBot, {
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: async (opts) => {
        capturedScraperOpts.push(opts);
        return {
          success: true,
          totalCruceros: 1,
          xlsxPath: xlsxFile,
          cruceros: [
            {
              destino: 'Caribe y Antillas',
              duracion: '8 Noches',
              barco: 'MSC Seascape',
              puerto_salida: 'Buenos Aires',
              precio: { moneda: 'USD', valor: 1150 },
              camarote: opts?.filters?.cabin || 'Vista al mar',
              fechas_disponibles: ['15 Ene 2027'],
              url_itinerario: 'https://www.msccruceros.com.ar',
              pagina: 1
            }
          ]
        };
      }
    });

    // 1. Open /filtros menu and verify keyboard contains 64-byte-safe callbacks
    await mockBot.simulateText(999888440, '/filtros');
    const menuMsg = mockBot.sentMessages.at(-1);
    assert.ok(menuMsg.text.includes('Tus filtros actuales'));
    const allCallbacks = menuMsg.options.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(allCallbacks.includes('flt:open:sub'));
    assert.ok(allCallbacks.includes('flt:open:trip'));
    assert.ok(allCallbacks.includes('flt:open:area'));
    assert.ok(allCallbacks.includes('flt:open:cab'));
    assert.ok(allCallbacks.every((cb) => Buffer.byteLength(cb, 'utf8') <= 64));

    // 2. Navigate submenus via inline buttons (multi-select toggles stay open in submenu)
    await mockBot.simulateCallback(999888440, 'flt:open:sub', menuMsg.message_id);
    await mockBot.simulateCallback(999888440, 'flt:sub:BF', menuMsg.message_id);
    await mockBot.simulateCallback(999888440, 'flt:sub:BR', menuMsg.message_id);
    assert.strictEqual(app.getUserFilters(999888440, usersFile).subcategory, 'black-friday,brasil');

    // Selecting area clears subcategory back to global search and toggles multiple destinations
    await mockBot.simulateCallback(999888440, 'flt:open:area', menuMsg.message_id);
    await mockBot.simulateCallback(999888440, 'flt:area:CAR', menuMsg.message_id);
    assert.strictEqual(app.getUserFilters(999888440, usersFile).subcategory, '');
    assert.strictEqual(app.getUserFilters(999888440, usersFile).area, 'SOA,CAR');
    await mockBot.simulateCallback(999888440, 'flt:area:SOA', menuMsg.message_id);
    assert.strictEqual(app.getUserFilters(999888440, usersFile).area, 'CAR');

    await mockBot.simulateCallback(999888440, 'flt:open:trip', menuMsg.message_id);
    await mockBot.simulateCallback(999888440, 'flt:trip:RT', menuMsg.message_id);

    // Ports start as BUE,MVD -> toggling MVD off leaves BUE
    await mockBot.simulateCallback(999888440, 'flt:open:port', menuMsg.message_id);
    await mockBot.simulateCallback(999888440, 'flt:port:MVD', menuMsg.message_id);
    assert.strictEqual(app.getUserFilters(999888440, usersFile).embkPort, 'BUE');

    // Select TWO cabin categories (Vista al mar + Camarote con balcón) without losing the first
    await mockBot.simulateCallback(999888440, 'flt:open:cab', menuMsg.message_id);
    await mockBot.simulateCallback(999888440, 'flt:cab:SEA', menuMsg.message_id);
    await mockBot.simulateCallback(999888440, 'flt:cab:BAL', menuMsg.message_id);
    const cabKeyboard = mockBot.editedMessages.at(-1).options.reply_markup.inline_keyboard.flat();
    assert.ok(cabKeyboard.some((b) => b.callback_data === 'flt:cab:SEA' && b.text.startsWith('✅ ')));
    assert.ok(cabKeyboard.some((b) => b.callback_data === 'flt:cab:BAL' && b.text.startsWith('✅ ')));

    // Select TWO duration buckets (6-7 and 8+)
    await mockBot.simulateCallback(999888440, 'flt:open:dur', menuMsg.message_id);
    await mockBot.simulateCallback(999888440, 'flt:dur:6-7', menuMsg.message_id);
    await mockBot.simulateCallback(999888440, 'flt:dur:8+', menuMsg.message_id);

    // 3. Manual price input with validation + success
    await mockBot.simulateCallback(999888440, 'flt:open:prc', menuMsg.message_id);
    await mockBot.simulateCallback(999888440, 'flt:prc:CUSTOM', menuMsg.message_id);
    await mockBot.simulateMessage(999888440, 'abc');
    assert.ok(mockBot.sentMessages.at(-1).text.includes('Ingresa un monto válido'));
    await mockBot.simulateMessage(999888440, '$1.250');

    // 4. Manual date range input with calendar validation + success
    await mockBot.simulateCallback(999888440, 'flt:open:date', menuMsg.message_id);
    await mockBot.simulateCallback(999888440, 'flt:date:custom', menuMsg.message_id);
    await mockBot.simulateMessage(999888440, '31/02/2027 - 15/03/2027');
    assert.ok(mockBot.sentMessages.at(-1).text.includes('Formato de fechas inválido'));
    await mockBot.simulateMessage(999888440, '01/12/2026 - 31/03/2027');

    const saved = app.getUserFilters(999888440, usersFile);
    assert.deepStrictEqual(saved, {
      company: '',
      subcategory: '',
      tripType: 'roundtrip',
      area: 'CAR',
      embkPort: 'BUE',
      datePreset: 'custom',
      dateFrom: '01/12/2026',
      dateTo: '31/03/2027',
      cabin: 'Vista al mar,Camarote con balcón',
      nights: '6-7,8+',
      maxPrice: 1250
    });

    // 5. Execute on-demand search from inline button using saved filters (2 cabins x 2 nights = 4 scrapes, 1 merged Excel)
    await mockBot.simulateCallback(999888440, 'flt:run', menuMsg.message_id);
    assert.strictEqual(capturedScraperOpts.length, 4);
    assert.strictEqual(mockBot.sentDocuments.length, 1);
    assert.ok(mockBot.sentMessages.some((m) => m.text.includes('Vista al mar') && m.text.includes('1150 USD')));
    assert.ok(mockBot.sentMessages.some((m) => m.text.includes('Camarote con balcón') && m.text.includes('1150 USD')));

    // 6. Reset filters button restores defaults
    await mockBot.simulateCallback(999888440, 'flt:reset', menuMsg.message_id);
    const reset = app.getUserFilters(999888440, usersFile);
    assert.strictEqual(reset.area, 'SOA');
    assert.strictEqual(reset.cabin, '');
    assert.strictEqual(reset.nights, '');
  });

  it('shares overlapping multi-cabin atomic scrapes across users in broadcast mode', async () => {
    const mockBot = createMockBot();
    app.saveUserRecords([
      { chatId: 111, filters: { area: 'SOA', cabin: 'Interior,Vista al mar', maxPrice: 950 } },
      { chatId: 222, filters: { area: 'SOA', cabin: 'Vista al mar', maxPrice: 950 } }
    ], usersFile);

    const seenCabins = [];
    const res = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: async (opts) => {
        seenCabins.push(opts.filters.cabin);
        return {
          success: true,
          totalCruceros: 1,
          xlsxPath: xlsxFile,
          cruceros: [
            {
              destino: 'Sudamérica',
              duracion: '8 Noches',
              barco: 'MSC Splendida',
              puerto_salida: 'Buenos Aires',
              precio: { moneda: 'USD', valor: opts.filters.cabin === 'Interior' ? 750 : 890 },
              camarote: opts.filters.cabin,
              fechas_disponibles: ['03 Dic 2026'],
              url_itinerario: 'https://www.msccruceros.com.ar/booking?cruiseId=SP01&adults=2&children=0&infants=0&juniors=0',
              pagina: 1
            }
          ]
        };
      }
    });

    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(seenCabins, ['Interior', 'Vista al mar']); // Vista al mar scraped ONCE and shared
    // 111 receives both Interior ($750) and Vista al mar ($890); 222 receives Vista al mar ($890)
    assert.strictEqual(res.offersSent, 3);
  });

  it('groups broadcast scrapes by unique search filters and enforces per-user maxPrice alerts', async () => {
    const mockBot = createMockBot();
    app.saveUserRecords([
      { chatId: 111, filters: { area: 'SOA', embkPort: 'BUE,MVD', cabin: 'Vista al mar', maxPrice: 950 } },
      { chatId: 222, filters: { area: 'SOA', embkPort: 'BUE,MVD', cabin: 'Vista al mar', maxPrice: 900 } },
      { chatId: 333, filters: { area: 'CAR', embkPort: '', cabin: '', maxPrice: 1300 } }
    ], usersFile);

    let scraperCalls = 0;
    const mockScraper = async (opts) => {
      scraperCalls++;
      if (opts.filters.area === 'SOA') {
        return {
          success: true,
          totalCruceros: 1,
          xlsxPath: xlsxFile,
          cruceros: [
            {
              destino: 'Sudamérica',
              duracion: '8 Noches',
              barco: 'MSC Splendida',
              puerto_salida: 'Buenos Aires',
              precio: { moneda: 'USD', valor: 941 },
              camarote: 'Vista al mar',
              fechas_disponibles: ['03 Dic 2026'],
              url_itinerario: 'https://www.msccruceros.com.ar',
              pagina: 1
            }
          ]
        };
      }
      return {
        success: true,
        totalCruceros: 1,
        xlsxPath: xlsxFile,
        cruceros: [
          {
            destino: 'Caribe',
            duracion: '7 Noches',
            barco: 'MSC World America',
            puerto_salida: 'Miami',
            precio: { moneda: 'USD', valor: 1200 },
            camarote: 'Todas',
            fechas_disponibles: ['12 Feb 2027'],
            url_itinerario: 'https://www.msccruceros.com.ar',
            pagina: 1
          }
        ]
      };
    };

    const res = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: mockScraper
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(scraperCalls, 2); // 111 & 222 share SOA scrape; 333 gets CAR scrape
    assert.strictEqual(res.documentsSent, 0); // automatic broadcast sends alerts only; Excel is on-demand
    // 111 receives $941 (<=950), 222 skips $941 (>900), 333 receives $1200 (<=1300)
    assert.strictEqual(res.offersSent, 2);
    assert.deepStrictEqual(mockBot.sentMessages.map((m) => m.chatId), [111, 333]);
  });

  it('handles ECONNREFUSED in Telegram polling backoff, send retries, IPv4 config, and manual error notice', async () => {
    const botOpts = app.buildBotOptions({ polling: true });
    assert.strictEqual(botOpts.request.family, 4);

    // 1. Retries transient ECONNREFUSED on sendMessage and notifies cleanly on manual MSC ECONNREFUSED
    const mockBot = createMockBot();
    let msgFailures = 0;
    const baseSend = mockBot.sendMessage.bind(mockBot);
    mockBot.sendMessage = async (chatId, text, options = {}) => {
      if (text.includes('¡Nueva oferta encontrada!') && msgFailures === 0) {
        msgFailures++;
        const err = new Error('connect ECONNREFUSED 149.154.167.220:443');
        err.code = 'EFATAL';
        throw err;
      }
      return baseSend(chatId, text, options);
    };

    let pollStops = 0;
    let pollStarts = 0;
    mockBot.stopPolling = async () => { pollStops++; };
    mockBot.startPolling = async () => { pollStarts++; };

    app.saveUserRecords([{ chatId: 444555, filters: { area: 'SOA', maxPrice: 900 } }], usersFile);

    let failScrape = false;
    app.registerBotHandlers(mockBot, {
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      pollingBackoffMs: [20, 40],
      telegramRetryDelayMs: 5,
      scraperFn: async () => {
        if (failScrape) {
          return {
            success: false,
            errorCode: 'ECONNREFUSED',
            error: 'Conexión rechazada (ECONNREFUSED) al conectar con https://www.msccruceros.com.ar'
          };
        }
        return {
          success: true,
          totalCruceros: 1,
          xlsxPath: xlsxFile,
          cruceros: [
            {
              destino: 'Sudamérica',
              duracion: '8 Noches',
              barco: 'MSC Splendida',
              puerto_salida: 'Buenos Aires',
              precio: { moneda: 'USD', valor: 750 },
              fechas_disponibles: ['03 Dic 2026'],
              url_itinerario: 'https://www.msccruceros.com.ar/booking?cruiseId=SP99&adults=2&children=0&infants=0&juniors=0',
              pagina: 1
            }
          ]
        };
      }
    });

    // Offer alert succeeds on retry 2 after transient EFATAL/ECONNREFUSED
    const cycleRes = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      telegramRetryDelayMs: 5,
      scraperFn: async () => ({
        success: true,
        totalCruceros: 1,
        xlsxPath: xlsxFile,
        cruceros: [
          {
            destino: 'Sudamérica',
            duracion: '8 Noches',
            barco: 'MSC Splendida',
            puerto_salida: 'Buenos Aires',
            precio: { moneda: 'USD', valor: 750 },
            fechas_disponibles: ['03 Dic 2026'],
            url_itinerario: 'https://www.msccruceros.com.ar/booking?cruiseId=SP99&adults=2&children=0&infants=0&juniors=0',
            pagina: 1
          }
        ]
      })
    });
    assert.strictEqual(cycleRes.offersSent, 1);
    assert.strictEqual(msgFailures, 1);

    // 2. Manual /report informs the user cleanly when MSC fails with ECONNREFUSED
    failScrape = true;
    await mockBot.simulateText(444555, '/report');
    assert.ok(mockBot.sentMessages.some((m) => m.chatId === 444555 && m.text.includes('ECONNREFUSED')));

    // 3. polling_error backs off via stopPolling -> startPolling cleanly
    const pollErr = new Error('connect ECONNREFUSED 149.154.167.220:443');
    pollErr.code = 'EFATAL';
    mockBot.emit('polling_error', pollErr);
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(pollStops, 1);
    assert.strictEqual(pollStarts, 1);
  });

  it('supports Costa Cruceros and multi-company filtering, alerts, and consolidated Excel reports', async () => {
    const mockBot = createMockBot();
    const mscMock = async () => ({
      success: true,
      totalCruceros: 1,
      cruceros: [
        {
          compania: 'MSC Cruceros',
          destino: 'Sudamérica',
          duracion: '8 Noches',
          barco: 'MSC Splendida',
          puerto_salida: 'Buenos Aires',
          precio: { moneda: 'USD', valor: 750 },
          fechas_disponibles: ['03 Dic 2026'],
          url_itinerario: 'https://www.msccruceros.com.ar/booking?cruiseId=SP01&adults=2&children=0&infants=0&juniors=0',
          pagina: 1
        }
      ]
    });

    app.registerBotHandlers(mockBot, {
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      scraperFn: mscMock,
      maxOfferPrice: 1000
    });

    // 1. User configures company filter via inline buttons
    await mockBot.simulateText(777888, '/start');
    const startMsg = mockBot.sentMessages.find((m) => m.chatId === 777888);
    await mockBot.simulateCallback(777888, 'flt:open:cmp', startMsg.message_id);
    const cmpKeyboard = mockBot.editedMessages.at(-1).options.reply_markup.inline_keyboard.flat();
    assert.ok(cmpKeyboard.some((b) => b.callback_data === 'flt:cmp:COSTA'));
    assert.ok(cmpKeyboard.some((b) => b.callback_data === 'flt:cmp:MSC'));
    assert.ok(cmpKeyboard.some((b) => b.callback_data === 'flt:cmp:ALL'));

    // Select Costa only
    await mockBot.simulateCallback(777888, 'flt:cmp:COSTA', startMsg.message_id);
    assert.strictEqual(app.getUserFilters(777888, usersFile).company, 'COSTA');

    // Reset back to All companies
    await mockBot.simulateCallback(777888, 'flt:cmp:ALL', startMsg.message_id);
    assert.strictEqual(app.getUserFilters(777888, usersFile).company, '');

    // 2. Multi-company run with MSC and Costa scrapers
    const costaMock = async () => ({
      success: true,
      totalCruceros: 1,
      cruceros: [
        {
          compania: 'Costa Cruceros',
          destino: 'América Del Sur',
          duracion: '4 días (3 noches)',
          barco: 'Costa Serena',
          puerto_salida: 'Buenos Aires',
          precio: { moneda: 'USD', valor: 306 },
          fechas_disponibles: ['16/03/2027'],
          url_itinerario: 'https://www.costacruceros.com/cruises/BUE03A14/SE03270316.html',
          pagina: 1
        }
      ]
    });

    assert.strictEqual(
      app.normalizeItineraryUrl('https://www.costacruceros.com/cruises/BUE01A05/SE01261227_BUE01A05.html'),
      'https://www.costacruceros.com/cruises/BUE01A05/SE01261227.html'
    );

    const cycleRes = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      mscScraperFn: mscMock,
      costaScraperFn: costaMock,
      sendDocument: true
    });

    assert.strictEqual(cycleRes.success, true);
    assert.strictEqual(cycleRes.totalCruceros, 2);
    assert.strictEqual(cycleRes.offersSent, 1);

    // Verify alert messages contain naviera line
    const costaAlert = mockBot.sentMessages.find((m) => m.text.includes('Costa Serena'));
    assert.ok(costaAlert);
    assert.ok(costaAlert.text.includes('🏢 Naviera: Costa Cruceros'));

    const mscAlert = mockBot.sentMessages.find((m) => m.text.includes('MSC Splendida'));
    assert.ok(mscAlert);
    assert.ok(mscAlert.text.includes('🏢 Naviera: MSC Cruceros'));

    // Verify /offers lists both with tags
    await mockBot.simulateText(777888, '/offers');
    const offersMsg = mockBot.sentMessages.at(-1);
    assert.ok(offersMsg.text.includes('[Costa Cruceros]'));
    assert.ok(offersMsg.text.includes('[MSC Cruceros]'));

    // 3. Costa deduplication parity: legacy ID, cabin casing, higher price -> 0 alerts; price drop -> 1 alert
    const costaSameOrHigherMock = async () => ({
      success: true,
      totalCruceros: 1,
      cruceros: [
        {
          compania: 'Costa Cruceros',
          destino: 'América Del Sur',
          duracion: '4 días (3 noches)',
          barco: 'Costa Serena',
          puerto_salida: 'Buenos Aires',
          precio: { moneda: 'USD', valor: 350 },
          fechas_disponibles: ['16/03/2027'],
          camarote: '  todas ',
          url_itinerario: 'https://www.costacruceros.com/cruises/BUE03A14/SE03270316_BUE03A14.html',
          cruiseId: 'SE03270316_BUE03A14',
          pagina: 1
        }
      ]
    });

    const dupCycleRes = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      mscScraperFn: mscMock,
      costaScraperFn: costaSameOrHigherMock,
      sendDocument: false
    });
    assert.strictEqual(dupCycleRes.success, true);
    assert.strictEqual(dupCycleRes.offersSent, 0);

    const costaDropMock = async () => ({
      success: true,
      totalCruceros: 1,
      cruceros: [
        {
          compania: 'Costa Cruceros',
          destino: 'América Del Sur',
          duracion: '4 días (3 noches)',
          barco: 'Costa Serena',
          puerto_salida: 'Buenos Aires',
          precio: { moneda: 'USD', valor: 280 },
          fechas_disponibles: ['16/03/2027'],
          url_itinerario: 'https://www.costacruceros.com/cruises/BUE03A14/SE03270316.html',
          pagina: 1
        }
      ]
    });

    const dropCycleRes = await app.runReportCycle({
      bot: mockBot,
      usersFilePath: usersFile,
      sentOffersFilePath: offersFile,
      mscScraperFn: mscMock,
      costaScraperFn: costaDropMock,
      sendDocument: false
    });
    assert.strictEqual(dropCycleRes.success, true);
    assert.strictEqual(dropCycleRes.offersSent, 1);
  });
});
