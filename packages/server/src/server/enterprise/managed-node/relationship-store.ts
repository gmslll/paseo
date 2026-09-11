import { generateKeyPairSync } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

import { ManagedNodeSchema, type ManagedNode } from "@getpaseo/protocol/enterprise-management";
import { z } from "zod";

import { writePrivateFileAtomicSync } from "../../private-files.js";

export const ManagedNodeRelationshipSchema = z
  .object({
    version: z.literal(1),
    managementBaseUrl: z.string().url(),
    node: ManagedNodeSchema,
    nodePrivateKeyPem: z.string().min(1),
    ticketPublicKeyPem: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const url = new URL(value.managementBaseUrl);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      ctx.addIssue({ code: "custom", message: "managementBaseUrl must be an HTTPS origin" });
    }
  });

export type ManagedNodeRelationship = Readonly<z.infer<typeof ManagedNodeRelationshipSchema>>;

export interface ManagedNodeKeyPair {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}

export function generateManagedNodeKeyPair(): ManagedNodeKeyPair {
  const pair = generateKeyPairSync("ed25519");
  return Object.freeze({
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
}

export function createManagedNodeRelationship(input: {
  readonly managementBaseUrl: string;
  readonly node: ManagedNode;
  readonly nodePrivateKeyPem: string;
  readonly ticketPublicKeyPem: string;
}): ManagedNodeRelationship {
  return freezeRelationship(
    ManagedNodeRelationshipSchema.parse({
      version: 1,
      managementBaseUrl: normalizeManagementOrigin(input.managementBaseUrl),
      node: structuredClone(input.node),
      nodePrivateKeyPem: input.nodePrivateKeyPem,
      ticketPublicKeyPem: input.ticketPublicKeyPem,
    }),
  );
}

export function writeManagedNodeRelationship(
  filePath: string,
  relationship: ManagedNodeRelationship,
): void {
  const canonical = freezeRelationship(
    ManagedNodeRelationshipSchema.parse(structuredClone(relationship)),
  );
  writePrivateFileAtomicSync(filePath, `${JSON.stringify(canonical, null, 2)}\n`);
  const stat = lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)
  ) {
    throw new Error("managed node relationship must be a private regular file");
  }
}

export function readManagedNodeRelationship(filePath: string): ManagedNodeRelationship | null {
  let descriptor: number;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)) {
      throw new Error("managed node relationship must be a private regular file");
    }
    return freezeRelationship(
      ManagedNodeRelationshipSchema.parse(JSON.parse(readFileSync(descriptor, "utf8"))),
    );
  } finally {
    closeSync(descriptor);
  }
}

export function normalizeManagementOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("management URL must be an HTTPS origin");
  }
  return url.origin;
}

function noFollowFlag(): number {
  if (process.platform === "win32") return 0;
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("managed node relationship requires O_NOFOLLOW");
  }
  return constants.O_NOFOLLOW;
}

function freezeRelationship(
  value: z.infer<typeof ManagedNodeRelationshipSchema>,
): ManagedNodeRelationship {
  const node = Object.freeze({
    ...value.node,
    capabilities: Object.freeze({ ...value.node.capabilities }),
    capacity: Object.freeze({ ...value.node.capacity }),
  });
  return Object.freeze({ ...value, node });
}
