import type { ServerResponse } from "node:http";

const INVALID_FALLBACK_FILENAME = /[^\x20-\x21\x23-\x5b\x5d-\x7e]/gu;

export function attachmentContentDisposition(fileName: string): string {
  const fallback = fileName.replace(INVALID_FALLBACK_FILENAME, "_") || "download";
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/gu,
    (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function writeHttpDownloadChunk(
  response: Pick<ServerResponse, "destroyed" | "write" | "once" | "off">,
  bytes: Uint8Array,
): Promise<void> {
  if (response.destroyed) throw new Error("Download response is closed.");
  if (response.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("error", onError);
      response.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Download response closed before draining."));
    };
    response.once("drain", onDrain);
    response.once("error", onError);
    response.once("close", onClose);
  });
}
