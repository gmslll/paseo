import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";

import { attachmentContentDisposition, writeHttpDownloadChunk } from "./http-download-response.js";

describe("enterprise HTTP download response", () => {
  test("encodes hostile and non-ASCII attachment names", () => {
    expect(attachmentContentDisposition('报告\r\n".txt')).toBe(
      "attachment; filename=\"_____.txt\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%0D%0A%22.txt",
    );
  });

  test("waits for drain and rejects a response closed under backpressure", async () => {
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      write: vi.fn(() => false),
      off: EventEmitter.prototype.off,
      once: EventEmitter.prototype.once,
    });
    const drained = writeHttpDownloadChunk(response, new Uint8Array([1]));
    expect(response.write).toHaveBeenCalledOnce();
    response.emit("drain");
    await expect(drained).resolves.toBeUndefined();

    const closed = writeHttpDownloadChunk(response, new Uint8Array([2]));
    response.emit("close");
    await expect(closed).rejects.toThrow("closed before draining");
  });
});
