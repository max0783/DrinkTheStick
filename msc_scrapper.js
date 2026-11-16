#!/usr/bin/env node

/**
 * msc_scrapper.js
 * 
 * Standalone CLI Scraper for MSC Cruceros Argentina.
 * Wraps createFile() from msc_scrapper_excel.js with CLI argument handling,
 * rich console logging, summary statistics, and exit codes.
 */

const path = require("path");
const createFile = require("./msc_scrapper_excel");

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    headless: true,
    maxPages: Infinity,
    customUrl: undefined,
    outputPath: undefined,
    jsonPath: undefined
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--headful" || arg === "--no-headless") {
      options.headless = false;
    } else if (arg.startsWith("--headless=")) {
      options.headless = arg.slice(arg.indexOf("=") + 1) !== "false";
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
    }
  }

  return options;
}

function printHelp() {
  console.log(`
🚢 DrinkTheStick — MSC Cruceros CLI Scraper
==============================================================
Uso:
  node msc_scrapper.js [opciones]

Opciones:
  --headful, --no-headless     Abre el navegador visualmente (modo headful para depuración)
  --headless=true|false        Activa o desactiva el modo headless (por defecto: true)
  --max-pages=N, -p N          Limita el raspado a un máximo de N páginas
  --url=URL                    Especifica una URL de búsqueda personalizada
  --xlsx=PATH                  Ruta de salida del archivo Excel (.xlsx)
  --json=PATH                  Ruta de salida del archivo JSON (.json)
  -h, --help                   Muestra esta ayuda y termina
`);
}

async function runCLI() {
  const options = parseCliArgs();

  console.log("==============================================================");
  console.log("🚢 DrinkTheStick — MSC Cruceros Scraper CLI");
  console.log("==============================================================");
  console.log(`Modo de navegador:   ${options.headless ? "Headless (silencioso)" : "Visible (headful)"}`);
  console.log(`Límite de páginas:   ${options.maxPages === Infinity ? "Todas" : options.maxPages}`);
  if (options.customUrl) {
    console.log(`URL personalizada:   ${options.customUrl}`);
  }
  console.log("Iniciando extracción...\n");

  const startTime = Date.now();
  const result = await createFile(options);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n--------------------------------------------------------------");
  if (result.success) {
    console.log(`✅ Scraping completado en ${elapsed}s`);
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
    console.error(`❌ El scraper finalizó con advertencias o error en ${elapsed}s: ${result.error}`);
    if (result.totalCruceros > 0) {
      console.log(`⚠️ Se recuperaron y guardaron ${result.totalCruceros} cruceros parciales.`);
      console.log(`📄 Archivo Excel parcial: ${result.xlsxPath}`);
      console.log(`📋 Archivo JSON parcial:  ${result.jsonPath}`);
      process.exit(0);
    } else {
      process.exit(1);
    }
  }
}

// Module export & standalone runner
if (require.main === module) {
  runCLI().catch((err) => {
    console.error("Error fatal no capturado:", err);
    process.exit(1);
  });
}

module.exports = {
  runCLI,
  scrapeMSCCruceros: createFile,
  createFile
};
