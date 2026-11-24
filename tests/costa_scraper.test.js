const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ExcelJS = require('exceljs');

const costaScraper = require('../costa_scrapper_excel');
const costaCli = require('../costa_scrapper');

describe('Costa Cruceros Scraper & Excel Generator (costa_scrapper_excel.js & costa_scrapper.js)', () => {
  it('calculates Costa search dates with presets and custom ranges', () => {
    const base = new Date(2026, 10, 23); // 23 Nov 2026
    const def = costaScraper.resolveCostaSearchDates({}, base);
    assert.strictEqual(def.departureDateFrom, '23/11/2026');
    assert.strictEqual(def.departureDateTo, '23/05/2028');

    const p6m = costaScraper.resolveCostaSearchDates({ datePreset: '6m' }, base);
    assert.strictEqual(p6m.departureDateFrom, '23/11/2026');
    assert.strictEqual(p6m.departureDateTo, '23/05/2027');

    const pSummer = costaScraper.resolveCostaSearchDates({ datePreset: 'summer' }, base);
    assert.strictEqual(pSummer.departureDateFrom, '01/12/2026');
    assert.strictEqual(pSummer.departureDateTo, '31/03/2027');

    const pCustom = costaScraper.resolveCostaSearchDates({
      datePreset: 'custom',
      dateFrom: '15/01/2027',
      dateTo: '28/02/2027'
    }, base);
    assert.strictEqual(pCustom.departureDateFrom, '15/01/2027');
    assert.strictEqual(pCustom.departureDateTo, '28/02/2027');
  });

  it('builds properly encoded Solr query URLs for Costa search API', () => {
    const dates = { fromIso: '2026-12-01T00:00:00.000Z', toIso: '2027-04-01T00:00:00.000Z' };

    // Default (BUE, MVD ports, soldOut false, price positive)
    const urlDefault = costaScraper.buildCostaSearchUrl(dates, 1);
    assert.ok(urlDefault.startsWith('https://www.costacruceros.com/search/costa_es_AR/cruisesearch?'));
    assert.ok(urlDefault.includes('fq=soldOut:(false)'));
    assert.ok(urlDefault.includes('embarkPortCode:(\\BUE%20OR%20\\MVD)'));
    assert.ok(urlDefault.includes('rows=100'));

    // Filter by specific area and port
    const urlFiltered = costaScraper.buildCostaSearchUrl(dates, 2, {
      area: 'CAR',
      embkPort: 'BUE',
      tripType: 'roundtrip',
      nights: '6-7'
    }, 25);

    assert.ok(urlFiltered.includes('destinationIds:(\\CA)'));
    assert.ok(urlFiltered.includes('embarkPortCode:(\\BUE)'));
    assert.ok(urlFiltered.includes('sameEmbarkDisembarkPort:true'));
    assert.ok(urlFiltered.includes('duration:([7%20TO%208])'));
    assert.ok(urlFiltered.includes('rows=25'));
    assert.ok(urlFiltered.includes('start=25')); // Page 2 with 25 rows = start 25
  });

  it('parses raw Solr cruise items into normalized DrinkTheStick objects', () => {
    const mockSolrItem = {
      itineraryId: 'BUE01A05',
      itineraryPath: '/content/costa/master_website/es_AR/cruises/BUE01A05/SE01261227.html',
      cruiseId: 'SE01261227_BUE01A05',
      destinationName: 'América Del Sur ',
      shipName: 'Costa Serena',
      dayAndNightName: '2 días (1 noche)',
      departurePortName: 'Buenos Aires',
      departurePortCode: 'BUE',
      arrivalPortName: 'Montevideo',
      arrivalPortCode: 'MVD',
      departureDate: '2026-12-27T00:00:00Z',
      price_USD_anonymous: '183.0',
      roomTypeName_USD_anonymous: 'Interior',
      cruiseThematic: { imageUrl: '', imageAlt: '', text: '' }
    };

    const parsed = costaScraper.parseCostaSearchResultItem(mockSolrItem, 1);
    assert.strictEqual(parsed.compania, 'Costa Cruceros');
    assert.strictEqual(parsed.barco, 'Costa Serena');
    assert.strictEqual(parsed.destino, 'América Del Sur');
    assert.strictEqual(parsed.duracion, '2 días (1 noche)');
    assert.strictEqual(parsed.puerto_salida, 'Buenos Aires → Montevideo (Solo ida)');
    assert.strictEqual(parsed.solo_ida, true);
    assert.strictEqual(parsed.precio.valor, 183);
    assert.strictEqual(parsed.precio.moneda, 'USD');
    assert.strictEqual(parsed.camarote, 'Interior');
    assert.strictEqual(parsed.promocion, null);
    assert.strictEqual(parsed.cruiseId, 'SE01261227_BUE01A05');
    assert.strictEqual(parsed.url_itinerario, 'https://www.costacruceros.com/cruises/BUE01A05/SE01261227.html');
    assert.strictEqual(parsed.fechas_disponibles[0], '27/12/2026');

    // Fallback URL without itineraryPath strips _<itineraryId> suffix and parses non-empty thematic text
    const parsedFallback = costaScraper.parseCostaSearchResultItem({
      ...mockSolrItem,
      itineraryPath: '',
      cruiseThematic: { imageUrl: '', imageAlt: '', text: 'Promo Verano' }
    }, 1);
    assert.strictEqual(parsedFallback.url_itinerario, 'https://www.costacruceros.com/cruises/BUE01A05/SE01261227.html');
    assert.strictEqual(parsedFallback.promocion, 'Promo Verano');

    // Skips sold out or non-sellable items
    assert.strictEqual(costaScraper.parseCostaSearchResultItem({ ...mockSolrItem, isSoldOut: true }), null);
    assert.strictEqual(costaScraper.parseCostaSearchResultItem({ ...mockSolrItem, isSellable: false }), null);
  });

  it('generates formatted Excel report with Costa institutional header', async () => {
    const tmpXlsx = path.join(os.tmpdir(), `test_costa_excel_${Date.now()}.xlsx`);
    const mockCruises = [
      {
        compania: 'Costa Cruceros',
        destino: 'América Del Sur',
        duracion: '4 días (3 noches)',
        barco: 'Costa Serena',
        puerto_salida: 'Buenos Aires',
        precio: { moneda: 'USD', valor: 306 },
        fechas_disponibles: ['16/03/2027'],
        promocion: 'Oferta Costa',
        url_itinerario: 'https://www.costacruceros.com/cruises/BUE03A14/SE03270316.html',
        pagina: 1,
        camarote: 'Interior'
      }
    ];

    try {
      await costaScraper.createCostaExcelReport(mockCruises, tmpXlsx);
      assert.ok(fs.existsSync(tmpXlsx));

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(tmpXlsx);
      const ws = wb.getWorksheet('Cruceros Costa');
      assert.ok(ws);
      assert.strictEqual(ws.rowCount, 2);
      assert.strictEqual(ws.getRow(1).getCell(1).value, 'Compañía');
      assert.strictEqual(ws.getRow(2).getCell(1).value, 'Costa Cruceros');
      assert.strictEqual(ws.getRow(2).getCell(4).value, 'Costa Serena');
      assert.strictEqual(ws.getRow(2).getCell(7).value, 306);
    } finally {
      if (fs.existsSync(tmpXlsx)) fs.unlinkSync(tmpXlsx);
    }
  });

  it('handles empty results and network error fallbacks cleanly', async () => {
    const tmpXlsx = path.join(os.tmpdir(), `test_costa_empty_${Date.now()}.xlsx`);
    const tmpJson = path.join(os.tmpdir(), `test_costa_empty_${Date.now()}.json`);

    try {
      // Mock request returning empty results
      const mockEmptyRequest = async () => ({ searchResults: [] });
      const res = await costaScraper.createCostaFile({
        outputPath: tmpXlsx,
        jsonPath: tmpJson,
        requestFn: mockEmptyRequest
      });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.totalCruceros, 0);

      // Mock request throwing network error
      const mockFailRequest = async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
        err.code = 'ECONNREFUSED';
        throw err;
      };
      const failRes = await costaScraper.createCostaFile({
        outputPath: tmpXlsx,
        jsonPath: tmpJson,
        requestFn: mockFailRequest
      });

      assert.strictEqual(failRes.success, false);
      assert.strictEqual(failRes.errorCode, 'ECONNREFUSED');
    } finally {
      if (fs.existsSync(tmpXlsx)) fs.unlinkSync(tmpXlsx);
      if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
    }
  });

  it('exports CLI runner and expected scraper functions', () => {
    assert.strictEqual(typeof costaCli.runCLI, 'function');
    assert.strictEqual(typeof costaCli.createCostaFile, 'function');
    assert.strictEqual(costaCli.scrapeCostaCruceros, costaScraper.createCostaFile);
  });
});
