#!/usr/bin/env node
// Swickers Kill Data Auto-Upload
// Runs on GitHub Actions daily — no Mac required
// Playwright/Chromium handles NTLM authentication natively

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const SUPABASE_URL      = 'https://ewoxtyrpanxfriuoaulq.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SWICKERS_DASHBOARD = 'https://www.swickers.com.au/killdata/dashboard.aspx';
const DOWNLOAD_DIR      = path.join(os.tmpdir(), 'swickers-auto');

function log(msg) {
  const ts = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  console.log(`[${ts}] ${msg}`);
}

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i].trim() : ''; });
    return obj;
  });
}

function normaliseDate(raw) {
  if (!raw) return '';
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
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
  for (const k of ['4FTM','4FPC','4FBK','4GDH']) { if (s.startsWith(k)) return k; }
  return s;
}

(async () => {
  if (!SUPABASE_SERVICE_KEY) {
    log('ERROR: SUPABASE_SERVICE_KEY env var not set');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // 1. Get Swickers credentials from Supabase
  log('Fetching credentials...');
  const { data: configRows, error: cfgErr } = await supabase
    .from('swickers_config').select('key, value');
  if (cfgErr) { log('ERROR: ' + cfgErr.message); process.exit(1); }

  const cfg = {};
  (configRows || []).forEach(r => { cfg[r.key] = r.value; });
  if (!cfg.username || !cfg.password) {
    log('ERROR: missing username or password in swickers_config');
    process.exit(1);
  }
  log(`Credentials loaded for: ${cfg.username}`);

  // 2. Skip if already uploaded today
  const today = todayStr();
  const { data: existing } = await supabase
    .from('uploads').select('id').eq('date_from', today).limit(1);
  if (existing && existing.length > 0) {
    log(`Already uploaded for ${today} — skipping`);
    process.exit(0);
  }

  // 3. Launch browser with NTLM credentials
  // Chromium handles NTLM auth natively when httpCredentials is set
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    httpCredentials: {
      username: cfg.username,
      password: cfg.password,
    },
  });
  const page = await context.newPage();

  try {
    // 4. Go to dashboard — Chromium handles the NTLM challenge automatically
    log('Navigating to dashboard...');
    const response = await page.goto(SWICKERS_DASHBOARD, { waitUntil: 'networkidle', timeout: 30000 });
    log(`Page status: ${response?.status()}, URL: ${page.url()}`);

    const title = await page.title();
    log(`Page title: ${title}`);

    if (page.url().toLowerCase().includes('login') || page.url().toLowerCase().includes('logon')) {
      log('ERROR: Ended up on login page — credentials may be wrong');
      await browser.close();
      process.exit(1);
    }

    // 5. Find today's download button
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const d = new Date(today + 'T00:00:00');
    const dayFormatted = `${String(d.getDate()).padStart(2,'0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
    log(`Looking for: ${dayFormatted}`);

    const buttons = await page.$$('input[type=image]');
    log(`Found ${buttons.length} image buttons on page`);

    let downloadBtn = null;
    for (const btn of buttons) {
      const row     = await btn.evaluateHandle(el => el.closest('tr'));
      const rowText = await row.evaluate(el => el ? el.innerText : '');
      if (rowText.includes(dayFormatted)) {
        const name = await btn.getAttribute('name');
        log(`Button candidate: ${name}`);
        if (!downloadBtn || name < (await downloadBtn.getAttribute('name'))) {
          downloadBtn = btn;
        }
      }
    }

    if (!downloadBtn) {
      log(`No download button found for ${dayFormatted} — data not available yet`);
      await browser.close();
      process.exit(0);
    }

    // 6. Click and download
    log('Downloading file...');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadBtn.click(),
    ]);

    const filename = download.suggestedFilename();
    const savePath = path.join(DOWNLOAD_DIR, filename);
    await download.saveAs(savePath);
    log(`Downloaded: ${filename}`);
    await browser.close();

    // 7. Parse
    const text = fs.readFileSync(savePath, 'utf-8');
    const rows = parseCSV(text);
    log(`Parsed ${rows.length} records`);
    if (!rows.length) { log('No records in file'); process.exit(0); }

    // 8. Build upload
    const uploadId = `auto-${today}-${Date.now()}`;
    const records  = rows.map(r => {
      const hscw      = parseNum(r.hscw);
      const p2        = parseNum(r.p2fat || r.p2 || '0');
      const sex       = (r.sex || '').toLowerCase().startsWith('f') ? 'f' : 'm';
      const tattoo    = normaliseTattoo(r.tattoo || '');
      const organDesc = (r.organdesc || r.organ || '').trim();
      const condemned = organDesc.length > 0 && organDesc !== '0';
      return {
        id: `${uploadId}-${r.bodyno || Math.random().toString(36).slice(2)}`,
        uploadId, date: normaliseDate(r.killdate || r.date || ''),
        hscw, p2, sex, tattoo, condemned,
        condemnDesc: condemned ? organDesc : '',
        bodyno: r.bodyno || '',
      };
    });

    const hscwVals = records.filter(r => r.hscw > 0).map(r => r.hscw);
    const p2Vals   = records.filter(r => r.p2 > 0).map(r => r.p2);
    const avgHscw  = hscwVals.length ? hscwVals.reduce((a,b)=>a+b,0)/hscwVals.length : 0;
    const avgP2    = p2Vals.length   ? p2Vals.reduce((a,b)=>a+b,0)/p2Vals.length     : 0;
    const condemns = records.filter(r => r.condemned).length;

    const upload = {
      id: uploadId, business_code: 'WPC',
      user_email: 'auto@wilsonporkco.com.au',
      upload_date: new Date().toISOString(), data_type: 'kill',
      filename, date_from: today, date_to: today,
      total_records: records.length, avg_hscw: avgHscw, avg_p2: avgP2,
      total_condemns: condemns, records,
    };

    // 9. Insert
    log('Uploading to Supabase...');
    const { error: insertErr } = await supabase.from('uploads').insert(upload);
    if (insertErr) { log('ERROR: ' + insertErr.message); process.exit(1); }

    log(`✓ Done: ${records.length} records, avg HSCW ${avgHscw.toFixed(1)}, avg P2 ${avgP2.toFixed(1)}, ${condemns} condemns`);
    fs.unlinkSync(savePath);

  } catch (err) {
    log('ERROR: ' + err.message);
    await browser.close();
    process.exit(1);
  }
})();
