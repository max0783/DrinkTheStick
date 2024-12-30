const puppeteer = require('puppeteer');
const fs = require('fs').promises;

async function scrapeMSCCruceros(url) {
    let browser;
    let page;
    let allCruceros = [];

    try {
        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized']
        });

        page = await browser.newPage();
        
        console.log('Navegando a la URL inicial...');
        await page.goto(url, {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        let hasNextPage = true;
        let currentPage = 1;

        while (hasNextPage) {
            console.log(`Procesando página ${currentPage}...`);
            
            // Esperar a que los elementos de crucero se carguen
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Extraer información de los cruceros - Pasando currentPage como parámetro
            const cruceros = await page.evaluate((pageNum) => {
                const cards = document.querySelectorAll('.itinerary-card');
                
                return Array.from(cards).map(card => {
                    // Extraer destino y duración
                    const destInfo = card.querySelector('.itinerary-card-detail__destination-and-search-duration');
                    const destino = destInfo?.querySelector('.itinerary-card-detail__destination')?.textContent?.trim();
                    const duracion = destInfo?.querySelector('.itinerary-card-detail__duration')?.textContent?.trim();

                    // Extraer información del barco
                    const barco = card.querySelector('.itinerary-card-detail__ship-name-link')?.textContent?.trim();

                    // Extraer puerto
                    const puertoInfo = card.querySelector('.itinerary-card-detail__port');
                    const puerto = puertoInfo?.querySelector('.itinerary-card-detail__port-name')?.textContent?.trim();

                    // Extraer precio
                    const precioElement = card.querySelector('.itinerary-card-price__price');
                    const precio = precioElement?.textContent?.trim();
                    const moneda = precioElement?.previousElementSibling?.textContent?.trim();

                    // Extraer fechas disponibles
                    const fechas = Array.from(card.querySelectorAll('.available-dates-slider__date'))
                        .map(fecha => fecha.textContent.trim());

                    // Extraer promociones
                    const promo = card.querySelector('.promo-ribbon--text')?.textContent?.trim();

                    // Extraer URL del itinerario
                    const itinerarioUrl = card.querySelector('.itinerary-card-detail__see-itinerary')?.href;

                    return {
                        destino,
                        duracion,
                        barco,
                        puerto_salida: puerto,
                        precio: {
                            moneda,
                            valor: precio
                        },
                        fechas_disponibles: fechas,
                        promocion: promo || null,
                        url_itinerario: itinerarioUrl,
                        pagina: pageNum
                    };
                });
            }, currentPage);

            console.log(`- Encontrados ${cruceros.length} cruceros en la página ${currentPage}`);
            allCruceros = [...allCruceros, ...cruceros];

            // Verificar si hay siguiente página y navegación
            try {
                const nextButtonExists = await page.evaluate(() => {
                    const nextButton = document.querySelector('.right-arrow');
                    return nextButton && !nextButton.disabled && nextButton.style.display !== 'none';
                });

                if (nextButtonExists) {
                    console.log('Navegando a la siguiente página...');
                    await Promise.all([
                        page.click('.right-arrow'),
                        page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 })
                    ]);
                    currentPage++;
                } else {
                    console.log('No se encontró botón de siguiente página o está deshabilitado');
                    hasNextPage = false;
                }
            } catch (navError) {
                console.log('Error en la navegación:', navError.message);
                hasNextPage = false;
            }
        }

        // Guardar resultados
        const results = {
            total_cruceros: allCruceros.length,
            paginas_procesadas: currentPage,
            fecha_scraping: new Date().toISOString(),
            cruceros: allCruceros
        };

        await fs.writeFile(
            'cruceros_msc.json',
            JSON.stringify(results, null, 2),
            'utf-8'
        );

        console.log('\nScraping completado:');
        console.log(`- Total de cruceros encontrados: ${allCruceros.length}`);
        console.log(`- Páginas procesadas: ${currentPage}`);
        console.log('Datos guardados en cruceros_msc.json');

    } catch (error) {
        console.error('Error durante el scraping:', error);
        
        if (page) {
            await page.screenshot({
                path: 'error-screenshot.png',
                fullPage: true
            });
            console.log('Screenshot de error guardado como error-screenshot.png');
        }

        // Guardar datos parciales en caso de error
        if (allCruceros.length > 0) {
            const partialResults = {
                total_cruceros: allCruceros.length,
                error: error.message,
                cruceros: allCruceros
            };
            
            await fs.writeFile(
                'cruceros_msc_partial.json',
                JSON.stringify(partialResults, null, 2),
                'utf-8'
            );
            console.log('Datos parciales guardados en cruceros_msc_partial.json');
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Ejecutar el scraper
const url = 'https://www.msccruceros.com.ar/ofertas-cruceros/cruceros-a-brasil?departureDateFrom=12%2F01%2F2024&departureDateTo=30%2F04%2F2026&passengers=2%7C0%7C0%7C0&area=SOA&embkPort=BUE%2CMVD&ships=PO%2CAX%2CSP%2CFA%2CPR&page=1';

scrapeMSCCruceros(url);