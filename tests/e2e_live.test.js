/**
 * Opt-in Live End-to-End Test (run with: LIVE_TEST=true npm test)
 *
 * Safety guard (testing only): requires TELEGRAM_CHAT_ID ending in '440'
 * so live test runs never send test messages to arbitrary users.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dotenv = require('dotenv');
const TelegramBot = require('node-telegram-bot-api');

dotenv.config();

const createFile = require('../msc_scrapper_excel');
const app = require('../app');

describe('Live E2E Workflow (Opt-In: LIVE_TEST=true)', { concurrency: 1 }, () => {
  const isLive = process.env.LIVE_TEST === 'true';

  it('LIVE-01: Scrapes live MSC Cruceros data and writes valid Excel report', async (t) => {
    if (!isLive) {
      t.skip('Set LIVE_TEST=true to run live end-to-end tests.');
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dts-live-'));
    try {
      const outXlsx = path.join(tmpDir, 'cruceros_msc_live.xlsx');
      const outJson = path.join(tmpDir, 'cruceros_msc_live.json');

      const result = await createFile({
        outputPath: outXlsx,
        jsonPath: outJson,
        headless: true,
        maxPages: 1
      });

      assert.strictEqual(result.success, true, result.error);
      assert.ok(result.totalCruceros > 0, 'Must extract at least 1 cruise');
      assert.ok(fs.existsSync(outXlsx) && fs.statSync(outXlsx).size > 2000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('LIVE-02: Delivers report via Telegram ONLY to test chat ID ending in 440', async (t) => {
    if (!isLive) {
      t.skip('Set LIVE_TEST=true to run live end-to-end tests.');
      return;
    }

    const token = (process.env.TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();

    assert.ok(token, 'TOKEN is required in .env for live Telegram test');
    assert.ok(chatId.endsWith('440'), `Live test safety guard: TELEGRAM_CHAT_ID ('${chatId}') must end in 440`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dts-live-tg-'));
    try {
      const outXlsx = path.join(tmpDir, 'cruceros_msc_live.xlsx');
      const outJson = path.join(tmpDir, 'cruceros_msc_live.json');
      const offersFile = path.join(tmpDir, 'sent_offers.json');

      const bot = new TelegramBot(token, { polling: false });
      const res = await app.runReportCycle({
        bot,
        targetChatIds: [chatId],
        sentOffersFilePath: offersFile,
        sendDocument: true,
        scraperOptions: {
          outputPath: outXlsx,
          jsonPath: outJson,
          headless: true,
          maxPages: 1
        }
      });

      assert.strictEqual(res.success, true, res.error);
      assert.strictEqual(res.documentsSent, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
