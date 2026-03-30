import { MTPDevice, MTPError } from './mtp.js';

const TARGETS = ['My Clippings.txt', 'vocab.db'];

const device = new MTPDevice();

let btnConnect, statusEl, resultsEl;

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

    // 4. List files
    setStatus('Scanning device…', 'busy');
    const files = await device.listFiles();

    // 5. Download each target
    let hasError = false;
    for (const filename of TARGETS) {
      const entry = files.find(f => f.filename === filename);
      if (!entry) {
        addResult(filename, false);
        hasError = true;
        continue;
      }
      setStatus(`Downloading ${filename}…`, 'busy');
      try {
        const buffer = await device.getObject(entry.handle);
        triggerDownload(filename, buffer);
        addResult(filename, true);
      } catch (err) {
        addResult(filename, false, err.message);
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
