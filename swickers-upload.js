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

async function sendKillEmail(records, upload) {
  try {
    const tattooMap = {};
    records.forEach(r => {
      const t = (r.tattoo || 'UNKNOWN').toUpperCase();
      if (!tattooMap[t]) tattooMap[t] = {
        total: 0, f: 0, m: 0, hscw: [], p2: [],
        hscwB: [{lbl:'&lt; 80 kg',f:0,m:0},{lbl:'80 – 95 kg',f:0,m:0},{lbl:'95 – 100 kg',f:0,m:0},{lbl:'100 – 115 kg',f:0,m:0},{lbl:'115 kg +',f:0,m:0}],
        p2B:   [{lbl:'0 – 12 mm',f:0,m:0},{lbl:'13 – 15 mm',f:0,m:0},{lbl:'16 mm +',f:0,m:0}]
      };
      tattooMap[t].total++;
      const isFem = (r.sex || '').toLowerCase() === 'f';
      const hv = parseFloat(r.hscw) || 0;
      const pv = parseFloat(r.p2) || 0;
      if (isFem) tattooMap[t].f++; else tattooMap[t].m++;
      if (hv > 0) {
        tattooMap[t].hscw.push(hv);
        const hBkt = hv < 80 ? 0 : hv < 95 ? 1 : hv < 100 ? 2 : hv < 115 ? 3 : 4;
        if (isFem) tattooMap[t].hscwB[hBkt].f++; else tattooMap[t].hscwB[hBkt].m++;
      }
      if (pv > 0) {
        tattooMap[t].p2.push(pv);
        const pBkt = pv <= 12 ? 0 : pv <= 15 ? 1 : 2;
        if (isFem) tattooMap[t].p2B[pBkt].f++; else tattooMap[t].p2B[pBkt].m++;
      }
    });

    const avg = arr => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1) : '—';
    const fmtD = d => { const m = d && d.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : d || ''; };
    const dateLabel = upload.date_from === upload.date_to
      ? fmtD(upload.date_from)
      : `${fmtD(upload.date_from)} – ${fmtD(upload.date_to)}`;
    const total      = upload.total_records || 0;
    const avgHscw    = upload.avg_hscw  ? Number(upload.avg_hscw).toFixed(1)  : '—';
    const avgP2      = upload.avg_p2    ? Number(upload.avg_p2).toFixed(1)    : '—';
    const condemns   = upload.total_condemns || 0;
    const condemnRate = total > 0 ? (condemns / total * 100).toFixed(1) : '0.0';
    const uploadedAt = new Date(upload.upload_date).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney', day: 'numeric', month: 'short',
      year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    });

    const tattooOrder = ['4FTM','4FPC','4FBK','4GDH'];
    const sortedTats = Object.keys(tattooMap).sort((a,b) => {
      const ai = tattooOrder.indexOf(a) >= 0 ? tattooOrder.indexOf(a) : 999;
      const bi = tattooOrder.indexOf(b) >= 0 ? tattooOrder.indexOf(b) : 999;
      return ai !== bi ? ai - bi : a.localeCompare(b);
    });

    const fmHdr = title => `<tr>
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
      <td style="padding:4px 6px;font-size:11px;font-weight:700;color:#1a1a1a;text-align:center;border-bottom:1px solid #f5f2ec;">${f+m}</td>
      <td style="padding:4px 6px;font-size:10px;color:#aaa;text-align:center;border-bottom:1px solid #f5f2ec;">${tot > 0 ? Math.round((f+m)/tot*100) : 0}</td>
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

    const allHscwB = [{lbl:'&lt; 80 kg',f:0,m:0},{lbl:'80 – 95 kg',f:0,m:0},{lbl:'95 – 100 kg',f:0,m:0},{lbl:'100 – 115 kg',f:0,m:0},{lbl:'115 kg +',f:0,m:0}];
    const allP2B   = [{lbl:'0 – 12 mm',f:0,m:0},{lbl:'13 – 15 mm',f:0,m:0},{lbl:'16 mm +',f:0,m:0}];
    sortedTats.forEach(t => {
      tattooMap[t].hscwB.forEach((b,i) => { allHscwB[i].f += b.f; allHscwB[i].m += b.m; });
      tattooMap[t].p2B.forEach((b,i)   => { allP2B[i].f   += b.f; allP2B[i].m   += b.m; });
    });
    const femCount  = records.filter(r => (r.sex||'').toLowerCase() === 'f').length;
    const maleCount = records.length - femCount;

    const allPigsCard = `
      <div style="border:1px solid #1D9E75;border-radius:8px;overflow:hidden;margin-bottom:16px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f0faf6;border-bottom:1px solid #b2dfdb;">
          <tr>
            <td style="padding:9px 12px;">
              <span style="font-size:13px;font-weight:700;color:#1D9E75;">ALL PIGS</span>
              <span style="font-size:11px;color:#555;margin-left:8px;">${total} PIGS &nbsp;·</span>
              <span style="font-size:11px;font-weight:700;color:#F01A8C;margin-left:6px;">F ${femCount}</span>
              <span style="font-size:11px;font-weight:700;color:#2979FF;margin-left:6px;">M ${maleCount}</span>
            </td>
            <td style="padding:9px 12px;font-size:10px;color:#aaa;text-align:right;">Avg HSCW ${avgHscw} kg &nbsp;·&nbsp; Avg P2 ${avgP2} mm</td>
          </tr>
        </table>
        ${twoColTable('WEIGHT (HSCW)', allHscwB.map(b => bRow(b.lbl,b.f,b.m,total)).join(''), 'FAT DEPTH (P2)', allP2B.map(b => bRow(b.lbl,b.f,b.m,total)).join(''))}
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
        ${twoColTable('WEIGHT (HSCW)', d.hscwB.map(b => bRow(b.lbl,b.f,b.m,d.total)).join(''), 'FAT DEPTH (P2)', d.p2B.map(b => bRow(b.lbl,b.f,b.m,d.total)).join(''))}
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
        <div style="font-size:28px;font-weight:700;color:#1a1a1a;line-height:1;">${avgHscw}</div>
        <div style="font-size:11px;color:#aaa;margin-top:4px;">kg</div>
      </td>
      <td width="25%" valign="top" style="padding:16px;text-align:center;border-right:1px solid #f0ede6;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.8px;color:#aaa;margin-bottom:8px;">AVG P2</div>
        <div style="font-size:28px;font-weight:700;color:#1a1a1a;line-height:1;">${avgP2}</div>
        <div style="font-size:11px;color:#aaa;margin-top:4px;">mm</div>
      </td>
      <td width="25%" valign="top" style="padding:16px;text-align:center;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.8px;color:#aaa;margin-bottom:8px;">CONDEMN RATE</div>
        <div style="font-size:28px;font-weight:700;color:${Number(condemnRate)>2?'#c62828':'#1a1a1a'};line-height:1;">${condemnRate}%</div>
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

    log('Sending kill data email...');
    const res = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: 'api-4B549E0D303940548B3D5A7823EA5E6E',
        to: ['nathan@wilsonporkco.com.au','unitone@wilsonporkco.com.au','unittwo@wilsonporkco.com.au','zack@wilpakmeats.com.au'],
        sender: 'Wilson Pork Co <admin@wilsonporkco.com.au>',
        subject: `Kill Data Summary ${dateLabel}`,
        html_body: html,
      }),
    });
    const result = await res.json();
    if (result.data?.succeeded === 1) {
      log('✓ Kill data email sent');
    } else {
      log('Email send issue: ' + JSON.stringify(result));
    }
  } catch (e) {
    log('Email failed (non-fatal): ' + e.message);
  }
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
    // Parse all rows
    const parsed = rows.map(r => {
      const hscw      = parseNum(r.hscw);
      const p2        = parseNum(r.p2fat || r.p2 || '0');
      const sex       = (r.sex || '').toLowerCase().startsWith('f') ? 'f' : 'm';
      const tattoo    = normaliseTattoo(r.tattoo || '');
      const organDesc = (r.organdesc || r.organ || '').trim();
      const condemned = organDesc.length > 0 && organDesc !== '0';
      return {
        uploadId, date: normaliseDate(r.killdate || r.date || ''),
        hscw, p2, sex, tattoo, condemned,
        condemnDesc: condemned ? organDesc : '',
        bodyno: r.bodyno ? r.bodyno.trim() : '',
      };
    });

    // Filter: must have hscw or p2 (matches frontend logic)
    const validRows = parsed.filter(r => r.hscw > 0 || r.p2 > 0);

    // Deduplicate by bodyno + hscw + tattoo (all three must match to be a duplicate)
    const seen = new Map();
    const deduped = [];
    let duplicateCount = 0;
    validRows.forEach(r => {
      if (r.bodyno) {
        if (!seen.has(r.bodyno)) {
          const hscwMap = new Map();
          hscwMap.set(r.hscw, new Set([r.tattoo]));
          seen.set(r.bodyno, hscwMap);
          deduped.push(r);
        } else {
          const hscwMap = seen.get(r.bodyno);
          if (!hscwMap.has(r.hscw)) {
            hscwMap.set(r.hscw, new Set([r.tattoo]));
            deduped.push(r);
          } else {
            const tattooSet = hscwMap.get(r.hscw);
            if (!tattooSet.has(r.tattoo)) {
              tattooSet.add(r.tattoo);
              deduped.push(r);
            } else {
              duplicateCount++;
            }
          }
        }
      } else {
        deduped.push(r);
      }
    });
    if (duplicateCount > 0) log(`Removed ${duplicateCount} duplicate records`);

    const records = deduped.map((r, i) => ({ ...r, id: `${uploadId}-${i}` }));

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

    // 10. Send email
    await sendKillEmail(records, upload);

  } catch (err) {
    log('ERROR: ' + err.message);
    await browser.close();
    process.exit(1);
  }
})();
