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

  // Pass credentials as HTTP Basic Auth — Swickers dashboard uses 401/Basic Auth, not a form login
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    httpCredentials: { username: config.username, password: config.password },
  });
  const page = await context.newPage();

  try {
    // Navigate directly to dashboard with credentials in context
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
      page.waitForEvent('download', { timeout: 300000 }),
      downloadBtn.click({ timeout: 120000 }),
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
      data_type:      'daily',
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

    // 7. Send email notification
    try {
      const condemnRate = records.length ? (condemns / records.length * 100).toFixed(1) : '0.0';
      const fmtD = d => { const m = d && d.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : d || ''; };
      const dateLabel = fmtD(today);
      const subjectDate = new Date(today + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const uploadedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

      // Build per-tattoo breakdown with HSCW and P2 brackets
      const tattooMap = {};
      records.forEach(r => {
        const t = (r.tattoo || 'UNKNOWN').toUpperCase();
        if (!tattooMap[t]) tattooMap[t] = {
          total: 0, f: 0, m: 0, hscw: [], p2: [],
          hscwB: [{lbl:'< 80 kg',f:0,m:0},{lbl:'80 – 95 kg',f:0,m:0},{lbl:'95 – 100 kg',f:0,m:0},{lbl:'100 – 115 kg',f:0,m:0},{lbl:'115 kg +',f:0,m:0}],
          p2B:   [{lbl:'0 – 12 mm',f:0,m:0},{lbl:'13 – 15 mm',f:0,m:0},{lbl:'16 mm +',f:0,m:0}],
        };
        tattooMap[t].total++;
        const isFem = r.sex === 'f';
        const hv = parseFloat(r.hscw) || 0;
        const pv = parseFloat(r.p2)   || 0;
        if (isFem) tattooMap[t].f++; else tattooMap[t].m++;
        if (hv > 0) {
          tattooMap[t].hscw.push(hv);
          const hb = tattooMap[t].hscwB;
          const hBkt = hv < 80 ? 0 : hv < 95 ? 1 : hv < 100 ? 2 : hv < 115 ? 3 : 4;
          if (isFem) hb[hBkt].f++; else hb[hBkt].m++;
        }
        if (pv > 0) {
          tattooMap[t].p2.push(pv);
          const pb = tattooMap[t].p2B;
          const pBkt = pv <= 12 ? 0 : pv <= 15 ? 1 : 2;
          if (isFem) pb[pBkt].f++; else pb[pBkt].m++;
        }
      });

      const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : '—';
      const tattooOrder = ['4FTM', '4FPC', '4FBK', '4GDH'];
      const sortedTats = Object.keys(tattooMap).sort((a, b) => {
        const ai = tattooOrder.indexOf(a) >= 0 ? tattooOrder.indexOf(a) : 999;
        const bi = tattooOrder.indexOf(b) >= 0 ? tattooOrder.indexOf(b) : 999;
        return ai !== bi ? ai - bi : a.localeCompare(b);
      });

      const fmHdr = (title) => `<tr>
        <td style="padding:5px 8px;font-size:9px;font-weight:700;color:#aaa;letter-spacing:0.5px;border-bottom:1px solid #e0ddd6;">${title}</td>
        <td style="padding:5px 6px;font-size:9px;font-weight:700;color:#F01A8C;text-align:center;border-bottom:1px solid #e0ddd6;">F</td>
        <td style="padding:5px 6px;font-size:9px;font-weight:700;color:#2979FF;text-align:center;border-bottom:1px solid #e0ddd6;">M</td>
        <td style="padding:5px 6px;font-size:9px;font-weight:700;color:#555;text-align:center;border-bottom:1px solid #e0ddd6;">TOT</td>
        <td style="padding:5px 6px;font-size:9px;font-weight:700;color:#aaa;text-align:center;border-bottom:1px solid #e0ddd6;">%</td>
      </tr>`;
      const bRow = (lbl, f, m, tot) => `<tr>
        <td style="padding:4px 8px;font-size:11px;color:#555;border-bottom:1px solid #f5f2ec;">${lbl}</td>
        <td style="padding:4px 6px;font-size:11px;font-weight:700;color:#F01A8C;text-align:center;border-bottom:1px solid #f5f2ec;">${f}</td>
        <td style="padding:4px 6px;font-size:11px;font-weight:700;color:#2979FF;text-align:center;border-bottom:1px solid #f5f2ec;">${m}</td>
        <td style="padding:4px 6px;font-size:11px;font-weight:700;color:#1a1a1a;text-align:center;border-bottom:1px solid #f5f2ec;">${f + m}</td>
        <td style="padding:4px 6px;font-size:10px;color:#aaa;text-align:center;border-bottom:1px solid #f5f2ec;">${tot > 0 ? Math.round((f + m) / tot * 100) : 0}</td>
      </tr>`;
      const twoColTable = (leftTitle, leftRows, rightTitle, rightRows) => `
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td width="50%" valign="top" style="padding:10px 12px;border-right:1px solid #ece9e2;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${fmHdr(leftTitle)}${leftRows}</table>
            </td>
            <td width="50%" valign="top" style="padding:10px 12px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${fmHdr(rightTitle)}${rightRows}</table>
            </td>
          </tr>
        </table>`;

      // ALL PIGS combined brackets
      const allHscwB = [{lbl:'< 80 kg',f:0,m:0},{lbl:'80 – 95 kg',f:0,m:0},{lbl:'95 – 100 kg',f:0,m:0},{lbl:'100 – 115 kg',f:0,m:0},{lbl:'115 kg +',f:0,m:0}];
      const allP2B   = [{lbl:'0 – 12 mm',f:0,m:0},{lbl:'13 – 15 mm',f:0,m:0},{lbl:'16 mm +',f:0,m:0}];
      sortedTats.forEach(t => {
        const d = tattooMap[t];
        d.hscwB.forEach((b, i) => { allHscwB[i].f += b.f; allHscwB[i].m += b.m; });
        d.p2B.forEach((b, i) => { allP2B[i].f += b.f; allP2B[i].m += b.m; });
      });
      const total = records.length;
      const femCount = records.filter(r => r.sex === 'f').length;

      const allPigsCard = `
        <div style="border:1px solid #1D9E75;border-radius:8px;overflow:hidden;margin-bottom:16px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f0faf6;border-bottom:1px solid #b2dfdb;">
            <tr>
              <td style="padding:9px 12px;">
                <span style="font-size:13px;font-weight:700;color:#1D9E75;">ALL PIGS</span>
                <span style="font-size:11px;color:#555;margin-left:8px;">${total} PIGS &nbsp;·</span>
                <span style="font-size:11px;font-weight:700;color:#F01A8C;margin-left:6px;">F ${femCount}</span>
                <span style="font-size:11px;font-weight:700;color:#2979FF;margin-left:6px;">M ${total - femCount}</span>
              </td>
              <td style="padding:9px 12px;font-size:10px;color:#aaa;text-align:right;">Avg HSCW ${avgHscw.toFixed(1)} kg &nbsp;·&nbsp; Avg P2 ${avgP2.toFixed(1)} mm</td>
            </tr>
          </table>
          ${twoColTable('WEIGHT (HSCW)', allHscwB.map(b => bRow(b.lbl, b.f, b.m, total)).join(''), 'FAT DEPTH (P2)', allP2B.map(b => bRow(b.lbl, b.f, b.m, total)).join(''))}
        </div>`;

      const tattooCardsHtml = sortedTats.map(t => {
        const d = tattooMap[t];
        return `<div style="border:1px solid #ece9e2;border-radius:8px;overflow:hidden;margin-bottom:12px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fdf0f5;border-bottom:1px solid #ece9e2;">
            <tr>
              <td style="padding:9px 12px;">
                <span style="font-size:13px;font-weight:700;color:#F01A8C;">${t}</span>
                <span style="font-size:11px;color:#555;margin-left:8px;">${d.total} PIGS &nbsp;·</span>
                <span style="font-size:11px;font-weight:700;color:#F01A8C;margin-left:6px;">F ${d.f}</span>
                <span style="font-size:11px;font-weight:700;color:#2979FF;margin-left:6px;">M ${d.m}</span>
              </td>
              <td style="padding:9px 12px;font-size:10px;color:#aaa;text-align:right;">Avg HSCW ${avg(d.hscw)} kg &nbsp;·&nbsp; Avg P2 ${avg(d.p2)} mm</td>
            </tr>
          </table>
          ${twoColTable('WEIGHT (HSCW)', d.hscwB.map(b => bRow(b.lbl, b.f, b.m, d.total)).join(''), 'FAT DEPTH (P2)', d.p2B.map(b => bRow(b.lbl, b.f, b.m, d.total)).join(''))}
        </div>`;
      }).join('');

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#F78DC5;padding:24px 28px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:rgba(255,255,255,0.8);margin-bottom:4px;">WILSON PORK CO</div>
    <div style="font-size:22px;font-weight:700;color:#fff;">Kill Data Report</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:4px;">${dateLabel}</div>
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-bottom:1px solid #f0ede6;">
    <tr>
      <td width="25%" valign="top" style="padding:16px;text-align:center;border-right:1px solid #f0ede6;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.8px;color:#aaa;margin-bottom:8px;">TOTAL HEAD</div>
        <div style="font-size:28px;font-weight:700;color:#1a1a1a;line-height:1;">${total}</div>
        <div style="font-size:11px;color:transparent;">–</div>
      </td>
      <td width="25%" valign="top" style="padding:16px;text-align:center;border-right:1px solid #f0ede6;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.8px;color:#aaa;margin-bottom:8px;">AVG HSCW</div>
        <div style="font-size:28px;font-weight:700;color:#1a1a1a;line-height:1;">${avgHscw.toFixed(1)}</div>
        <div style="font-size:11px;color:#aaa;margin-top:4px;">kg</div>
      </td>
      <td width="25%" valign="top" style="padding:16px;text-align:center;border-right:1px solid #f0ede6;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.8px;color:#aaa;margin-bottom:8px;">AVG P2</div>
        <div style="font-size:28px;font-weight:700;color:#1a1a1a;line-height:1;">${avgP2.toFixed(1)}</div>
        <div style="font-size:11px;color:#aaa;margin-top:4px;">mm</div>
      </td>
      <td width="25%" valign="top" style="padding:16px;text-align:center;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.8px;color:#aaa;margin-bottom:8px;">CONDEMN RATE</div>
        <div style="font-size:28px;font-weight:700;color:${Number(condemnRate) > 2 ? '#c62828' : '#1a1a1a'};line-height:1;">${condemnRate}%</div>
        <div style="font-size:11px;color:#aaa;margin-top:4px;">${condemns} head</div>
      </td>
    </tr>
  </table>
  ${sortedTats.length ? `<div style="padding:20px 24px 8px;">
    ${allPigsCard}
    <div style="font-size:10px;font-weight:700;letter-spacing:0.8px;color:#aaa;margin-bottom:12px;">BREAKDOWN BY TATTOO</div>
    ${tattooCardsHtml}
  </div>` : ''}
  <div style="padding:16px 24px;border-top:1px solid #f0ede6;margin-top:12px;">
    <div style="font-size:10px;color:#bbb;">Auto-uploaded · ${uploadedAt}</div>
  </div>
</div></body></html>`;

      await fetch('https://api.smtp2go.com/v3/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: 'api-4B549E0D303940548B3D5A7823EA5E6E',
          to: ['nathan@wilsonporkco.com.au', 'unitone@wilsonporkco.com.au', 'unittwo@wilsonporkco.com.au', 'zack@wilpakmeats.com.au'],
          sender: 'Wilson Pork Co <admin@wilsonporkco.com.au>',
          subject: `Kill Data Summary — ${subjectDate}`,
          html_body: html,
        }),
      });
      log('✓ Email notification sent');
    } catch(e) {
      log('WARN: Email notification failed: ' + e.message);
    }

    // 8. Clean up downloaded file
    fs.unlinkSync(savePath);

  } catch (err) {
    log('ERROR: ' + err.message);
    await browser.close();
    process.exit(1);
  }
})();
