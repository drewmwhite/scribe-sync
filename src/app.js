import { MTPDevice, MTPError } from './mtp.js';

const TARGETS = [
  { filename: 'My Clippings.txt', path: ['documents', 'My Clippings.txt'] },
  { filename: 'vocab.db',         path: ['system', 'vocabulary', 'vocab.db'] },
];

const VOCAB_QUERY = `
  SELECT
    w.word    AS searched_word,
    l.usage   AS context_used,
    bi.title  AS book_name,
    bi.authors AS author_name
  FROM LOOKUPS AS l
  INNER JOIN WORDS AS w ON w.id = l.word_key
  INNER JOIN BOOK_INFO AS bi ON bi.id = l.book_key
  ORDER BY l.timestamp DESC
`;

const device = new MTPDevice();

let btnConnect, statusEl, resultsEl;

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateCsv(words) {
  const headers = ['Word', 'Context', 'Book', 'Author'];
  const escape  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows    = words.map(w => [
    escape(w.searched_word),
    escape(w.context_used),
    escape(w.book_name),
    escape(w.author_name),
  ].join(','));
  return [headers.join(','), ...rows].join('\r\n');
}

async function parseVocabDb(buffer) {
  const SQL = await initSqlJs({
    locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`,
  });
  const db = new SQL.Database(new Uint8Array(buffer));
  const result = db.exec(VOCAB_QUERY);
  db.close();
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => Object.fromEntries(columns.map((col, i) => [col, row[i]])));
}

// ── Pagination state ─────────────────────────────────────────────────────────
let vocabData    = [];
let currentPage  = 1;
let itemsPerPage = 25;

function renderPage(page) {
  const tbody     = document.getElementById('vocab-tbody');
  const indicator = document.getElementById('page-indicator');
  const btnPrev   = document.getElementById('btn-prev');
  const btnNext   = document.getElementById('btn-next');

  const totalPages = Math.ceil(vocabData.length / itemsPerPage);
  currentPage = Math.max(1, Math.min(page, totalPages));

  const start = (currentPage - 1) * itemsPerPage;
  const slice = vocabData.slice(start, start + itemsPerPage);

  tbody.innerHTML = '';
  for (const w of slice) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="word-cell">${escapeHtml(w.searched_word)}</td>` +
      `<td class="context-cell">${escapeHtml(w.context_used)}</td>` +
      `<td>${escapeHtml(w.book_name)}</td>` +
      `<td>${escapeHtml(w.author_name)}</td>`;
    tbody.appendChild(tr);
  }

  indicator.textContent = `Page ${currentPage} of ${totalPages}`;
  btnPrev.disabled = currentPage === 1;
  btnNext.disabled = currentPage === totalPages;
}

function renderVocab(words) {
  vocabData   = words;
  currentPage = 1;

  const section = document.getElementById('vocab-section');
  const count   = document.getElementById('vocab-count');
  const perPage = document.getElementById('per-page');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');

  count.textContent = `${words.length} word${words.length !== 1 ? 's' : ''}`;

  const btnCsv = document.getElementById('btn-download-csv');
  btnCsv.onclick = () => {
    const csv  = generateCsv(words);
    const blob = new Blob([csv], { type: 'text/csv' });
    triggerDownload('vocab.csv', blob);
  };

  perPage.value = String(itemsPerPage);
  perPage.onchange = () => {
    itemsPerPage = Number(perPage.value);
    renderPage(1);
  };

  btnPrev.onclick = () => renderPage(currentPage - 1);
  btnNext.onclick = () => renderPage(currentPage + 1);

  section.hidden = false;
  renderPage(1);
}

function setStatus(msg, type = 'idle') {
  statusEl.textContent = msg;
  statusEl.dataset.type = type;
}

function triggerDownload(filename, data) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function addResult(filename, buffer, detail) {
  const li = document.createElement('li');
  if (buffer) {
    li.className = 'result-ok';
    const label = document.createElement('span');
    label.textContent = filename;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-file-download';
    btn.textContent = 'Download';
    btn.onclick = () => triggerDownload(filename, buffer);
    li.append(label, btn);
  } else {
    li.className = 'result-err';
    li.textContent = `Not found: ${filename}`;
    if (detail) li.title = detail;
  }
  resultsEl.appendChild(li);
}

async function onConnectClick() {
  // 1. Clear results, disable button
  resultsEl.innerHTML = '';
  btnConnect.disabled = true;

  let usbDevice = null;

  try {
    // 2. Request the USB device
    setStatus('Waiting for device selection…', 'busy');
    try {
      usbDevice = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x1949 }] });
    } catch (err) {
      if (err.name === 'NotFoundError') {
        // User dismissed the picker
        setStatus('', 'idle');
        btnConnect.disabled = false;
        return;
      }
      setStatus(`USB error: ${err.message}`, 'error');
      btnConnect.disabled = false;
      return;
    }

    // 3. Connect
    setStatus('Connecting…', 'busy');
    await device.connect(usbDevice);

    // 4. Find and download each target file by path
    let hasError = false;
    for (const target of TARGETS) {
      setStatus(`Locating ${target.filename}…`, 'busy');
      const entry = await device.getFileByPath(target.path);
      if (!entry) {
        addResult(target.filename, false);
        hasError = true;
        continue;
      }
      setStatus(`Reading ${target.filename}…`, 'busy');
      try {
        const buffer = await device.getObject(entry.handle);
        if (target.filename !== 'vocab.db') addResult(target.filename, buffer);

        if (target.filename === 'vocab.db') {
          setStatus('Parsing vocabulary…', 'busy');
          const words = await parseVocabDb(buffer);
          renderVocab(words);
        }
      } catch (err) {
        addResult(target.filename, null, err.message);
        hasError = true;
      }
    }

    // 6. Final status
    if (hasError) {
      setStatus('Finished with errors.', 'error');
    } else {
      setStatus('Sync complete.', 'done');
    }
  } catch (err) {
    const msg = err instanceof MTPError
      ? `MTP error (0x${(err.responseCode ?? 0).toString(16)}): ${err.message}`
      : `Error: ${err.message}`;
    setStatus(msg, 'error');
  } finally {
    // 7. Always disconnect and re-enable button
    try {
      await device.disconnect();
    } catch (_) { /* ignore disconnect errors */ }
    btnConnect.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  btnConnect = document.getElementById('btn-connect');
  statusEl   = document.getElementById('status');
  resultsEl  = document.getElementById('results');

  // Check for WebUSB support
  if (!navigator.usb) {
    const warning = document.getElementById('browser-warning');
    if (warning) warning.style.display = 'block';
    btnConnect.disabled = true;
    return;
  }

  btnConnect.addEventListener('click', onConnectClick);
});
