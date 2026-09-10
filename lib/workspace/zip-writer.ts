/**
 * Minimal pure-TypeScript ZIP file writer for CoderXP M2 Workspace Alpha.
 *
 * Commit 7 scope: generates a real ZIP archive from in-memory file data
 * without any external dependency (no JSZip, no fflate, no browser API).
 *
 * Uses the STORE method (no compression) for maximum compatibility and
 * simplicity. The resulting ZIP is a valid PKZIP archive that all major
 * operating systems can extract.
 *
 * Format reference: PKZIP APPNOTE 6.3.0, sections 4.3 (general structure),
 * 4.4 (local file header), 4.5 (central directory), 4.6 (EOCD).
 */

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

/** Pre-computed CRC32 lookup table (polynomial 0xEDB88320). */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

/** Compute CRC32 of a Uint8Array. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// DOS date/time
// ---------------------------------------------------------------------------

/**
 * Convert a JS Date to a DOS-encoded date/time pair.
 * Returns [dosTime, dosDate] as used in ZIP headers.
 */
function toDosDateTime(date: Date): [number, number] {
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return [dosTime, dosDate];
}

// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------

/** Write an unsigned 16-bit little-endian value. */
function writeUint16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

/** Write an unsigned 32-bit little-endian value. */
function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

// ---------------------------------------------------------------------------
// ZIP entry
// ---------------------------------------------------------------------------

/** A single file entry to write into the ZIP archive. */
export interface ZipEntry {
  /** Relative path within the archive (e.g. "src/index.html"). */
  path: string;
  /** File contents as UTF-8 bytes. */
  data: Uint8Array;
  /** Last modification time. */
  modTime: Date;
}

// ---------------------------------------------------------------------------
// ZIP writer
// ---------------------------------------------------------------------------

/**
 * Generate a ZIP archive from the given entries.
 *
 * Uses the STORE method (no compression). All entries are written with
 * proper local file headers, a central directory, and an end-of-central-
 * directory record. The result is a valid PKZIP archive.
 *
 * @returns The complete ZIP file as a Uint8Array.
 */
export function createZip(entries: ZipEntry[]): Uint8Array {
  // Collect local header + data chunks and central directory entries.
  const chunks: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const filenameBytes = new TextEncoder().encode(entry.path);
    const crc = crc32(entry.data);
    const [dosTime, dosDate] = toDosDateTime(entry.modTime);
    const compressedSize = entry.data.length;
    const uncompressedSize = entry.data.length;

    // --- Local file header (30 bytes + filename) ---
    const localHeader = new Uint8Array(30 + filenameBytes.length);
    const lh = localHeader;
    // Signature
    writeUint32LE(lh, 0, 0x04034b50);
    // Version needed to extract (20 = 2.0)
    writeUint16LE(lh, 4, 20);
    // General purpose bit flag (0 = no encryption, no data descriptor)
    writeUint16LE(lh, 6, 0);
    // Compression method (0 = stored)
    writeUint16LE(lh, 8, 0);
    // Last mod file time
    writeUint16LE(lh, 10, dosTime);
    // Last mod file date
    writeUint16LE(lh, 12, dosDate);
    // CRC-32
    writeUint32LE(lh, 14, crc);
    // Compressed size
    writeUint32LE(lh, 18, compressedSize);
    // Uncompressed size
    writeUint32LE(lh, 22, uncompressedSize);
    // File name length
    writeUint16LE(lh, 26, filenameBytes.length);
    // Extra field length
    writeUint16LE(lh, 28, 0);
    // File name
    lh.set(filenameBytes, 30);

    chunks.push(localHeader);
    chunks.push(entry.data);
    const localHeaderOffset = offset;
    offset += localHeader.length + entry.data.length;

    // --- Central directory record (46 bytes + filename) ---
    const centralRecord = new Uint8Array(46 + filenameBytes.length);
    const cd = centralRecord;
    // Signature
    writeUint32LE(cd, 0, 0x02014b50);
    // Version made by (20 = 2.0, 0 = MS-DOS)
    writeUint16LE(cd, 4, 20);
    // Version needed to extract
    writeUint16LE(cd, 6, 20);
    // General purpose bit flag
    writeUint16LE(cd, 8, 0);
    // Compression method
    writeUint16LE(cd, 10, 0);
    // Last mod file time
    writeUint16LE(cd, 12, dosTime);
    // Last mod file date
    writeUint16LE(cd, 14, dosDate);
    // CRC-32
    writeUint32LE(cd, 16, crc);
    // Compressed size
    writeUint32LE(cd, 20, compressedSize);
    // Uncompressed size
    writeUint32LE(cd, 24, uncompressedSize);
    // File name length
    writeUint16LE(cd, 28, filenameBytes.length);
    // Extra field length
    writeUint16LE(cd, 30, 0);
    // File comment length
    writeUint16LE(cd, 32, 0);
    // Disk number start
    writeUint16LE(cd, 34, 0);
    // Internal file attributes
    writeUint16LE(cd, 36, 0);
    // External file attributes
    writeUint32LE(cd, 38, 0);
    // Relative offset of local header
    writeUint32LE(cd, 42, localHeaderOffset);
    // File name
    cd.set(filenameBytes, 46);

    centralRecords.push(centralRecord);
  }

  // --- Central directory size ---
  let centralDirSize = 0;
  for (const cd of centralRecords) {
    centralDirSize += cd.length;
  }
  const centralDirOffset = offset;

  // --- End of central directory record (22 bytes) ---
  const eocd = new Uint8Array(22);
  // Signature
  writeUint32LE(eocd, 0, 0x06054b50);
  // Number of this disk
  writeUint16LE(eocd, 4, 0);
  // Disk where central directory starts
  writeUint16LE(eocd, 6, 0);
  // Number of central directory records on this disk
  writeUint16LE(eocd, 8, entries.length);
  // Total number of central directory records
  writeUint16LE(eocd, 10, entries.length);
  // Size of central directory
  writeUint32LE(eocd, 12, centralDirSize);
  // Offset of start of central directory
  writeUint32LE(eocd, 16, centralDirOffset);
  // Comment length
  writeUint16LE(eocd, 20, 0);

  // --- Assemble the final ZIP ---
  const totalSize =
    offset + centralDirSize + eocd.length;
  const zip = new Uint8Array(totalSize);
  let pos = 0;

  for (const chunk of chunks) {
    zip.set(chunk, pos);
    pos += chunk.length;
  }

  for (const cd of centralRecords) {
    zip.set(cd, pos);
    pos += cd.length;
  }

  zip.set(eocd, pos);

  return zip;
}
