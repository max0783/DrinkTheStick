const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const ExcelJS = require("exceljs");

async function scrapeMSCCruceros(url) {
  let browser;
  let page;
  let allCruceros = [];

  try {
    browser = await puppeteer.launch({
      headless: "new",
      defaultViewport: null,
      args: ["--start-maximized"],
    });

    page = await browser.newPage();

    console.log("Navegando a la URL inicial...");
    await page.goto(url, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    let hasNextPage = true;
    let currentPage = 1;

    while (hasNextPage) {
      console.log(`Procesando página ${currentPage}...`);

      await new Promise((resolve) => setTimeout(resolve, 5000));

      const cruceros = await page.evaluate((pageNum) => {
        const cards = document.querySelectorAll(".itinerary-card");

        return Array.from(cards).map((card) => {
          const destInfo = card.querySelector(
            ".itinerary-card-detail__destination-and-search-duration"
          );
          const destino = destInfo
            ?.querySelector(".itinerary-card-detail__destination")
            ?.textContent?.trim();
          const duracion = destInfo
            ?.querySelector(".itinerary-card-detail__duration")
            ?.textContent?.trim();
          const barco = card
            .querySelector(".itinerary-card-detail__ship-name-link")
            ?.textContent?.trim();
          const puertoInfo = card.querySelector(".itinerary-card-detail__port");
          const puerto = puertoInfo
            ?.querySelector(".itinerary-card-detail__port-name")
            ?.textContent?.trim();
          const precioElement = card.querySelector(
            ".itinerary-card-price__price"
          );
          const precioTexto = precioElement?.textContent?.trim() || '';
          const precio = precioTexto.replace(/[^\d]/g, '');
          const moneda = "USD";
          const fechas = Array.from(
            card.querySelectorAll(".available-dates-slider__date")
          ).map((fecha) => fecha.textContent.trim());
          const promo = card
            .querySelector(".promo-ribbon--text")
            ?.textContent?.trim();
            
          // Nueva lógica para obtener la URL del itinerario
          let itinerarioUrl = '';
          const urlElement = card.querySelector(".itinerary-card-detail__see-itinerary");
          if (urlElement) {
            // Intenta obtener la URL de diferentes atributos
            itinerarioUrl = urlElement.getAttribute('href') || 
                           urlElement.getAttribute('data-href') ||
                           urlElement.dataset.href ||
                           '';
            
            // Si la URL es relativa, la convertimos en absoluta
            if (itinerarioUrl && !itinerarioUrl.startsWith('http')) {
              itinerarioUrl = 'https://www.msccruceros.com.ar' + (itinerarioUrl.startsWith('/') ? '' : '/') + itinerarioUrl;
            }
            
            // Si no hay URL en los atributos, intenta construirla usando el ID del crucero
            if (!itinerarioUrl) {
              const cruiseId = card.getAttribute('data-cruise-id') || 
                              card.getAttribute('id') || 
                              urlElement.getAttribute('data-cruise-id');
              if (cruiseId) {
                itinerarioUrl = `https://www.msccruceros.com.ar/cruceros/${cruiseId}`;
              }
            }
          }

          return {
            destino,
            duracion,
            barco,
            puerto_salida: puerto,
            precio: {
              moneda,
              valor: precio,
            },
            fechas_disponibles: fechas,
            promocion: promo || null,
            url_itinerario: itinerarioUrl || null,
            pagina: pageNum,
          };
        });
      }, currentPage);

      console.log(
        `- Encontrados ${cruceros.length} cruceros en la página ${currentPage}`
      );
      allCruceros = [...allCruceros, ...cruceros];

      try {
        const nextButtonExists = await page.evaluate(() => {
          const nextButton = document.querySelector(".right-arrow");
          return (
            nextButton &&
            !nextButton.disabled &&
            nextButton.style.display !== "none"
          );
        });

        if (nextButtonExists) {
          console.log("Navegando a la siguiente página...");
          await Promise.all([
            page.click(".right-arrow"),
            page.waitForNavigation({
              waitUntil: "networkidle0",
              timeout: 30000,
            }),
          ]);
          currentPage++;
        } else {
          console.log(
            "No se encontró botón de siguiente página o está deshabilitado"
          );
          hasNextPage = false;
        }
      } catch (navError) {
        console.log("Error en la navegación:", navError.message);
        hasNextPage = false;
      }
    }

    // Guardar resultados en JSON
    const results = {
      total_cruceros: allCruceros.length,
      paginas_procesadas: currentPage,
      fecha_scraping: new Date().toISOString(),
      cruceros: allCruceros,
    };

    await fs.writeFile(
      "cruceros_msc.json",
      JSON.stringify(results, null, 2),
      "utf-8"
    );

    // Crear y guardar Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Cruceros MSC");

    // Definir columnas
    worksheet.columns = [
      { header: "Destino", key: "destino", width: 30 },
      { header: "Duración", key: "duracion", width: 15 },
      { header: "Barco", key: "barco", width: 20 },
      { header: "Puerto de Salida", key: "puerto_salida", width: 20 },
      { header: "Moneda", key: "moneda", width: 10 },
      { header: "Precio", key: "precio", width: 15 },
      { header: "Fechas Disponibles", key: "fechas", width: 50 },
      { header: "Promoción", key: "promocion", width: 30 },
      { header: "URL Itinerario", key: "url_itinerario", width: 50 },
      { header: "Página", key: "pagina", width: 10 },
    ];

    // Dar formato al encabezado
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    // Agregar datos
    allCruceros.forEach((crucero) => {
      worksheet.addRow({
        destino: crucero.destino,
        duracion: crucero.duracion,
        barco: crucero.barco,
        puerto_salida: crucero.puerto_salida,
        moneda: crucero.precio.moneda,
        precio: crucero.precio.valor,
        fechas: crucero.fechas_disponibles.join(", "),
        promocion: crucero.promocion,
        url_itinerario: crucero.url_itinerario,
        pagina: crucero.pagina,
      });
    });

    // Autoajustar columnas
    worksheet.columns.forEach((column) => {
      column.alignment = { wrapText: true };
    });

    // Guardar Excel
    await workbook.xlsx.writeFile("cruceros_msc.xlsx");

    console.log("\nScraping completado:");
    console.log(`- Total de cruceros encontrados: ${allCruceros.length}`);
    console.log(`- Páginas procesadas: ${currentPage}`);
    console.log("Datos guardados en:");
    console.log("- cruceros_msc.json");
    console.log("- cruceros_msc.xlsx");
  } catch (error) {
    console.error("Error durante el scraping:", error);

    if (page) {
      await page.screenshot({
        path: "error-screenshot.png",
        fullPage: true,
      });
      console.log("Screenshot de error guardado como error-screenshot.png");
    }

    // Guardar datos parciales en caso de error
    if (allCruceros.length > 0) {
      const partialResults = {
        total_cruceros: allCruceros.length,
        error: error.message,
        cruceros: allCruceros,
      };

      await fs.writeFile(
        "cruceros_msc_partial.json",
        JSON.stringify(partialResults, null, 2),
        "utf-8"
      );

      // Intentar guardar Excel parcial
      try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Cruceros MSC (Parcial)");

        worksheet.columns = [
          { header: "Destino", key: "destino", width: 30 },
          { header: "Duración", key: "duracion", width: 15 },
          { header: "Barco", key: "barco", width: 20 },
          { header: "Puerto de Salida", key: "puerto_salida", width: 20 },
          { header: "Moneda", key: "moneda", width: 10 },
          { header: "Precio", key: "precio", width: 15 },
          { header: "Fechas Disponibles", key: "fechas", width: 50 },
          { header: "Promoción", key: "promocion", width: 30 },
          { header: "URL Itinerario", key: "url_itinerario", width: 50 },
          { header: "Página", key: "pagina", width: 10 },
        ];

        allCruceros.forEach((crucero) => {
          worksheet.addRow({
            destino: crucero.destino,
            duracion: crucero.duracion,
            barco: crucero.barco,
            puerto_salida: crucero.puerto_salida,
            moneda: crucero.precio.moneda,
            precio: crucero.precio.valor,
            fechas: crucero.fechas_disponibles.join(", "),
            promocion: crucero.promocion,
            url_itinerario: crucero.url_itinerario,
            pagina: crucero.pagina,
          });
        });

        await workbook.xlsx.writeFile("cruceros_msc_partial.xlsx");
        console.log("Datos parciales guardados en cruceros_msc_partial.xlsx");
      } catch (excelError) {
        console.error("Error al guardar Excel parcial:", excelError);
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Ejecutar el scraper
const url =
  "https://www.msccruceros.com.ar/ofertas-cruceros/cruceros-a-brasil?departureDateFrom=12%2F01%2F2024&departureDateTo=30%2F04%2F2026&passengers=2%7C0%7C0%7C0&area=SOA&embkPort=BUE%2CMVD&ships=PO%2CAX%2CSP%2CFA%2CPR&page=1";

const createFile = async () => {
  await scrapeMSCCruceros(url);
};

module.exports = createFile;

//