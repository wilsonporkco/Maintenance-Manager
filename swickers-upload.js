#!/usr/bin/env node
// ============================================================
// Swickers Kill Data Auto-Upload
// Logs into swickers.com.au, downloads today's kill data,
// parses it, and uploads to Supabase.
// ============================================================

// Load .env if present (local dev only — GitHub Actions uses repo secrets)
try { require('dotenv').config({ path: __dirname + '/.env' }); } catch(e) {}
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Config ──────────────────────────────────────────────────
const SUPABASE_URL = 'https://ewoxtyrpanxfriuoaulq.supabase.co';
// Service role key — stored only in this local file, never in Supabase
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SWICKERS_URL = 'https://www.swickers.com.au/killdata/dashboard.aspx';
const LOGIN_URL    = 'https://www.swickers.com.au/default.aspx';
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'swickers-auto');

// ── Helpers ──────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  console.log(`[${ts}] ${msg}`);
}

function todayStr() {
  // Returns today as YYYY-MM-DD in Brisbane time
  const now = new Date();
  const bne = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Brisbane' }));
  const y = bne.getFullYear();
  const m = String(bne.getMonth() + 1).padStart(2, '0');
  const d = String(bne.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    // Handle quoted fields
    const vals = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; }
      else if (line[i] === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else { cur += line[i]; }
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i].trim() : ''; });
    return obj;
  });
}

function normaliseDate(raw) {
  if (!raw) return '';
  // DD/MM/YYYY → YYYY-MM-DD
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return raw;
}

function parseNum(v) {
  const n = parseFloat(String(v || '').replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function normaliseTattoo(raw) {
  if (!raw) return 'UNKNOWN';
  const s = raw.trim().toUpperCase();
  // Strip trailing digits if needed (e.g. 4FPC2 → 4FPC)
  const KNOWN = ['4FTM', '4FPC', '4FBK', '4GDH'];
  for (const k of KNOWN) { if (s.startsWith(k)) return k; }
  return s;
}

function processRecords(rows, uploadId) {
  return rows.map(r => {
    const date   = normaliseDate(r.killdate || r.date || r.kill_date || '');
    const hscw   = parseNum(r.hscw || r['hot standard carcass weight'] || r.carcass_weight || 0);
    const p2     = parseNum(r.p2fat || r.p2 || r.p2_depth || 0);
    const sex    = (r.sex || '').toLowerCase().startsWith('f') ? 'f' : 'm';
    const tattoo = normaliseTattoo(r.tattoo || r.tattoo_no || '');
    const organDesc = (r.organdesc || r.organ_desc || r.organ || '').trim();
    const condemned = organDesc.length > 0 && organDesc !== '0';
    return {
      id:          `${uploadId}-${r.bodyno || Math.random().toString(36).slice(2)}`,
      uploadId,
      date,
      hscw,
      p2,
      sex,
      tattoo,
      condemned,
      condemnDesc: condemned ? organDesc : '',
      bodyno:      r.bodyno || '',
    };
  });
}

// ── Main ─────────────────────────────────────────────────────
(async () => {
  if (!SUPABASE_SERVICE_KEY) {
    log('ERROR: SUPABASE_SERVICE_KEY env var not set. Add it to .env file.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // 1. Fetch Swickers credentials from Supabase
  log('Fetching credentials from Supabase...');
  const { data: configRows, error: configErr } = await supabase
    .from('swickers_config')
    .select('key, value');

  if (configErr || !configRows) {
    log('ERROR: Could not fetch credentials: ' + (configErr?.message || 'unknown'));
    process.exit(1);
  }

  const config = {};
  configRows.forEach(r => { config[r.key] = r.value; });

  if (!config.username || !config.password) {
    log('ERROR: swickers_config missing username or password rows.');
    process.exit(1);
  }

  // 2. Check if today's data already uploaded
  const today = todayStr();
  const { data: existing } = await supabase
    .from('uploads')
    .select('id')
    .eq('date_from', today)
    .limit(1);

  if (existing && existing.length > 0) {
    log(`Today's data (${today}) already uploaded. Skipping.`);
    process.exit(0);
  }

  // 3. Launch browser and download file
  log('Launching browser...');
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page    = await context.newPage();

  try {
    // Always log in first — going straight to dashboard returns 401
    log('Navigating to login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    log('Login page — Title: ' + await page.title());

    // Debug: log all inputs on the page
    const allInputs = await page.$$eval('input', inputs => inputs.map(i => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder })));
    log('Inputs on page: ' + JSON.stringify(allInputs));

    const userField = await page.$('input[type=text], input[type=email], input[name*=ser], input[id*=ser], input[name*=ogin], input[id*=ogin]');
    const passField = await page.$('input[type=password]');

    if (!userField || !passField) {
      log('ERROR: Could not find login fields on page');
      await browser.close();
      process.exit(1);
    }

    log('Filling login form...');
    await userField.fill(config.username);
    await passField.fill(config.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
      passField.press('Enter'),
    ]);
    await page.waitForTimeout(2000);
    log('After login — URL: ' + page.url());

    // Navigate to dashboard
    log('Navigating to dashboard...');
    await page.goto(SWICKERS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    log('Dashboard — URL: ' + page.url());
    log('Dashboard — Title: ' + await page.title());

    // Wait a bit more for the table to render
    await page.waitForTimeout(3000);

    // Find today's row — format on page is like "16-Jun-2026"
    // Use hard-coded month names to avoid locale differences between macOS and Linux
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const _d = new Date(today + 'T00:00:00');
    const todayFormatted = String(_d.getDate()).padStart(2,'0') + '-' + MONTHS[_d.getMonth()] + '-' + _d.getFullYear();

    log(`Looking for row: ${todayFormatted}`);

    // Log all image buttons and row text for debugging
    const buttons = await page.$$('input[type=image]');
    log(`Found ${buttons.length} image buttons on page`);

    // Also log all table row text to see what's visible
    const allRows = await page.$$eval('tr', rows => rows.map(r => r.innerText.trim().replace(/\s+/g,' ')).filter(t => t.length > 0));
    log('Table rows: ' + JSON.stringify(allRows.slice(0, 10)));

    let downloadBtn = null;

    for (const btn of buttons) {
      const row = await btn.evaluateHandle(el => el.closest('tr'));
      const rowText = await row.evaluate(el => el ? el.innerText : '');
      if (rowText.includes(todayFormatted)) {
        const name = await btn.getAttribute('name');
        // First button for this date = Details (lower ImageButton number)
        if (!downloadBtn || name < (await downloadBtn.getAttribute('name'))) {
          downloadBtn = btn;
        }
      }
    }

    if (!downloadBtn) {
      log(`No download button found for today (${todayFormatted}). Data may not be available yet.`);
      await browser.close();
      process.exit(0);
    }

    log('Found download button — downloading file...');
    const [ download ] = await Promise.all([
      page.waitForEvent('download'),
      downloadBtn.click(),
    ]);

    const filename   = download.suggestedFilename();
    const savePath   = path.join(DOWNLOAD_DIR, filename);
    await download.saveAs(savePath);
    log(`Downloaded: ${filename}`);

    await browser.close();

    // 4. Parse the file
    log('Parsing file...');
    const text = fs.readFileSync(savePath, 'utf-8');
    const rows = parseCSV(text);
    log(`Parsed ${rows.length} records`);

    if (!rows.length) {
      log('No records found in file. Exiting.');
      process.exit(0);
    }

    // 5. Build upload record
    const uploadId = `auto-${today}-${Date.now()}`;
    const records  = processRecords(rows, uploadId);

    const hscwVals    = records.filter(r => r.hscw > 0).map(r => r.hscw);
    const p2Vals      = records.filter(r => r.p2 > 0).map(r => r.p2);
    const avgHscw     = hscwVals.length ? hscwVals.reduce((a, b) => a + b, 0) / hscwVals.length : 0;
    const avgP2       = p2Vals.length   ? p2Vals.reduce((a, b) => a + b, 0)   / p2Vals.length   : 0;
    const condemns    = records.filter(r => r.condemned).length;
    const condemnRate = records.length ? condemns / records.length * 100 : 0;

    const upload = {
      id:             uploadId,
      business_code:  'WPC',
      user_email:     'auto@wilsonporkco.com.au',
      upload_date:    new Date().toISOString(),
      data_type:      'kill',
      filename:       filename,
      date_from:      today,
      date_to:        today,
      total_records:  records.length,
      avg_hscw:       avgHscw,
      avg_p2:         avgP2,
      total_condemns: condemns,
      records:        records,
    };

    // 6. Insert into Supabase
    log('Uploading to Supabase...');
    const { error: insertErr } = await supabase.from('uploads').insert(upload);

    if (insertErr) {
      log('ERROR inserting to Supabase: ' + insertErr.message);
      process.exit(1);
    }

    log(`✓ Upload complete: ${records.length} records for ${today} (avg HSCW ${avgHscw.toFixed(1)}, avg P2 ${avgP2.toFixed(1)}, ${condemns} condemns)`);

    // 7. Clean up downloaded file
    fs.unlinkSync(savePath);

  } catch (err) {
    log('ERROR: ' + err.message);
    await browser.close();
    process.exit(1);
  }
})();
