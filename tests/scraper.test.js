const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ExcelJS = require('exceljs');

const createFile = require('../msc_scrapper_excel');
const mscCli = require('../msc_scrapper');

const {
  calculateDepartureDates,
  resolveSearchDates,
  buildSearchUrl,
  expandFilterCombos,
  discoverPromoLinks,
  parsePrice,
  dismissCookieBanner,
  createExcelReport,
  navigateWithRetry,
  isTransientNetworkError,
  isConnectionRefusedError,
  HEADERS
} = createFile;

describe('Scraper & Excel Generator (msc_scrapper_excel.js & msc_scrapper.js)', () => {
  let server;
  let serverUrl;
  let tmpDir;
  let flakyHits = 0;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dts-scraper-test-'));

    server = http.createServer((req, res) => {
      const { pathname } = new URL(req.url, 'http://127.0.0.1');

      if (pathname === '/cruises') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <body>
            <div class="cruise-card results-wrapper__cruise-card" data-cruise-id="SP_001">
              <p class="description__title">Sudamérica</p>
              <div class="description" cruise-id="SP_001">
                <div class="badge"><span>8 Noches</span></div>
                <div class="tw-text-sm"><span>IDA Y VUELTA DESDE:</span><span>Buenos Aires, Argentina</span></div>
              </div>
              <span class="ship-name">MSC Splendida</span>
              <span class="prices__main-price"><span>771 USD</span></span>
              <div class="badge--theme--bestprice">Mejor precio</div>
              <button class="date-item"><span class="date-item__label">Jueves 3</span><span class="date-item__label">Dic. 2026</span></button>
            </div>
            <div class="cruise-card results-wrapper__cruise-card" data-cruise-id="SP_002">
              <p class="description__title">Brasil & Uruguay</p>
              <div class="description" cruise-id="SP_002">
                <div class="badge"><span>9 Noches</span></div>
                <div class="tw-text-sm"><span>Montevideo, Uruguay</span></div>
              </div>
              <span class="ship-name">MSC Fantasia</span>
              <span class="prices__main-price"><span>USD 1.370</span></span>
            </div>
            <ul class="pagination">
              <li class="number active">1</li>
              <li class="number"><a href="/cruises-p2">2</a></li>
              <li class="right-arrow"><a href="/cruises-p2">Siguiente</a></li>
            </ul>
          </body>
          </html>
        `);
      } else if (pathname === '/skeleton-then-hydrated') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <body>
            <div id="results">
              <div class="tw-animate-pulse results-wrapper__cruise-card"></div>
              <div class="tw-animate-pulse results-wrapper__cruise-card"></div>
            </div>
            <script>
              setTimeout(() => {
                document.getElementById('results').innerHTML = \`
                  <div class="cruise-card results-wrapper__cruise-card" data-cruise-id="LIVE_1">
                    <h3 class="description__title">Sudamérica</h3>
                    <div class="description"><div class="badge"><span>8 Noches</span></div><div class="tw-text-sm"><span>Buenos Aires, Argentina</span></div></div>
                    <div class="ship-name">MSC Splendida</div>
                    <div class="prices__main-price"><span>771 USD</span></div>
                  </div>
                \`;
              }, 350);
            </script>
          </body>
          </html>
        `);
      } else if (pathname === '/empty') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><body><div class="no-results-banner">Sin resultados</div></body></html>');
      } else if (pathname === '/filter-demo') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <body>
            <button automation-id="search-advanced-filters-button" onclick="document.querySelector('.filters-dropdown').style.display='block'">Filtros</button>
            <div class="filters-dropdown advanced-search-app" style="display:none">
              <div automation-id="search-nights">
                <label class="checkbox-label" data-val="1-5"><input type="checkbox" value="1-5">1-5</label>
                <label class="checkbox-label" data-val="8+"><input type="checkbox" value="8+">8+</label>
              </div>
              <div automation-id="search-cabins">
                <label class="checkbox-label" data-val="Interior"><input type="checkbox" value="Interior">Interior</label>
                <label class="checkbox-label" data-val="Vista al mar"><input type="checkbox" value="Vista al mar">Vista al mar</label>
              </div>
              <button type="button" onclick="applyDemoFilters()">Buscar</button>
            </div>
            <div class="pagination-wrp__counter">1-1 of 20 Itinerarios</div>
            <div id="cards">
              <div class="cruise-card" data-cruise-id="SP_001">
                <p class="description__title">Sudamérica</p>
                <div class="description"><div class="badge"><span>8 Noches</span></div><div class="tw-text-sm"><span>Buenos Aires</span></div></div>
                <span class="ship-name">MSC Splendida</span>
                <span class="prices__main-price"><span>771 USD</span></span>
              </div>
            </div>
            <script>
              function applyDemoFilters() {
                const checkedCab = document.querySelector('[automation-id="search-cabins"] input:checked')?.value;
                const checkedNights = document.querySelector('[automation-id="search-nights"] input:checked')?.value;
                if (checkedCab === 'Vista al mar' && checkedNights === '8+') {
                  document.querySelector('.pagination-wrp__counter').textContent = '1-1 of 11 Itinerarios';
                  document.querySelector('.prices__main-price span').textContent = '941 USD';
                }
              }
            </script>
          </body>
          </html>
        `);
      } else if (pathname === '/oneway-demo') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <body>
            <div class="cruise-card" data-cruise-id="SV_ONEWAY">
              <p class="description__title">Sudamérica</p>
              <div class="description" cruise-id="SV_ONEWAY">
                <div class="badge"><span>3 Noches</span></div>
                <div class="tw-text-sm">
                  <span><strong>VIAJE DE IDA DESDE:</strong></span>
                  <span>Buenos Aires, Argentina</span>
                  <span><strong>HACIA:</strong></span>
                  <span>Santos (São Paulo), Brasil</span>
                </div>
              </div>
              <span class="ship-name">MSC Seaview</span>
              <span class="prices__main-price"><span>386 USD</span></span>
            </div>
            <div class="cruise-card" data-cruise-id="SP_RT">
              <p class="description__title">Sudamérica</p>
              <div class="description" cruise-id="SP_RT">
                <div class="badge"><span>8 Noches</span></div>
                <div class="tw-text-sm"><span>IDA Y VUELTA DESDE:</span><span>Buenos Aires, Argentina</span></div>
              </div>
              <span class="ship-name">MSC Splendida</span>
              <span class="prices__main-price"><span>771 USD</span></span>
            </div>
          </body>
          </html>
        `);
      } else if (pathname === '/promos-hub') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <body>
            <a href="/ofertas-cruceros">Todas las ofertas</a>
            <a href="/ofertas-cruceros/black-friday">Black Friday Sudamérica</a>
            <a href="/ofertas-cruceros/cyber-week">Cyber Week Especial Reservá ya</a>
            <a href="/ofertas-cruceros/cyber-week">Duplicado Cyber Week</a>
            <a href="/ofertas-cruceros/2027-cruises">2027</a>
            <a href="/ofertas-cruceros/stay-and-cruise">Stay &amp; Cruise</a>
            <a href="/ofertas-cruceros/nuestras-tarifas">Nuestras tarifas</a>
          </body>
          </html>
        `);
      } else if (pathname === '/flaky-once') {
        flakyHits++;
        if (flakyHits === 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <body>
            <div class="cruise-card" data-cruise-id="FLAKY_OK">
              <p class="description__title">Sudamérica</p>
              <div class="description" cruise-id="FLAKY_OK"><div class="badge"><span>7 Noches</span></div></div>
              <span class="ship-name">MSC Armonia</span>
              <span class="prices__main-price"><span>650 USD</span></span>
            </div>
          </body>
          </html>
        `);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('calculates rolling departure dates with leap-year and month-end clamping', () => {
    const leap = calculateDepartureDates(new Date(2024, 1, 29));
    assert.strictEqual(leap.departureDateFrom, '29/02/2024');
    assert.strictEqual(leap.departureDateTo, '29/08/2025');

    const aug31 = calculateDepartureDates(new Date(2024, 7, 31));
    assert.strictEqual(aug31.departureDateFrom, '31/08/2024');
    assert.strictEqual(aug31.departureDateTo, '28/02/2026');

    assert.throws(() => calculateDepartureDates(new Date('invalid')), /Invalid baseDate/);
  });

  it('builds properly encoded MSC search URLs with and without filters', () => {
    const legacyUrl = buildSearchUrl({ departureDateFrom: '15/11/2026', departureDateTo: '15/05/2028' }, 2);
    assert.ok(legacyUrl.includes('departureDateFrom=15%2F11%2F2026'));
    assert.ok(legacyUrl.includes('departureDateTo=15%2F05%2F2028'));
    assert.ok(legacyUrl.includes('page=2'));

    const filteredCar = buildSearchUrl({ departureDateFrom: '15/11/2026', departureDateTo: '15/11/2027' }, 1, {
      area: 'CAR',
      embkPort: 'BUE'
    });
    assert.ok(filteredCar.includes('/Search%20Result?'));
    assert.ok(filteredCar.includes('area=CAR'));
    assert.ok(filteredCar.includes('embkPort=BUE'));

    const unfilteredGlobal = buildSearchUrl({ departureDateFrom: '15/11/2026', departureDateTo: '15/11/2027' }, 1, {
      area: '',
      embkPort: ''
    });
    assert.ok(unfilteredGlobal.includes('/Search%20Result?'));
    assert.ok(!unfilteredGlobal.includes('area='));
    assert.ok(!unfilteredGlobal.includes('embkPort='));

    const preset6m = resolveSearchDates({ datePreset: '6m' }, new Date(2026, 10, 15));
    assert.strictEqual(preset6m.departureDateFrom, '15/11/2026');
    assert.strictEqual(preset6m.departureDateTo, '15/05/2027');

    const presetCustom = resolveSearchDates({ dateFrom: '01/12/2026', dateTo: '31/03/2027' });
    assert.deepStrictEqual(presetCustom, { departureDateFrom: '01/12/2026', departureDateTo: '31/03/2027' });

    const subBlackFriday = buildSearchUrl({ departureDateFrom: '15/11/2026', departureDateTo: '15/05/2028' }, 1, {
      subcategory: 'black-friday'
    });
    assert.strictEqual(subBlackFriday, 'https://www.msccruceros.com.ar/ofertas-cruceros/black-friday');

    const subGrandVoyagesP2 = buildSearchUrl({ departureDateFrom: '15/11/2026', departureDateTo: '15/05/2028' }, 2, {
      subcategory: 'grand-voyages'
    });
    assert.strictEqual(subGrandVoyagesP2, 'https://www.msccruceros.com.ar/ofertas-cruceros/tarifa-especial--grand-voyage?page=2');

    const subDynamicSlug = buildSearchUrl({ departureDateFrom: '15/11/2026', departureDateTo: '15/05/2028' }, 1, {
      subcategory: 'cyber-week'
    });
    assert.strictEqual(subDynamicSlug, 'https://www.msccruceros.com.ar/ofertas-cruceros/cyber-week');

    const multiArea = buildSearchUrl({ departureDateFrom: '15/11/2026', departureDateTo: '15/05/2028' }, 1, {
      area: 'SOA,CAR',
      embkPort: 'BUE,MVD',
      cabin: 'Vista al mar'
    });
    assert.ok(multiArea.includes('area=SOA%2CCAR'));
    assert.ok(multiArea.includes('embkPort=BUE%2CMVD'));
    assert.ok(multiArea.includes('cabins=Vista+al+mar') || multiArea.includes('cabins=Vista%20al%20mar'));

    const combos = expandFilterCombos({
      area: 'SOA,CAR',
      embkPort: 'BUE,MVD',
      cabin: 'Interior,Vista al mar',
      nights: '6-7,8+'
    });
    assert.strictEqual(combos.length, 4);
    assert.strictEqual(combos[0].area, 'SOA,CAR');
    assert.strictEqual(combos[0].cabin, 'Interior');
    assert.strictEqual(combos[0].nights, '6-7');
    assert.strictEqual(combos[3].cabin, 'Vista al mar');
    assert.strictEqual(combos[3].nights, '8+');
  });

  it('parses USD, ARS, EUR and thousand-dot prices into numeric values', () => {
    assert.deepStrictEqual(parsePrice('771 USD'), { moneda: 'USD', valor: 771 });
    assert.deepStrictEqual(parsePrice('USD 1.234'), { moneda: 'USD', valor: 1234 });
    assert.deepStrictEqual(parsePrice('ARS 1.500.000'), { moneda: 'ARS', valor: 1500000 });
    assert.deepStrictEqual(parsePrice('890 EUR'), { moneda: 'EUR', valor: 890 });
    assert.deepStrictEqual(parsePrice(''), { moneda: 'USD', valor: 0 });
    assert.deepStrictEqual(parsePrice(null), { moneda: 'USD', valor: 0 });
  });

  it('dismisses Didomi banner gracefully whether present or absent', async () => {
    let clicked = false;
    const withBanner = {
      waitForSelector: async () => ({ click: async () => { clicked = true; } }),
      waitForFunction: async () => true
    };
    assert.strictEqual(await dismissCookieBanner(withBanner, 500), true);
    assert.strictEqual(clicked, true);

    const noBanner = {
      waitForSelector: async () => { throw new Error('timeout'); },
      evaluate: async () => false
    };
    assert.strictEqual(await dismissCookieBanner(noBanner, 50), false);
    assert.strictEqual(await dismissCookieBanner(null), false);
  });

  it('generates formatted Excel report with headers and numeric price cells', async () => {
    const outXlsx = path.join(tmpDir, 'report.xlsx');
    const sample = [
      {
        destino: 'Sudamérica',
        duracion: '8 Noches',
        barco: 'MSC Splendida',
        puerto_salida: 'Buenos Aires, Argentina',
        precio: { moneda: 'USD', valor: 771 },
        fechas_disponibles: ['03 Dic 2026'],
        promocion: 'Mejor precio',
        url_itinerario: 'https://www.msccruceros.com.ar',
        pagina: 1
      },
      {
        destino: 'Brasil',
        duracion: '9 Noches',
        barco: 'MSC Fantasia',
        puerto_salida: 'Montevideo',
        precio: { moneda: 'USD', valor: 1370 },
        fechas_disponibles: [],
        promocion: null,
        url_itinerario: 'https://www.msccruceros.com.ar',
        pagina: 1
      }
    ];

    const res = await createExcelReport(sample, outXlsx);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.rowCount, 2);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outXlsx);
    const ws = wb.getWorksheet('Cruceros MSC');
    assert.ok(ws);
    assert.deepStrictEqual(ws.getRow(1).values.slice(1), HEADERS);
    assert.strictEqual(ws.getRow(2).getCell(6).value, 771);
    assert.strictEqual(ws.getRow(2).getCell(6).numFmt, '#,##0');
    assert.strictEqual(ws.getRow(3).getCell(8).value, 'N/A');
  });

  it('extracts cruise cards via Puppeteer and stops at maxPages', async () => {
    const outXlsx = path.join(tmpDir, 'scraped.xlsx');
    const outJson = path.join(tmpDir, 'scraped.json');

    const res = await createFile({
      customUrl: `${serverUrl}/cruises`,
      outputPath: outXlsx,
      jsonPath: outJson,
      headless: true,
      maxPages: 1
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.totalCruceros, 2);
    assert.strictEqual(res.cruceros[0].barco, 'MSC Splendida');
    assert.strictEqual(res.cruceros[0].precio.valor, 771);
    assert.strictEqual(
      res.cruceros[0].url_itinerario,
      'https://www.msccruceros.com.ar/booking?cruiseId=SP_001&adults=2&children=0&infants=0&juniors=0'
    );
    assert.deepStrictEqual(res.cruceros[0].fechas_disponibles, ['Jueves 3 Dic. 2026']);
    assert.strictEqual(res.cruceros[1].precio.valor, 1370);
    assert.ok(fs.existsSync(outXlsx));
    assert.ok(fs.existsSync(outJson));
  });

  it('ignores .tw-animate-pulse skeleton cards until real .cruise-card elements hydrate', async () => {
    const outXlsx = path.join(tmpDir, 'hydrated.xlsx');
    const outJson = path.join(tmpDir, 'hydrated.json');

    const res = await createFile({
      customUrl: `${serverUrl}/skeleton-then-hydrated`,
      outputPath: outXlsx,
      jsonPath: outJson,
      headless: true,
      maxPages: 1
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.totalCruceros, 1);
    assert.strictEqual(res.cruceros[0].barco, 'MSC Splendida');
    assert.strictEqual(res.cruceros[0].precio.valor, 771);
  });

  it('handles empty search results and unreachable URLs cleanly', async () => {
    const emptyRes = await createFile({
      customUrl: `${serverUrl}/empty`,
      outputPath: path.join(tmpDir, 'empty.xlsx'),
      jsonPath: path.join(tmpDir, 'empty.json'),
      headless: true,
      maxPages: 1
    });
    assert.strictEqual(emptyRes.success, true);
    assert.strictEqual(emptyRes.totalCruceros, 0);

    const failRes = await createFile({
      customUrl: 'http://127.0.0.1:59999/unreachable',
      outputPath: path.join(tmpDir, 'fail.xlsx'),
      jsonPath: path.join(tmpDir, 'fail.json'),
      headless: true,
      maxPages: 1,
      navigationRetries: 1,
      retryDelayMs: 30
    });
    assert.strictEqual(failRes.success, false);
    assert.strictEqual(failRes.errorCode, 'ECONNREFUSED');
    assert.ok(failRes.error.includes('ECONNREFUSED'));
  });

  it('retries transient ECONNREFUSED / connection resets cleanly before succeeding', async () => {
    let mockAttempts = 0;
    const mockPage = {
      goto: async () => {
        mockAttempts++;
        if (mockAttempts < 2) {
          throw new Error('net::ERR_CONNECTION_REFUSED at https://www.msccruceros.com.ar');
        }
        return 'ok';
      }
    };
    assert.strictEqual(isConnectionRefusedError(new Error('connect ECONNREFUSED 127.0.0.1:443')), true);
    assert.strictEqual(isTransientNetworkError(new Error('net::ERR_CONNECTION_RESET')), true);
    assert.strictEqual(isTransientNetworkError(new Error('Unexpected token')), false);

    const navRes = await navigateWithRetry(mockPage, 'https://example.test', {
      navigationRetries: 2,
      retryDelayMs: 10
    });
    assert.strictEqual(navRes, 'ok');
    assert.strictEqual(mockAttempts, 2);

    // End-to-end Puppeteer retry after dropped connection on /flaky-once
    flakyHits = 0;
    const recovered = await createFile({
      customUrl: `${serverUrl}/flaky-once`,
      outputPath: path.join(tmpDir, 'recovered.xlsx'),
      jsonPath: path.join(tmpDir, 'recovered.json'),
      headless: true,
      maxPages: 1,
      navigationRetries: 2,
      retryDelayMs: 50
    });
    assert.strictEqual(recovered.success, true);
    assert.strictEqual(recovered.totalCruceros, 1);
    assert.strictEqual(recovered.cruceros[0].barco, 'MSC Armonia');
  });

  it('runs msc_scrapper.js CLI and exports expected functions', async () => {
    assert.strictEqual(typeof mscCli.runCLI, 'function');
    assert.strictEqual(mscCli.createFile, createFile);

    const cliXlsx = path.join(tmpDir, 'cli.xlsx');
    const cliJson = path.join(tmpDir, 'cli.json');
    const exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        path.resolve(__dirname, '../msc_scrapper.js'),
        `--url=${serverUrl}/cruises`,
        '--max-pages=1',
        `--xlsx=${cliXlsx}`,
        `--json=${cliJson}`
      ]);
      child.on('exit', resolve);
    });

    assert.strictEqual(exitCode, 0);
    assert.ok(fs.existsSync(cliXlsx));
    assert.ok(fs.existsSync(cliJson));
  });

  it('applies cabin and nights UI filters via advanced filter drawer in Puppeteer', async () => {
    const outXlsx = path.join(tmpDir, 'filtered.xlsx');
    const outJson = path.join(tmpDir, 'filtered.json');

    const res = await createFile({
      customUrl: `${serverUrl}/filter-demo`,
      outputPath: outXlsx,
      jsonPath: outJson,
      headless: true,
      maxPages: 1,
      filters: {
        cabin: 'Vista al mar',
        nights: '8+'
      }
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.totalCruceros, 1);
    assert.strictEqual(res.cruceros[0].precio.valor, 941);
    assert.strictEqual(res.cruceros[0].camarote, 'Vista al mar');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outXlsx);
    const ws = wb.getWorksheet('Cruceros MSC');
    assert.strictEqual(ws.getRow(2).getCell(11).value, 'Vista al mar');

    // Multi-cabin direct createFile call expands into combined Excel rows per category
    const multiXlsx = path.join(tmpDir, 'multi_cabin.xlsx');
    const multiRes = await createFile({
      customUrl: `${serverUrl}/filter-demo`,
      outputPath: multiXlsx,
      jsonPath: path.join(tmpDir, 'multi_cabin.json'),
      headless: true,
      maxPages: 1,
      filters: {
        cabin: 'Interior,Vista al mar',
        nights: '8+'
      }
    });
    assert.strictEqual(multiRes.success, true);
    assert.strictEqual(multiRes.totalCruceros, 2);
    assert.deepStrictEqual(multiRes.cruceros.map((c) => c.camarote), ['Interior', 'Vista al mar']);
    const multiWb = new ExcelJS.Workbook();
    await multiWb.xlsx.readFile(multiXlsx);
    const multiWs = multiWb.getWorksheet('Cruceros MSC');
    assert.strictEqual(multiWs.getRow(2).getCell(11).value, 'Interior');
    assert.strictEqual(multiWs.getRow(3).getCell(11).value, 'Vista al mar');
  });

  it('parses one-way DESDE/HACIA routes cleanly and filters by tripType (roundtrip vs oneway)', async () => {
    const allRes = await createFile({
      customUrl: `${serverUrl}/oneway-demo`,
      outputPath: path.join(tmpDir, 'all_trips.xlsx'),
      jsonPath: path.join(tmpDir, 'all_trips.json'),
      headless: true,
      maxPages: 1
    });
    assert.strictEqual(allRes.totalCruceros, 2);
    assert.strictEqual(allRes.cruceros[0].puerto_salida, 'Buenos Aires, Argentina → Santos (São Paulo), Brasil (Solo ida)');
    assert.strictEqual(allRes.cruceros[0].solo_ida, true);
    assert.strictEqual(allRes.cruceros[1].puerto_salida, 'Buenos Aires, Argentina');
    assert.strictEqual(allRes.cruceros[1].solo_ida, false);

    const rtRes = await createFile({
      customUrl: `${serverUrl}/oneway-demo`,
      outputPath: path.join(tmpDir, 'rt_trips.xlsx'),
      jsonPath: path.join(tmpDir, 'rt_trips.json'),
      headless: true,
      maxPages: 1,
      filters: { tripType: 'roundtrip' }
    });
    assert.strictEqual(rtRes.totalCruceros, 1);
    assert.strictEqual(rtRes.cruceros[0].precio.valor, 771);

    const owRes = await createFile({
      customUrl: `${serverUrl}/oneway-demo`,
      outputPath: path.join(tmpDir, 'ow_trips.xlsx'),
      jsonPath: path.join(tmpDir, 'ow_trips.json'),
      headless: true,
      maxPages: 1,
      filters: { tripType: 'oneway' }
    });
    assert.strictEqual(owRes.totalCruceros, 1);
    assert.strictEqual(owRes.cruceros[0].precio.valor, 386);
  });

  it('discovers active /ofertas-cruceros/<slug> promo sublinks cleanly and ignores excluded pages', async () => {
    const res = await discoverPromoLinks({ sourceUrl: `${serverUrl}/promos-hub`, headless: true });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.links.length, 2);
    assert.strictEqual(res.links[0].slug, 'black-friday');
    assert.strictEqual(res.links[1].slug, 'cyber-week');
    assert.strictEqual(res.links[1].label, 'Cyber Week Especial');
  });
});
