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

function renderVocab(words) {
  const section = document.getElementById('vocab-section');
  const tbody   = document.getElementById('vocab-tbody');
  const count   = document.getElementById('vocab-count');

  tbody.innerHTML = '';
  count.textContent = `${words.length} word${words.length !== 1 ? 's' : ''}`;

  for (const w of words) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="word-cell">${escapeHtml(w.searched_word)}</td>` +
      `<td class="context-cell">${escapeHtml(w.context_used)}</td>` +
      `<td>${escapeHtml(w.book_name)}</td>` +
      `<td>${escapeHtml(w.author_name)}</td>`;
    tbody.appendChild(tr);
  }

  section.hidden = false;
}

function setStatus(msg, type = 'idle') {
  statusEl.textContent = msg;
  statusEl.dataset.type = type;
}

function triggerDownload(filename, buffer) {
  const blob = new Blob([buffer]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function addResult(filename, success, detail) {
  const li = document.createElement('li');
  li.className = success ? 'result-ok' : 'result-err';
  if (success) {
    li.textContent = `Downloaded: ${filename}`;
  } else {
    li.textContent = `Not found: ${filename}`;
  }
  if (detail) {
    li.title = detail;
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
      setStatus(`Downloading ${target.filename}…`, 'busy');
      try {
        const buffer = await device.getObject(entry.handle);
        triggerDownload(target.filename, buffer);
        addResult(target.filename, true);

        if (target.filename === 'vocab.db') {
          setStatus('Parsing vocabulary…', 'busy');
          const words = await parseVocabDb(buffer);
          renderVocab(words);
        }
      } catch (err) {
        addResult(target.filename, false, err.message);
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
