// MTP-over-WebUSB implementation
// Supports Kindle Scribe (Amazon vendor ID 0x1949)

export const KINDLE_VENDOR_ID = 0x1949;

const OP = {
  GET_DEVICE_INFO:    0x1001,
  OPEN_SESSION:       0x1002,
  CLOSE_SESSION:      0x1003,
  GET_OBJECT_HANDLES: 0x1007,
  GET_OBJECT_INFO:    0x1008,
  GET_OBJECT:         0x1009,
};

const RESP = {
  OK:                   0x2001,
  SESSION_ALREADY_OPEN: 0x201E,
};

const CTYPE = {
  COMMAND:  1,
  DATA:     2,
  RESPONSE: 3,
};

const CHUNK_SIZE = 65536;

export class MTPError extends Error {
  constructor(message, responseCode) {
    super(message);
    this.name = 'MTPError';
    this.responseCode = responseCode ?? null;
  }
}

export class MTPDevice {
  #device = null;
  #iface = null;
  #bulkIn = null;
  #bulkOut = null;
  #txId = 1;

  /**
   * Open the USB device, claim the MTP interface, and open an MTP session.
   * @param {USBDevice} usbDevice
   */
  async connect(usbDevice) {
    this.#device = usbDevice;
    await this.#device.open();

    // Select configuration 1 if not already selected
    if (this.#device.configuration === null || this.#device.configuration.configurationValue !== 1) {
      await this.#device.selectConfiguration(1);
    }

    // Find the MTP interface: class=6 (Still Image), subclass=1
    let foundIface = null;
    let foundAlt = null;
    for (const iface of this.#device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === 6 && alt.interfaceSubclass === 1) {
          foundIface = iface;
          foundAlt = alt;
          break;
        }
      }
      if (foundIface) break;
    }

    if (!foundIface || !foundAlt) {
      throw new MTPError('No MTP interface found on this device (class=6, subclass=1)');
    }

    this.#iface = foundIface;
    await this.#device.claimInterface(this.#iface.interfaceNumber);

    // Find bulk-in and bulk-out endpoints
    for (const ep of foundAlt.endpoints) {
      if (ep.type === 'bulk') {
        if (ep.direction === 'in') {
          this.#bulkIn = ep;
        } else if (ep.direction === 'out') {
          this.#bulkOut = ep;
        }
      }
    }

    if (!this.#bulkIn || !this.#bulkOut) {
      throw new MTPError('Could not find bulk-in and bulk-out endpoints on the MTP interface');
    }

    await this.#openSession();
  }

  /**
   * Close the MTP session and release the USB interface/device.
   */
  async disconnect() {
    try {
      await this.#closeSession();
    } catch (_) { /* ignore */ }
    try {
      if (this.#iface !== null) {
        await this.#device.releaseInterface(this.#iface.interfaceNumber);
      }
    } catch (_) { /* ignore */ }
    try {
      await this.#device.close();
    } catch (_) { /* ignore */ }

    this.#device = null;
    this.#iface = null;
    this.#bulkIn = null;
    this.#bulkOut = null;
    this.#txId = 1;
  }

  /**
   * Return an array of { handle, filename, filesize } for all objects on the device.
   */
  async listFiles() {
    const handles = await this.#getObjectHandles();
    const results = [];
    for (const handle of handles) {
      try {
        const info = await this.#getObjectInfo(handle);
        results.push(info);
      } catch (_) {
        // Skip objects that fail to return info
      }
    }
    return results;
  }

  /**
   * Download the object identified by handle and return its contents as an ArrayBuffer.
   * @param {number} handle
   * @returns {Promise<ArrayBuffer>}
   */
  async getObject(handle) {
    const payload = await this.#operation(OP.GET_OBJECT, [handle]);
    if (payload === null) {
      throw new MTPError(`GET_OBJECT returned no data for handle 0x${handle.toString(16)}`);
    }
    return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  async #openSession() {
    try {
      await this.#operation(OP.OPEN_SESSION, [1]);
    } catch (err) {
      if (err instanceof MTPError && err.responseCode === RESP.SESSION_ALREADY_OPEN) {
        return; // That's fine — session is already open
      }
      throw err;
    }
  }

  async #closeSession() {
    await this.#operation(OP.CLOSE_SESSION, []);
  }

  async #getObjectHandles() {
    // params: StorageID=0xFFFFFFFF (all), ObjectFormatCode=0x00000000 (all), AssociationOH=0xFFFFFFFF (all)
    const payload = await this.#operation(OP.GET_OBJECT_HANDLES, [0xFFFFFFFF, 0x00000000, 0xFFFFFFFF]);
    if (!payload || payload.byteLength < 4) {
      return [];
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = view.getUint32(0, true);
    const handles = [];
    for (let i = 0; i < count; i++) {
      const offset = 4 + i * 4;
      if (offset + 4 > payload.byteLength) break;
      handles.push(view.getUint32(offset, true));
    }
    return handles;
  }

  async #getObjectInfo(handle) {
    const payload = await this.#operation(OP.GET_OBJECT_INFO, [handle]);
    if (!payload || payload.byteLength < 53) {
      throw new MTPError(`GET_OBJECT_INFO payload too short for handle 0x${handle.toString(16)}`);
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    // ObjectCompressedSize is at offset 8 (u32)
    const filesize = view.getUint32(8, true);

    // PTP string Filename is at byte offset 52
    // PTP string: u8 numChars, then numChars UTF-16LE code units (last is null terminator)
    const numChars = view.getUint8(52);
    let filename = '';
    if (numChars > 1) {
      // Read numChars-1 characters (skip null terminator)
      const chars = [];
      for (let i = 0; i < numChars - 1; i++) {
        const charOffset = 53 + i * 2;
        if (charOffset + 2 > payload.byteLength) break;
        chars.push(String.fromCharCode(view.getUint16(charOffset, true)));
      }
      filename = chars.join('');
    }

    return { handle, filename, filesize };
  }

  /**
   * Send an MTP command and receive the response. If the device sends a DATA
   * container first, return its payload; otherwise return null.
   *
   * @param {number} opCode
   * @param {number[]} params  - array of u32 parameters
   * @returns {Promise<Uint8Array|null>}
   */
  async #operation(opCode, params) {
    const txId = this.#txId++;

    // Build command container: 12 bytes header + 4 bytes per param
    const cmdLength = 12 + params.length * 4;
    const cmdBuf = new ArrayBuffer(cmdLength);
    const cmdView = new DataView(cmdBuf);
    cmdView.setUint32(0, cmdLength, true);          // Length
    cmdView.setUint16(4, CTYPE.COMMAND, true);      // ContainerType
    cmdView.setUint16(6, opCode, true);             // Code
    cmdView.setUint32(8, txId, true);               // TransactionID
    for (let i = 0; i < params.length; i++) {
      cmdView.setUint32(12 + i * 4, params[i] >>> 0, true);
    }

    const outResult = await this.#device.transferOut(this.#bulkOut.endpointNumber, cmdBuf);
    if (outResult.status !== 'ok') {
      throw new MTPError(`transferOut failed with status: ${outResult.status}`);
    }

    // Receive first container
    const first = await this.#recvContainer();

    if (first.ctype === CTYPE.DATA) {
      // There is a data phase — receive the response container as well
      const resp = await this.#recvContainer();
      if (resp.ctype !== CTYPE.RESPONSE) {
        throw new MTPError(`Expected RESPONSE container after DATA, got ctype=${resp.ctype}`);
      }
      if (resp.code !== RESP.OK) {
        throw new MTPError(`MTP response error: 0x${resp.code.toString(16)}`, resp.code);
      }
      return first.payload;
    } else if (first.ctype === CTYPE.RESPONSE) {
      if (first.code !== RESP.OK) {
        throw new MTPError(`MTP response error: 0x${first.code.toString(16)}`, first.code);
      }
      return null;
    } else {
      throw new MTPError(`Unexpected container type: ${first.ctype}`);
    }
  }

  /**
   * Receive a complete MTP container, handling multi-chunk transfers for large
   * data objects. Returns { ctype, code, txId, payload } where payload is the
   * data after the 12-byte MTP container header.
   */
  async #recvContainer() {
    const chunks = [];
    let totalLength = null;
    let accumulated = 0;

    while (true) {
      const result = await this.#device.transferIn(this.#bulkIn.endpointNumber, CHUNK_SIZE);
      if (result.status !== 'ok' && result.status !== 'babble') {
        throw new MTPError(`transferIn failed with status: ${result.status}`);
      }

      const data = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      chunks.push(data);
      accumulated += data.byteLength;

      if (totalLength === null) {
        if (accumulated < 4) {
          // Need more data to read the length field (unlikely but safe)
          continue;
        }
        // Parse total length from the first 4 bytes of the first chunk
        const firstView = new DataView(chunks[0].buffer, chunks[0].byteOffset, chunks[0].byteLength);
        totalLength = firstView.getUint32(0, true);
      }

      // Done if we have all the data, or if a short packet was received
      if (accumulated >= totalLength || data.byteLength < CHUNK_SIZE) {
        break;
      }
    }

    // Assemble all chunks into a single buffer
    const combined = new Uint8Array(accumulated);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    if (combined.byteLength < 12) {
      throw new MTPError(`MTP container too short: ${combined.byteLength} bytes`);
    }

    const view = new DataView(combined.buffer);
    const ctype = view.getUint16(4, true);
    const code  = view.getUint16(6, true);
    const txId  = view.getUint32(8, true);

    // Payload is everything after the 12-byte header, up to totalLength
    const payloadEnd = Math.min(totalLength ?? combined.byteLength, combined.byteLength);
    const payload = new Uint8Array(combined.buffer, 12, Math.max(0, payloadEnd - 12));

    return { ctype, code, txId, payload };
  }
}
