import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

// Builds ustar archives in memory so tests can produce entries that system tar refuses to create,
// such as parent-directory names and escaping symlinks.

export interface TestArchiveEntry {
  name: string;
  type?: "file" | "directory" | "symlink";
  content?: string;
  mode?: number;
  linkName?: string;
}

const BLOCK_BYTES = 512;
const TYPE_FLAGS = { file: "0", directory: "5", symlink: "2" } as const;

function writeField(header: Buffer, value: string, offset: number, length: number): void {
  header.write(value, offset, Math.min(Buffer.byteLength(value), length), "utf8");
}

function writeOctalField(header: Buffer, value: number, offset: number, length: number): void {
  writeField(header, `${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
}

function encodeEntry(entry: TestArchiveEntry): Buffer {
  const type = entry.type ?? "file";
  const content = type === "file" ? Buffer.from(entry.content ?? "", "utf8") : Buffer.alloc(0);
  const header = Buffer.alloc(BLOCK_BYTES, 0);
  writeField(header, entry.name, 0, 100);
  writeOctalField(header, entry.mode ?? (type === "directory" ? 0o755 : 0o644), 100, 8);
  writeOctalField(header, 0, 108, 8);
  writeOctalField(header, 0, 116, 8);
  writeOctalField(header, content.length, 124, 12);
  writeOctalField(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write(TYPE_FLAGS[type], 156, 1, "ascii");
  if (entry.linkName) writeField(header, entry.linkName, 157, 100);
  header.write("ustar\x0000", 257, 8, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeField(header, `${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const padding = Buffer.alloc((BLOCK_BYTES - (content.length % BLOCK_BYTES)) % BLOCK_BYTES, 0);
  return Buffer.concat([header, content, padding]);
}

export function createTestTarGz(entries: readonly TestArchiveEntry[]): Buffer {
  return gzipSync(Buffer.concat([...entries.map(encodeEntry), Buffer.alloc(BLOCK_BYTES * 2, 0)]));
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function versionScript(output: string): string {
  return `#!/bin/sh\necho "${output}"\n`;
}
