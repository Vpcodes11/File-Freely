/* FileFreely bank file converter.
   Reads CSV, Excel, PDF statements and OFX/QFX/QBO files in the browser and writes
   QBO, QFX, OFX, IIF, QIF and CSV files for QuickBooks, Quicken, Xero and others.
   Nothing is uploaded. Free downloads include the first FREE_LIMIT transactions;
   a FileFreely Pro license key unlocks the full file. */
(function () {
  'use strict';
  const FREE_LIMIT = 10;
  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const LICENSE_KEY_STORE = 'ff_license_v1';
  const PAY = window.FF_PAY || {};
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, attrs, kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') n.textContent = v; else if (k === 'html') n.innerHTML = v; else n.setAttribute(k, v);
    }
    for (const kid of kids || []) n.append(kid);
    return n;
  };

  /* ---------- library loading ---------- */
  const libs = new Map();
  function library(name, src) {
    if (window[name]) return Promise.resolve(window[name]);
    if (!libs.has(name)) {
      libs.set(name, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => window[name] ? resolve(window[name]) : reject(new Error('A browser library did not load.'));
        s.onerror = () => reject(new Error('Could not load a browser library. Check your connection and try again.'));
        document.head.append(s);
      }).catch(e => { libs.delete(name); throw e; }));
    }
    return libs.get(name);
  }

  /* ---------- text parsing helpers ---------- */
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/).slice(0, 20).join('\n');
    const count = c => (first.match(new RegExp(c === '\t' ? '\t' : '\\' + c, 'g')) || []).length;
    const delim = [',', ';', '\t', '|'].sort((a, b) => count(b) - count(a))[0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"' && cell.trim() === '') { q = true; cell = ''; }
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''));
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function monthNum(s) { return MONTHS[String(s).toLowerCase().slice(0, 4)] || MONTHS[String(s).toLowerCase().slice(0, 3)] || 0; }
  function fullYear(y, fallback) {
    if (y === undefined || y === null || y === '') return fallback;
    y = Number(y); return y < 100 ? 2000 + y : y;
  }
  function valid(y, m, d) {
    if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 ? { y, m, d } : null;
  }
  /* order: 'auto' | 'mdy' | 'dmy' | 'ymd'. Returns {y,m,d} or null. */
  function parseDate(raw, order, fallbackYear) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number' && raw > 20000 && raw < 80000) { // Excel serial date
      const dt = new Date(Date.UTC(1899, 11, 30) + raw * 86400000);
      return valid(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    const s = String(raw).trim().replace(/\s+/g, ' ');
    if (!s) return null;
    let m;
    if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T].*)?$/))) return valid(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(?:\d{6})?(?:\.\d+)?(?:\[.*\])?$/))) return valid(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[-\/. ]([A-Za-z]{3,9})\.?(?:[-\/., ]+(\d{2,4}))?$/))) {
      const mo = monthNum(m[2]); return mo ? valid(fullYear(m[3], fallbackYear), mo, +m[1]) : null;
    }
    if ((m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,?(?: (\d{2,4}))?$/))) {
      const mo = monthNum(m[1]); return mo ? valid(fullYear(m[3], fallbackYear), mo, +m[2]) : null;
    }
    if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})(?:[-\/.](\d{2,4}))?(?: .*)?$/))) {
      const a = +m[1], b = +m[2], y = fullYear(m[3], fallbackYear);
      if (order === 'dmy') return valid(y, b, a);
      if (order === 'mdy') return valid(y, a, b);
      return valid(y, a, b) || valid(y, b, a);
    }
    return null;
  }
  function guessDateOrder(values, hint) {
    let mdy = 0, dmy = 0;
    for (const v of values) {
      const m = String(v || '').trim().match(/^(\d{1,2})[-\/.](\d{1,2})/);
      if (!m) continue;
      if (+m[1] > 12 && +m[2] <= 12) dmy++;
      if (+m[2] > 12 && +m[1] <= 12) mdy++;
    }
    return dmy > mdy ? 'dmy' : mdy > dmy ? 'mdy' : (hint === 'dmy' ? 'dmy' : 'mdy');
  }
  /* Returns a number or null. Handles $1,234.56  (12.00)  12.00-  12.00 CR/DR  1.234,56 */
  function parseAmount(raw) {
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    let s = String(raw || '').trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/\s*(CR)$/i.test(s)) { s = s.replace(/\s*CR$/i, ''); }
    else if (/\s*(DR|DB)$/i.test(s)) { neg = !neg; s = s.replace(/\s*(DR|DB)$/i, ''); }
    s = s.replace(/[$£€¥₹]|USD|GBP|EUR|CAD|AUD/gi, '').replace(/\s/g, '');
    if (/-$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
    if (/^[+-]/.test(s)) { if (s[0] === '-') neg = !neg; s = s.slice(1); }
    if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    if (!/^\d*\.?\d+$/.test(s)) return null;
    const n = Number(s);
    return isFinite(n) ? (neg ? -n : n) : null;
  }

  /* ---------- reading inputs ---------- */
  async function readXlsx(file) {
    const XLSX = await library('XLSX', '/reconcile/vendor/xlsx-0.20.3.min.js');
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    return rows.map(r => r.map(c => (typeof c === 'number' ? c : String(c).trim()))).filter(r => r.some(c => c !== ''));
  }

  async function pdfEngine() {
    const path = 'pdfjs-dist@3.11.174/';
    const engine = await library('pdfjsLib', CDN + path + 'build/pdf.min.js');
    engine.GlobalWorkerOptions.workerSrc = CDN + path + 'build/pdf.worker.min.js';
    return engine;
  }
  function pdfLines(page, content) {
    const vp = page.getViewport({ scale: 1 });
    const runs = content.items.filter(i => i.str && i.str.trim()).map(i => {
      const [a, b, , , x, y] = i.transform;
      const [left, top] = vp.convertToViewportPoint(x, y);
      return { text: i.str.trim(), x: left, y: top, w: Math.abs(i.width), h: Math.max(1, i.height || Math.hypot(a, b)), flat: Math.abs(b) < Math.abs(a) + .01 };
    }).filter(r => r.flat && isFinite(r.x) && isFinite(r.y));
    runs.sort((p, q) => p.y - q.y || p.x - q.x);
    const lines = [];
    for (const r of runs) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - r.y) <= Math.min(3.5, Math.max(1.5, Math.min(last.h, r.h) * .3))) last.runs.push(r);
      else lines.push({ y: r.y, h: r.h, runs: [r] });
    }
    return lines.map(l => {
      l.runs.sort((p, q) => p.x - q.x);
      const cells = []; let end = -Infinity;
      for (const r of l.runs) {
        const gap = Math.max(5, .62 * r.h);
        const prev = cells[cells.length - 1];
        if (!prev || r.x - end >= gap) cells.push({ left: r.x, right: r.x + r.w, text: r.text });
        else { prev.text += (r.x - end > Math.max(.35, r.h * .08) ? ' ' : '') + r.text; prev.right = Math.max(prev.right, r.x + r.w); }
        end = Math.max(end, r.x + r.w);
      }
      return cells;
    });
  }
  /* Turn PDF statement lines into rows. Lines that start with a date and contain amounts
     begin a transaction. Amounts are placed under the numeric column headings
     (Amount, Paid out, Paid in, Balance...) by their position on the page. Following
     lines without a date or amount are appended to the description. */
  const HEAD_RX = /^(date|trans(action)?\.? date|post(ing|ed)? date|description|details|transaction|particulars|narrative|payee|amount|debit|credit|withdrawals?|deposits?|paid out|paid in|money out|money in|balance|charges?|payments?( and credits)?|purchases?)\b/i;
  const NUM_HEAD_RX = /amount|debit|credit|withdraw|deposit|paid|money|balance|charge|payment|purchase|in$|out$/i;
  const MONEY_RX = /^[(\-+]?[$£€]?\s?\d[\d,.\s]*\d\)?(\s?(CR|DR|-))?$/i;
  async function readPdf(file, onProgress) {
    const engine = await pdfEngine();
    const task = engine.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, cMapUrl: CDN + 'pdfjs-dist@3.11.174/cmaps/', cMapPacked: true });
    let doc;
    try { doc = await task.promise; }
    catch (e) {
      if (e && (e.name === 'PasswordException' || /password/i.test(e.message))) throw new Error('This PDF is password-protected. Save an unlocked copy and try again.');
      throw new Error('This PDF could not be read. Try downloading a fresh copy from your bank.');
    }
    const max = Math.min(doc.numPages, 150);
    const out = [];
    const dateStart = /^(\d{1,4}[-\/.]\d{1,2}(?:[-\/.]\d{2,4})?|\d{1,2}[ -][A-Za-z]{3,9}\.?(?:[ -]\d{2,4})?|[A-Za-z]{3,9}\.? \d{1,2}(?:,? \d{4})?)\b/;
    let textFound = false, numCols = null, colNames = [];
    const isMoney = t => MONEY_RX.test(t) && /[.,]\d{2}\)?(\s?(CR|DR|-))?$/i.test(t) && parseAmount(t) !== null;
    for (let p = 1; p <= max; p++) {
      const page = await doc.getPage(p);
      const lines = pdfLines(page, await page.getTextContent());
      if (lines.length) textFound = true;
      let open = false;
      for (const cells of lines) {
        const texts = cells.map(c => c.text);
        const joined = texts.join(' ');
        // header line?
        const heads = cells.filter(c => HEAD_RX.test(c.text));
        if (heads.length >= 2 && heads.length >= cells.length - 1 && !cells.some(c => isMoney(c.text))) {
          const nums = cells.filter(c => NUM_HEAD_RX.test(c.text) && !/date|description|details/i.test(c.text));
          if (nums.length) { numCols = nums.map(c => ({ name: c.text.replace(/\s+/g, ' '), left: c.left, right: c.right })); }
          open = false; continue;
        }
        const m = joined.match(dateStart);
        const amountCells = [];
        for (let i = cells.length - 1; i >= 1; i--) { if (isMoney(cells[i].text)) amountCells.unshift(cells[i]); else break; }
        if (m && amountCells.length && parseDate(m[1], 'auto', 2000)) {
          const restText = cells.slice(0, cells.length - amountCells.length).map(c => c.text).join(' ');
          let desc = restText.slice(restText.indexOf(m[1]) + m[1].length).trim();
          const second = desc.match(dateStart);
          if (second && second.index === 0 && parseDate(second[1], 'auto', 2000)) desc = desc.slice(second[1].length).trim();
          let values;
          if (numCols) {
            values = numCols.map(() => '');
            for (const a of amountCells) {
              let best = 0, dist = Infinity;
              numCols.forEach((col, i) => { const d = Math.min(Math.abs(col.right - a.right), Math.abs((col.left + col.right) / 2 - (a.left + a.right) / 2)); if (d < dist) { dist = d; best = i; } });
              values[best] = values[best] ? values[best] : a.text;
            }
            colNames = numCols.map(c => c.name);
          } else values = amountCells.map(c => c.text);
          out.push({ cells: [m[1], desc, ...values], named: !!numCols });
          open = true;
        } else if (open && out.length && !amountCells.length && !m && joined.length < 120 && cells[0] && cells[0].left > 30 && !/^(page|balance|total|opening|closing|continued|statement|account)/i.test(joined)) {
          const last = out[out.length - 1];
          if (last.cells[1].length < 160) last.cells[1] += ' ' + joined; else open = false;
        } else open = false;
      }
      page.cleanup();
      if (onProgress) onProgress(p / max);
    }
    task.destroy();
    if (!textFound) throw new Error('This PDF has no selectable text (it is probably a scan). Download the statement from online banking as a PDF or CSV instead.');
    if (!out.length) throw new Error('No transaction lines were found. Try the CSV download from your online banking, or our Bank Statement Converter to inspect the table.');
    const named = out.every(r => r.named) && colNames.length;
    const width = Math.max(...out.map(r => r.cells.length));
    const header = ['Date', 'Description'];
    for (let i = 2; i < width; i++) header.push(named ? colNames[i - 2] || 'Amount ' + (i - 1) : 'Amount ' + (i - 1));
    // unnamed rows with fewer amounts: assume the last value is the balance and the first the amount
    return [header, ...out.map(r => { const a = r.cells.slice(); while (a.length < width) a.splice(named ? a.length : 3, 0, ''); return a; })];
  }

  /* OFX / QFX / QBO reader (SGML 1.x and XML 2.x) */
  function readOfx(text) {
    const tag = (blk, name) => { const m = blk.match(new RegExp('<' + name + '>([^<\\r\\n]*)', 'i')); return m ? m[1].trim() : ''; };
    const blocks = text.split(/<STMTTRN>/i).slice(1).map(b => b.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0]);
    if (!blocks.length) throw new Error('No transactions were found in this OFX, QFX or QBO file.');
    const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const rows = [['Date', 'Payee', 'Amount', 'Memo', 'Check number', 'Type', 'FITID']];
    for (const b of blocks) rows.push([tag(b, 'DTPOSTED').slice(0, 8), unesc(tag(b, 'NAME') || tag(b, 'PAYEE')), tag(b, 'TRNAMT'), unesc(tag(b, 'MEMO')), tag(b, 'CHECKNUM'), tag(b, 'TRNTYPE'), tag(b, 'FITID')]);
    const meta = { currency: tag(text, 'CURDEF') || 'USD', account: tag(text, 'ACCTID'), bid: tag(text, 'INTU.BID'), credit: /<CCACCTFROM>/i.test(text) };
    return { rows, meta };
  }

  /* ---------- column detection ---------- */
  const RX = {
    date: /^(trans(action)?\.? ?)?date|posted|posting date|booking date|value date|^date/i,
    desc: /desc|details|narrative|payee|merchant|memo|particulars|transaction$|^name|reference text|^transaction details/i,
    amount: /^(transaction )?amount|^value$|^amount|^net amount|^net total|sum/i,
    debit: /debit|withdraw|paid out|money out|spent|outflow|charges?$|payments? out/i,
    credit: /credit|deposit|paid in|money in|received|inflow|payments? in|refund/i,
    check: /check or slip|check ?(no|number|#)|cheque|chq|^ref(erence)?( no| number)?$|^num/i,
    memo: /^memo|^notes?$|^category/i
  };
  function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const r = rows[i].map(c => String(c));
      if (r.some(c => /\d/.test(c) && parseDate(c, 'auto', 2024))) continue;
      const hits = r.filter(c => RX.date.test(c) || RX.desc.test(c) || RX.amount.test(c) || RX.debit.test(c) || RX.credit.test(c)).length;
      if (hits >= 2 && r.filter(c => c).length >= 2 && r.some(c => RX.date.test(c))) return i;
    }
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const r = rows[i].map(c => String(c));
      if (r.some(c => /\d/.test(c) && parseDate(c, 'auto', 2024))) continue;
      const hits = r.filter(c => RX.date.test(c) || RX.desc.test(c) || RX.amount.test(c) || RX.debit.test(c) || RX.credit.test(c)).length;
      if (hits >= 2 && r.filter(c => c).length >= 2) return i;
    }
    return -1;
  }
  function autoMap(header, data) {
    const n = Math.max(header.length, ...data.slice(0, 50).map(r => r.length));
    const H = Array.from({ length: n }, (_, i) => String(header[i] || ''));
    const col = (rx, skip) => H.findIndex((h, i) => rx.test(h) && !(skip || []).includes(i));
    const share = (i, test) => { const vals = data.slice(0, 60).map(r => r[i]).filter(v => v !== '' && v !== undefined); return vals.length ? vals.filter(test).length / vals.length : 0; };
    let date = col(RX.date);
    if (date < 0) date = H.findIndex((_, i) => share(i, v => parseDate(v, 'auto', 2024)) > .6);
    let debit = col(RX.debit, [date]), credit = col(RX.credit, [date, debit]);
    let amount = col(RX.amount, [date, debit, credit]);
    if (amount < 0 && (debit < 0 || credit < 0)) {
      const numeric = H.map((_, i) => i).filter(i => i !== date && share(i, v => parseAmount(v) !== null) > .6);
      if (numeric.length) amount = numeric[0]; // first numeric column; a trailing one is usually the balance
      debit = credit = -1;
    }
    let desc = -1;
    for (const rx of [/^(transaction )?desc/i, /payee|merchant|^name/i, /narrative|particulars|^transaction details|reference text/i, /details|^transaction$/i, /memo/i]) { desc = col(rx, [date, amount, debit, credit]); if (desc >= 0) break; }
    if (desc < 0) {
      let best = -1, len = 0;
      H.forEach((_, i) => { if ([date, amount, debit, credit].includes(i)) return; const l = data.slice(0, 40).reduce((s, r) => s + String(r[i] || '').length, 0); if (l > len) { len = l; best = i; } });
      desc = best;
    }
    const check = col(RX.check, [date, amount, debit, credit, desc]);
    let memo = -1;
    for (const rx of [/^memo/i, /^notes?$/i, /^category/i]) { memo = col(rx, [date, amount, debit, credit, desc, check]); if (memo >= 0) break; }
    return { n, H, date, desc, amount, debit, credit, check, memo, mode: (debit >= 0 && credit >= 0 && amount < 0) ? 'split' : 'single' };
  }

  /* ---------- transactions ---------- */
  function buildTransactions(data, map, opts) {
    const order = opts.dateOrder === 'auto' ? guessDateOrder(data.map(r => r[map.date]), opts.dateHint) : opts.dateOrder;
    const tx = []; let skipped = 0;
    for (const r of data) {
      const date = parseDate(r[map.date], order, opts.year);
      let amount = null;
      if (map.mode === 'split') {
        const d = parseAmount(r[map.debit]), c = parseAmount(r[map.credit]);
        if (d !== null && d !== 0) amount = -Math.abs(d);
        else if (c !== null) amount = Math.abs(c);
      } else amount = parseAmount(r[map.amount]);
      if (!date || amount === null) { skipped++; continue; }
      if (opts.flip) amount = -amount;
      const payee = String(r[map.desc] ?? '').replace(/\s+/g, ' ').trim().replace(/^'+/, '');
      if (/^(opening|closing|brought forward|carried forward|balance b\/?f|balance c\/?f|total)\b/i.test(payee)) { skipped++; continue; }
      tx.push({ date, amount: Math.round(amount * 100) / 100, payee: payee || 'Transaction', memo: map.memo >= 0 ? String(r[map.memo] ?? '').trim() : '', check: map.check >= 0 ? String(r[map.check] ?? '').replace(/\D/g, '').slice(0, 12) : '', fitid: map.fitid >= 0 ? String(r[map.fitid] ?? '') : '' });
    }
    return { tx, skipped };
  }

  /* ---------- writers ---------- */
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.y + pad(d.m) + pad(d.d);
  const mdyS = d => pad(d.m) + '/' + pad(d.d) + '/' + d.y;
  const money = n => n.toFixed(2);
  const sgml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n\t]+/g, ' ');
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  function fitids(tx) {
    const seen = {};
    return tx.map(t => {
      if (t.fitid) return t.fitid;
      const base = ymd(t.date) + money(t.amount).replace(/[-.]/g, '') + hash(t.payee + t.memo);
      seen[base] = (seen[base] || 0) + 1;
      return (base + (seen[base] > 1 ? 'n' + seen[base] : '')).slice(0, 32);
    });
  }
  function nowStamp() { const d = new Date(); return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()); }
  function trnType(t, credit) { if (t.check && t.amount < 0 && !credit) return 'CHECK'; return t.amount < 0 ? 'DEBIT' : 'CREDIT'; }
  function writeOfx(tx, o, flavour) {
    const credit = o.accountType === 'CREDITCARD';
    const ids = fitids(tx);
    const dates = tx.map(t => ymd(t.date)).sort();
    const intu = flavour === 'ofx' ? '' : '<INTU.BID>' + sgml(o.bid || '3000') + '\n';
    const fi = flavour === 'ofx' ? '<FI>\n<ORG>FileFreely\n<FID>1001\n</FI>\n' : '<FI>\n<ORG>' + (o.bid === '3000' || !o.bid ? 'Wells Fargo' : 'Bank') + '\n<FID>' + sgml(o.bid || '3000') + '\n</FI>\n';
    const list = tx.map((t, i) => '<STMTTRN>\n<TRNTYPE>' + trnType(t, credit) + '\n<DTPOSTED>' + ymd(t.date) + '120000\n<TRNAMT>' + money(t.amount) + '\n<FITID>' + sgml(ids[i]) + '\n' +
      (t.check && !credit ? '<CHECKNUM>' + t.check + '\n' : '') + '<NAME>' + sgml(t.payee.slice(0, 32)) + '\n' +
      ((t.memo || t.payee.length > 32) ? '<MEMO>' + sgml((t.memo || t.payee).slice(0, 255)) + '\n' : '') + '</STMTTRN>\n').join('');
    const bal = '<LEDGERBAL>\n<BALAMT>' + money(o.balance || 0) + '\n<DTASOF>' + (dates[dates.length - 1] || nowStamp().slice(0, 8)) + '120000\n</LEDGERBAL>\n';
    const acct = credit ? '<CCACCTFROM>\n<ACCTID>' + sgml(o.account || '0000') + '\n</CCACCTFROM>\n'
      : '<BANKACCTFROM>\n<BANKID>' + sgml(o.routing || '123456789') + '\n<ACCTID>' + sgml(o.account || '0000') + '\n<ACCTTYPE>' + (o.accountType === 'SAVINGS' ? 'SAVINGS' : 'CHECKING') + '\n</BANKACCTFROM>\n';
    const body = '<STMTRS>\n<CURDEF>' + sgml(o.currency || 'USD') + '\n' + acct + '<BANKTRANLIST>\n<DTSTART>' + dates[0] + '120000\n<DTEND>' + dates[dates.length - 1] + '120000\n' + list + '</BANKTRANLIST>\n' + bal + '</STMTRS>\n';
    const wrap = credit
      ? '<CREDITCARDMSGSRSV1>\n<CCSTMTTRNRS>\n<TRNUID>1\n<STATUS>\n<CODE>0\n<SEVERITY>INFO\n</STATUS>\n' + body.replace('<STMTRS>', '<CCSTMTRS>').replace('</STMTRS>', '</CCSTMTRS>') + '</CCSTMTTRNRS>\n</CREDITCARDMSGSRSV1>\n'
      : '<BANKMSGSRSV1>\n<STMTTRNRS>\n<TRNUID>1\n<STATUS>\n<CODE>0\n<SEVERITY>INFO\n</STATUS>\n' + body + '</STMTTRNRS>\n</BANKMSGSRSV1>\n';
    const head = 'OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n\n';
    const signon = '<SIGNONMSGSRSV1>\n<SONRS>\n<STATUS>\n<CODE>0\n<SEVERITY>INFO\n</STATUS>\n<DTSERVER>' + nowStamp() + '\n<LANGUAGE>ENG\n' + fi + intu + '</SONRS>\n</SIGNONMSGSRSV1>\n';
    return (head + '<OFX>\n' + signon + wrap + '</OFX>\n').replace(/\n/g, '\r\n');
  }
  function writeQif(tx, o) {
    const type = o.accountType === 'CREDITCARD' ? 'CCard' : 'Bank';
    return ('!Type:' + type + '\n' + tx.map(t => 'D' + mdyS(t.date) + '\nT' + money(t.amount) + '\n' + (t.check ? 'N' + t.check + '\n' : '') + 'P' + t.payee.replace(/\n/g, ' ') + '\n' + (t.memo ? 'M' + t.memo.replace(/\n/g, ' ') + '\n' : '') + '^\n').join('')).replace(/\n/g, '\r\n');
  }
  function writeIif(tx, o) {
    const credit = o.accountType === 'CREDITCARD';
    const clean = s => String(s).replace(/[\t\r\n"]/g, ' ').trim();
    const acct = clean(o.iifAccount || (credit ? 'Credit Card' : 'Checking'));
    const offset = clean(o.iifOffset || 'Ask My Accountant');
    const lines = ['!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO', '!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO', '!ENDTRNS'];
    for (const t of tx) {
      const type = credit ? (t.amount < 0 ? 'CREDIT CARD' : 'CCARD REFUND') : (t.amount < 0 ? 'CHECK' : 'DEPOSIT');
      const memo = clean(t.memo || t.payee);
      lines.push(['TRNS', type, mdyS(t.date), acct, o.iifNames ? clean(t.payee).slice(0, 41) : '', money(t.amount), t.check, memo].join('\t'));
      lines.push(['SPL', type, mdyS(t.date), offset, '', money(-t.amount), t.check, memo].join('\t'));
      lines.push('ENDTRNS');
    }
    return lines.join('\r\n') + '\r\n';
  }
  const csvq = v => { const s = String(v); return /[",\r\n]/.test(s) || /^[=+@-]/.test(s) && isNaN(Number(s)) ? '"' + (/^[=+@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
  function writeCsv(tx, o, kind) {
    let rows;
    if (kind === 'qbocsv') rows = [['Date', 'Description', 'Amount'], ...tx.map(t => [mdyS(t.date), t.payee + (t.memo ? ' ' + t.memo : ''), money(t.amount)])];
    else if (kind === 'xero') rows = [['*Date', '*Amount', 'Payee', 'Description', 'Reference'], ...tx.map(t => [o.ukDates ? pad(t.date.d) + '/' + pad(t.date.m) + '/' + t.date.y : mdyS(t.date), money(t.amount), t.payee, t.memo, t.check])];
    else rows = [['Date', 'Payee', 'Amount', 'Memo', 'Check number'], ...tx.map(t => [t.date.y + '-' + pad(t.date.m) + '-' + pad(t.date.d), t.payee, money(t.amount), t.memo, t.check])];
    return '﻿' + rows.map(r => r.map(csvq).join(',')).join('\r\n') + '\r\n';
  }
  const FORMATS = {
    qbo: { label: 'QBO (QuickBooks Desktop Web Connect)', ext: 'qbo', mime: 'application/vnd.intu.qbo', write: (t, o) => writeOfx(t, o, 'qbo') },
    qfx: { label: 'QFX (Quicken Web Connect)', ext: 'qfx', mime: 'application/vnd.intu.qfx', write: (t, o) => writeOfx(t, o, 'qfx') },
    ofx: { label: 'OFX (Xero, QuickBooks Online, Sage, YNAB, MoneyMoney)', ext: 'ofx', mime: 'application/x-ofx', write: (t, o) => writeOfx(t, o, 'ofx') },
    iif: { label: 'IIF (QuickBooks Desktop import)', ext: 'iif', mime: 'text/plain', write: writeIif },
    qif: { label: 'QIF (Quicken, Banktivity, older apps)', ext: 'qif', mime: 'application/qif', write: writeQif },
    qbocsv: { label: 'CSV for QuickBooks Online (3 columns)', ext: 'csv', mime: 'text/csv', write: (t, o) => writeCsv(t, o, 'qbocsv') },
    xero: { label: 'CSV for Xero (precoded template)', ext: 'csv', mime: 'text/csv', write: (t, o) => writeCsv(t, o, 'xero') },
    csv: { label: 'CSV (date, payee, amount, memo)', ext: 'csv', mime: 'text/csv', write: (t, o) => writeCsv(t, o, 'csv') }
  };

  /* ---------- license ---------- */
  const License = {
    get() { try { return JSON.parse(localStorage.getItem(LICENSE_KEY_STORE)); } catch (e) { return null; } },
    set(v) { try { v ? localStorage.setItem(LICENSE_KEY_STORE, JSON.stringify(v)) : localStorage.removeItem(LICENSE_KEY_STORE); } catch (e) { } },
    async verify(key) {
      const r = await fetch('/api/license', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: key.trim() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'That license key was not recognised.');
      return j;
    },
    async active() {
      const s = License.get();
      if (!s || !s.key) return null;
      if (s.checked && Date.now() - s.checked < 6 * 3600e3 && (!s.expires || s.expires > Date.now())) return s;
      try { const j = await License.verify(s.key); const v = { key: s.key, plan: j.plan, expires: j.expires || 0, checked: Date.now() }; License.set(v); return v; }
      catch (e) { License.set(null); return null; }
    }
  };
  window.FFLicense = License;

  /* ---------- UI ---------- */
  function init(root) {
    const cfg = Object.assign({ input: 'csv', output: 'qbo', accept: '.csv,.txt,.xlsx,.xls,.pdf,.ofx,.qfx,.qbo' }, JSON.parse(root.dataset.config || '{}'));
    root.innerHTML = '';
    const drop = el('label', { class: 'drop' }, [el('input', { class: 'picker', type: 'file', accept: cfg.accept }), el('strong', { text: cfg.dropText || 'Drop your file here or click to choose' }), el('span', { class: 'muted', text: cfg.dropHint || 'CSV, Excel, PDF statement, OFX, QFX or QBO · stays on your device' })]);
    const picker = $('input', drop);
    const fileName = el('p', { class: 'selection-name', text: 'No file selected' });
    const status = el('p', { role: 'status', class: 'muted', text: 'Choose a file to get started.' });
    const mapBox = el('fieldset', { hidden: '' }); mapBox.append(el('legend', { text: 'Check the columns' }));
    const mapFields = el('div', { class: 'fields' }); mapBox.append(mapFields);
    const outBox = el('fieldset', { hidden: '' }); outBox.append(el('legend', { text: 'Output' }));
    const outFields = el('div', { class: 'fields' }); outBox.append(outFields);
    const preview = el('div', { hidden: '' });
    const actions = el('div', { class: 'actions', hidden: '' });
    const dl = el('button', { type: 'button', text: 'Download' });
    const keyBtn = el('button', { type: 'button', class: 'secondary', text: 'Enter license key' });
    actions.append(dl, keyBtn);
    const pay = el('div', { class: 'paywall', hidden: '' });
    const lic = el('p', { class: 'muted license-line' });
    root.append(drop, fileName, mapBox, outBox, preview, actions, pay, lic, status);

    let table = null, header = [], data = [], meta = {}, map = null, txs = [], licensed = null;
    const opts = { dateOrder: 'auto', dateHint: cfg.dateHint || '', flip: !!cfg.flip, year: new Date().getFullYear(), format: cfg.output, accountType: cfg.accountType || 'CHECKING', account: '', bid: '3000', currency: cfg.currency || 'USD', iifAccount: '', iifOffset: 'Ask My Accountant', iifNames: true, ukDates: false };

    function say(t, bad) { status.textContent = t; status.className = bad ? 'error' : 'muted'; }
    function select(id, label, options, value, onchange, hint) {
      const s = el('select', { id });
      for (const [v, t] of options) { const o = el('option', { value: v, text: t }); if (String(v) === String(value)) o.selected = true; s.append(o); }
      s.addEventListener('change', () => onchange(s.value));
      const f = el('div', { class: 'field' }, [el('label', { for: id, text: label }), s]);
      if (hint) f.append(el('span', { class: 'muted', text: hint }));
      return f;
    }
    function input(id, label, value, onchange, attrs) {
      const i = el('input', Object.assign({ id, value }, attrs || {}));
      i.addEventListener('input', () => onchange(i.value));
      return el('div', { class: 'field' }, [el('label', { for: id, text: label }), i]);
    }
    function check(id, label, value, onchange) {
      const i = el('input', { id, type: 'checkbox' }); i.checked = !!value;
      i.addEventListener('change', () => onchange(i.checked));
      return el('label', { class: 'checks', for: id }, [i, document.createTextNode(label)]);
    }
    async function refreshLicense() {
      licensed = await License.active();
      lic.textContent = licensed ? 'FileFreely Pro is active on this browser' + (licensed.expires ? ' until ' + new Date(licensed.expires).toLocaleDateString() : '') + '. Full files are unlocked.' : '';
      keyBtn.hidden = !!licensed;
      if (txs.length) renderPreview();
    }

    function renderMap() {
      mapFields.replaceChildren();
      const cols = [['-1', '(none)'], ...map.H.map((h, i) => [String(i), (h || 'Column ' + (i + 1)) + (data[0] && data[0][i] !== undefined && data[0][i] !== '' ? ' · e.g. ' + String(data[0][i]).slice(0, 24) : '')])];
      const set = k => v => { map[k] = Number(v); recompute(); };
      mapFields.append(select('ff-date', 'Date column', cols, map.date, set('date')));
      mapFields.append(select('ff-desc', 'Description / payee column', cols, map.desc, set('desc')));
      mapFields.append(select('ff-mode', 'Amounts are in', [['single', 'One amount column (+/-)'], ['split', 'Separate debit and credit columns']], map.mode, v => { map.mode = v; renderMap(); recompute(); }));
      if (map.mode === 'split') {
        mapFields.append(select('ff-debit', 'Debit / money out column', cols, map.debit, set('debit')));
        mapFields.append(select('ff-credit', 'Credit / money in column', cols, map.credit, set('credit')));
      } else mapFields.append(select('ff-amount', 'Amount column', cols, map.amount, set('amount')));
      mapFields.append(select('ff-check', 'Check / reference number (optional)', cols, map.check, set('check')));
      mapFields.append(select('ff-memo', 'Memo (optional)', cols, map.memo, set('memo')));
      mapFields.append(select('ff-order', 'Date format', [['auto', 'Detect automatically'], ['mdy', 'Month/Day/Year (US)'], ['dmy', 'Day/Month/Year (UK, EU)'], ['ymd', 'Year-Month-Day']], opts.dateOrder, v => { opts.dateOrder = v; recompute(); }));
      mapFields.append(input('ff-year', 'Year for dates without a year', opts.year, v => { opts.year = Number(v) || new Date().getFullYear(); recompute(); }, { type: 'number', min: '1990', max: '2100' }));
      mapFields.append(check('ff-flip', 'Flip signs (use if spending shows as positive, e.g. many credit card files)', opts.flip, v => { opts.flip = v; recompute(); }));
    }
    function renderOut() {
      outFields.replaceChildren();
      const fmt = opts.format;
      outFields.append(select('ff-format', 'Save as', Object.entries(FORMATS).map(([k, f]) => [k, f.label]), fmt, v => { opts.format = v; renderOut(); renderPreview(); }));
      if (['qbo', 'qfx', 'ofx', 'iif', 'qif'].includes(fmt)) outFields.append(select('ff-type', 'Account type', [['CHECKING', 'Checking / current account'], ['SAVINGS', 'Savings'], ['CREDITCARD', 'Credit card']], opts.accountType, v => { opts.accountType = v; renderOut(); }));
      if (['qbo', 'qfx', 'ofx'].includes(fmt)) {
        outFields.append(input('ff-acct', 'Account number (or last 4 digits)', opts.account, v => { opts.account = v.replace(/[^\w-]/g, '').slice(0, 22); }, { placeholder: 'e.g. 1234' }));
        if (fmt === 'ofx') outFields.append(select('ff-cur', 'Currency', ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'NZD'].map(c => [c, c]), opts.currency, v => { opts.currency = v; }));
        else outFields.append(input('ff-bid', 'Bank ID (INTU.BID)', opts.bid, v => { opts.bid = v.replace(/\D/g, '').slice(0, 5) || '3000'; }, { inputmode: 'numeric', title: '3000 works for most banks. QuickBooks shows it as the bank name during import.' }));
      }
      if (fmt === 'iif') {
        outFields.append(input('ff-iifa', 'QuickBooks account name (exactly as in your chart of accounts)', opts.iifAccount, v => { opts.iifAccount = v; }, { placeholder: opts.accountType === 'CREDITCARD' ? 'Credit Card' : 'Checking' }));
        outFields.append(input('ff-iifo', 'Offset account for the other side', opts.iifOffset, v => { opts.iifOffset = v; }));
        outFields.append(check('ff-iifn', 'Put the payee in the Name field (QuickBooks may ask to add new names)', opts.iifNames, v => { opts.iifNames = v; }));
      }
      if (fmt === 'xero') outFields.append(check('ff-uk', 'Write dates as DD/MM/YYYY (UK, Australia, NZ Xero)', opts.ukDates, v => { opts.ukDates = v; }));
      const note = cfg.notes && cfg.notes[fmt];
      if (note) outFields.append(el('p', { class: 'muted', style: 'grid-column:1/-1', text: note }));
    }
    function renderPreview() {
      preview.replaceChildren();
      if (!txs.length) { preview.hidden = true; actions.hidden = true; return; }
      const shown = txs.slice(0, 12);
      const inflow = txs.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0), outflow = txs.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);
      const t = el('table', { class: 'sheet-preview' });
      t.createCaption().textContent = txs.length + ' transactions · money in ' + money(inflow) + ' · money out ' + money(-outflow) + (txs.length > shown.length ? ' · showing first ' + shown.length : '');
      const h = t.createTHead().insertRow();
      for (const c of ['Date', 'Payee / description', 'Amount']) { const th = el('th', { scope: 'col', text: c }); h.append(th); }
      const b = t.createTBody();
      for (const x of shown) { const r = b.insertRow(); r.insertCell().textContent = x.date.y + '-' + pad(x.date.m) + '-' + pad(x.date.d); r.insertCell().textContent = x.payee + (x.memo ? ' · ' + x.memo : ''); const a = r.insertCell(); a.textContent = money(x.amount); a.className = x.amount < 0 ? 'neg' : 'pos'; }
      preview.append(t); preview.hidden = false; actions.hidden = false;
      const full = licensed || txs.length <= FREE_LIMIT;
      dl.textContent = full ? 'Download ' + FORMATS[opts.format].ext.toUpperCase() + ' (' + txs.length + ' transactions)' : 'Download ' + FORMATS[opts.format].ext.toUpperCase();
      pay.hidden = true;
    }
    function recompute() {
      const r = buildTransactions(data, map, opts);
      txs = r.tx;
      renderPreview();
      if (!txs.length) say('No transactions could be read with these settings. Check the date and amount columns above.', true);
      else say(txs.length + ' transactions ready.' + (r.skipped ? ' ' + r.skipped + (r.skipped === 1 ? ' row' : ' rows') + ' without a valid date and amount ' + (r.skipped === 1 ? 'was' : 'were') + ' skipped (headers, balances, totals).' : ''));
    }
    function showPaywall() {
      pay.replaceChildren();
      const plans = el('div', { class: 'plans' });
      const plan = (title, price, desc, href, primary) => {
        const a = el('a', { class: 'plan' + (primary ? ' primary' : ''), href: href || '#', target: '_blank', rel: 'noopener' }, [el('strong', { text: title }), el('span', { class: 'price', text: price }), el('span', { class: 'muted', text: desc })]);
        if (!href) { a.removeAttribute('href'); a.classList.add('off'); }
        a.addEventListener('click', () => { try { gtag('event', 'begin_checkout', { item_name: title }); } catch (e) { } });
        return a;
      };
      if (PAY.day) plans.append(plan('Just this file', PAY.dayPrice || '$5', 'Full downloads for 24 hours. One-time payment.', PAY.day, false));
      plans.append(plan('7-day pass', PAY.passPrice || '$9', 'Unlimited files for 7 days. One-time payment.', PAY.pass, false), plan('Pro monthly', PAY.monthlyPrice || '$19/mo', 'Unlimited files every month. Cancel anytime.', PAY.monthly, true));
      const free = el('button', { type: 'button', class: 'secondary', text: 'Download the first ' + FREE_LIMIT + ' free' });
      free.addEventListener('click', () => save(txs.slice(0, FREE_LIMIT), true));
      pay.append(el('h3', { text: 'Your file has ' + txs.length + ' transactions' }), el('p', { class: 'muted', text: 'Free downloads include the first ' + FREE_LIMIT + ' transactions. Unlock the full file with FileFreely Pro. After paying, your license key arrives on the receipt and by email: paste it with "Enter license key".' }), plans, el('div', { class: 'actions' }, [free]));
      if (!PAY.pass && !PAY.monthly && !PAY.day) pay.append(el('p', { class: 'muted', text: 'Paid plans open shortly. Until then, contact us for full files.' }));
      pay.hidden = false;
      pay.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      try { gtag('event', 'paywall_view', { tx_count: txs.length, format: opts.format }); } catch (e) { }
    }
    function save(list, partial) {
      const f = FORMATS[opts.format];
      const out = f.write(list, opts);
      const base = (cfg.baseName || fileBase || 'transactions') + (partial ? '-first-' + list.length : '');
      const blob = new Blob([out], { type: f.mime });
      const url = URL.createObjectURL(blob); const a = el('a', { href: url, download: base + '.' + f.ext }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      say('Saved ' + list.length + ' transactions as ' + base + '.' + f.ext + '.' + (cfg.importTip ? ' ' + cfg.importTip : ''));
      try { gtag('event', 'file_converted', { format: opts.format, tx_count: list.length, partial: !!partial }); } catch (e) { }
    }
    dl.addEventListener('click', () => {
      if (!txs.length) return;
      if (licensed || txs.length <= FREE_LIMIT) save(txs, false); else showPaywall();
    });
    keyBtn.addEventListener('click', async () => {
      const key = prompt('Paste your FileFreely Pro license key');
      if (!key) return;
      say('Checking your license key…');
      try { const j = await License.verify(key); License.set({ key: key.trim(), plan: j.plan, expires: j.expires || 0, checked: Date.now() }); await refreshLicense(); say('License key accepted. Full files are unlocked on this browser.'); pay.hidden = true; }
      catch (e) { say(e.message, true); }
    });

    let fileBase = '';
    async function load(file) {
      if (!file) return;
      if (file.size > 40e6) { say('Choose a file under 40 MB.', true); return; }
      fileName.textContent = file.name; fileBase = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 60);
      say('Reading ' + file.name + '…');
      mapBox.hidden = outBox.hidden = preview.hidden = actions.hidden = pay.hidden = true; txs = [];
      try {
        const name = file.name.toLowerCase();
        meta = {};
        if (/\.(ofx|qfx|qbo)$/.test(name)) { const r = readOfx(await file.text()); table = r.rows; meta = r.meta; }
        else if (/\.pdf$/.test(name) || file.type === 'application/pdf') table = await readPdf(file, p => say('Reading PDF… ' + Math.round(p * 100) + '%'));
        else if (/\.(xlsx|xls|xlsm|ods)$/.test(name)) table = await readXlsx(file);
        else table = parseCSV(await file.text());
        if (!table || table.length < 1) throw new Error('The file looks empty.');
        let hi = findHeader(table);
        if (hi < 0) { header = table[0].map((_, i) => 'Column ' + (i + 1)); data = table; }
        else { header = table[hi]; data = table.slice(hi + 1); }
        map = autoMap(header, data);
        if (meta.account) { opts.account = meta.account.slice(-22); if (meta.credit) opts.accountType = 'CREDITCARD'; if (meta.currency) opts.currency = meta.currency; }
        map.fitid = header.indexOf('FITID');
        if (!meta.currency) { const sample = JSON.stringify(table.slice(0, 80)); if (sample.includes('£')) opts.currency = 'GBP'; else if (sample.includes('€')) opts.currency = 'EUR'; }
        renderMap(); renderOut();
        mapBox.hidden = outBox.hidden = false;
        recompute();
      } catch (e) { say(e.message || 'This file could not be read.', true); }
    }
    picker.addEventListener('change', () => { load(picker.files[0]); picker.value = ''; });
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', e => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('drag'); });
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); load(e.dataTransfer.files[0]); });
    refreshLicense();
  }

  window.FFBankFile = { parseCSV, parseDate, parseAmount, guessDateOrder, readOfx, findHeader, autoMap, buildTransactions, writeOfx, writeQif, writeIif, writeCsv, FORMATS, FREE_LIMIT };
  if (typeof document !== 'undefined') document.querySelectorAll('[data-bankfile]').forEach(init);
})();
