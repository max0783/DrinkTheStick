#!/usr/bin/env node

/**
 * costa_scrapper.js
 *
 * Standalone CLI Scraper for Costa Cruceros Argentina / Sudamérica.
 * Wraps createCostaFile() from costa_scrapper_excel.js with CLI argument handling,
 * rich console logging, summary statistics, and exit codes.
 */

const path = require("path");
const { createCostaFile } = require("./costa_scrapper_excel");

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    maxPages: 5,
    customUrl: undefined,
    outputPath: undefined,
    jsonPath: undefined,
    port: undefined,
    area: undefined
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith("--max-pages=")) {
      options.maxPages = parseInt(arg.slice(arg.indexOf("=") + 1), 10);
    } else if ((arg === "--max-pages" || arg === "-p") && i + 1 < args.length) {
      options.maxPages = parseInt(args[++i], 10);
    } else if (arg.startsWith("--url=")) {
      options.customUrl = arg.slice(arg.indexOf("=") + 1);
    } else if (arg === "--url" && i + 1 < args.length) {
      options.customUrl = args[++i];
    } else if (arg.startsWith("--xlsx=")) {
      options.outputPath = path.resolve(arg.slice(arg.indexOf("=") + 1));
    } else if (arg === "--xlsx" && i + 1 < args.length) {
      options.outputPath = path.resolve(args[++i]);
    } else if (arg.startsWith("--json=")) {
      options.jsonPath = path.resolve(arg.slice(arg.indexOf("=") + 1));
    } else if (arg === "--json" && i + 1 < args.length) {
      options.jsonPath = path.resolve(args[++i]);
    } else if (arg.startsWith("--port=")) {
      options.port = arg.slice(arg.indexOf("=") + 1);
    } else if (arg.startsWith("--area=")) {
      options.area = arg.slice(arg.indexOf("=") + 1);
    }
  }

  if (options.port || options.area) {
    options.filters = {
      ...(options.port ? { embkPort: options.port } : {}),
      ...(options.area ? { area: options.area } : {})
    };
  }

  return options;
}

function printHelp() {
  console.log(`
🚢 DrinkTheStick — Costa Cruceros CLI Scraper
==============================================================
Uso:
  node costa_scrapper.js [opciones]

Opciones:
  --max-pages=N, -p N          Limita la búsqueda a N páginas/lotes (por defecto: 5)
  --port=PORT                  Código de puerto de salida (ej: BUE, MVD, ALL)
  --area=AREA                  Código de destino (ej: SA, CA, CW, CE)
  --url=URL                    Especifica una URL de búsqueda personalizada
  --xlsx=PATH                  Ruta de salida del archivo Excel (.xlsx)
  --json=PATH                  Ruta de salida del archivo JSON (.json)
  -h, --help                   Muestra esta ayuda y termina
`);
}

async function runCLI() {
  const options = parseCliArgs();

  console.log("==============================================================");
  console.log("🚢 DrinkTheStick — Costa Cruceros Scraper CLI");
  console.log("==============================================================");
  console.log(`Límite de páginas:   ${options.maxPages}`);
  if (options.filters?.embkPort) {
    console.log(`Puerto de salida:    ${options.filters.embkPort}`);
  }
  if (options.filters?.area) {
    console.log(`Destino:             ${options.filters.area}`);
  }
  if (options.customUrl) {
    console.log(`URL personalizada:   ${options.customUrl}`);
  }
  console.log("Iniciando extracción...\n");

  const startTime = Date.now();
  const result = await createCostaFile(options);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n--------------------------------------------------------------");
  if (result.success) {
    console.log(`✅ Consulta completada en ${elapsed}s`);
    console.log(`📊 Total de cruceros extraídos: ${result.totalCruceros}`);
    console.log(`📄 Archivo Excel: ${result.xlsxPath}`);
    console.log(`📋 Archivo JSON:  ${result.jsonPath}`);

    if (result.cruceros && result.cruceros.length > 0) {
      const prices = result.cruceros
        .map((c) => c.precio && c.precio.valor)
        .filter((p) => typeof p === "number" && p > 0);
      if (prices.length > 0) {
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        console.log(`💰 Rango de precios: USD $${minPrice} — USD $${maxPrice}`);
      }
    }
    process.exit(0);
  } else {
    console.error(`❌ El scraper finalizó con error en ${elapsed}s: ${result.error}`);
    process.exit(1);
  }
}

if (require.main === module) {
  runCLI().catch((err) => {
    console.error("Error fatal no capturado:", err);
    process.exit(1);
  });
}

module.exports = {
  runCLI,
  scrapeCostaCruceros: createCostaFile,
  createCostaFile
};
