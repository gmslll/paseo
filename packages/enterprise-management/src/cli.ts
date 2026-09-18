#!/usr/bin/env node

import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EnterpriseManagementPlane } from "./management-plane.js";
import { createManagementHttpsServer } from "./http-server.js";

interface RuntimeConfig {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly certificatePath: string;
  readonly tlsPrivateKeyPath: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly issuer: string;
  readonly bootstrapSecret: string;
  readonly ticketPrivateKeyPath: string;
  readonly ticketPublicKeyPath: string;
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const dataDirectory = path.resolve(required(env, "PASEO_MANAGEMENT_DATA_DIR"));
  const listen = parseListen(env.PASEO_MANAGEMENT_LISTEN ?? "0.0.0.0:17443");
  const issuer = required(env, "PASEO_MANAGEMENT_ISSUER");
  const parsedIssuer = new URL(issuer);
  if (parsedIssuer.protocol !== "https:") throw new Error("PASEO_MANAGEMENT_ISSUER must use https");
  const bootstrapSecret = required(env, "PASEO_MANAGEMENT_BOOTSTRAP_SECRET");
  if (bootstrapSecret.length < 24)
    throw new Error("PASEO_MANAGEMENT_BOOTSTRAP_SECRET is too short");
  return Object.freeze({
    dataDirectory,
    databasePath: path.join(dataDirectory, "management.sqlite"),
    listenHost: listen.host,
    listenPort: listen.port,
    certificatePath: path.resolve(required(env, "PASEO_MANAGEMENT_TLS_CERT")),
    tlsPrivateKeyPath: path.resolve(required(env, "PASEO_MANAGEMENT_TLS_KEY")),
    organizationId: required(env, "PASEO_MANAGEMENT_ORGANIZATION_ID"),
    organizationName: required(env, "PASEO_MANAGEMENT_ORGANIZATION_NAME"),
    issuer: parsedIssuer.toString().replace(/\/$/, ""),
    bootstrapSecret,
    ticketPrivateKeyPath: path.join(dataDirectory, "ticket-signing-private.pem"),
    ticketPublicKeyPath: path.join(dataDirectory, "ticket-signing-public.pem"),
  });
}

export async function runManagementServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = resolveRuntimeConfig(env);
  preparePrivateDataDirectory(config.dataDirectory);
  ensureSigningKeys(config.ticketPrivateKeyPath, config.ticketPublicKeyPath);
  assertPrivateFile(config.tlsPrivateKeyPath, "TLS private key");
  const plane = new EnterpriseManagementPlane({
    databasePath: config.databasePath,
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    issuer: config.issuer,
    bootstrapSecret: config.bootstrapSecret,
    ticketPrivateKey: readFileSync(config.ticketPrivateKeyPath),
    ticketPublicKey: readFileSync(config.ticketPublicKeyPath),
  });
  if (existsSync(config.databasePath)) chmodSync(config.databasePath, 0o600);
  const server = createManagementHttpsServer({
    plane,
    certificatePath: config.certificatePath,
    privateKeyPath: config.tlsPrivateKeyPath,
  });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    plane.close();
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, config.listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.stdout.write(
    `${JSON.stringify({ event: "management_plane_listening", issuer: config.issuer, listen: `${config.listenHost}:${config.listenPort}` })}\n`,
  );
}

function preparePrivateDataDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const opened = lstatSync(directory);
  if (!opened.isDirectory() || opened.isSymbolicLink()) {
    throw new Error("management data path must be a real directory");
  }
  chmodSync(directory, 0o700);
  if (realpathSync(directory) !== directory) {
    throw new Error("management data path must be canonical");
  }
}

function ensureSigningKeys(privatePath: string, publicPath: string): void {
  const privateExists = existsSync(privatePath);
  const publicExists = existsSync(publicPath);
  if (privateExists !== publicExists) throw new Error("ticket signing key pair is incomplete");
  if (!privateExists) {
    const keys = generateKeyPairSync("ed25519");
    writeFileSync(privatePath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
      flag: "wx",
    });
    writeFileSync(publicPath, keys.publicKey.export({ type: "spki", format: "pem" }), {
      mode: 0o600,
      flag: "wx",
    });
  }
  assertPrivateFile(privatePath, "ticket signing private key");
  assertPrivateFile(publicPath, "ticket signing public key");
}

function assertPrivateFile(filePath: string, label: string): void {
  const opened = lstatSync(filePath);
  if (!opened.isFile() || opened.isSymbolicLink())
    throw new Error(`${label} must be a regular file`);
  if ((opened.mode & 0o077) !== 0)
    throw new Error(`${label} must not be accessible by group or other`);
}

function parseListen(value: string): { readonly host: string; readonly port: number } {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) throw new Error("PASEO_MANAGEMENT_LISTEN must be host:port");
  const host = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PASEO_MANAGEMENT_LISTEN must be host:port");
  }
  return { host, port };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runManagementServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "management plane failed"}\n`);
    process.exitCode = 1;
  });
}
