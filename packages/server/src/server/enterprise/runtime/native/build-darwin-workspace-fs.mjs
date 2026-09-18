import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const source = fileURLToPath(new URL("./darwin-workspace-fs.c", import.meta.url));
const defaultOutput = fileURLToPath(
  new URL(
    "../../../../../dist/server/server/enterprise/runtime/native/darwin-workspace-fs.node",
    import.meta.url,
  ),
);

function readOutputArgument(argv) {
  const outputIndex = argv.indexOf("--output");
  if (outputIndex === -1) return defaultOutput;
  const output = argv[outputIndex + 1];
  if (!output) throw new Error("--output requires a path");
  return path.resolve(output);
}

function readVariantArguments(argv) {
  const variantIndex = argv.indexOf("--test-variant");
  if (variantIndex === -1) return [];
  const variant = argv[variantIndex + 1];
  if (variant === "wrong-abi") return ["-DWORKSPACE_ABI_VERSION=1"];
  if (variant === "missing-symbol") return ["-DWORKSPACE_OMIT_STAT_AT=1"];
  if (variant === "missing-upload-symbols") return ["-DWORKSPACE_OMIT_UPLOAD_CLOSE=1"];
  if (variant === "sparse-directory") return ["-DWORKSPACE_SPARSE_DIRECTORY=1"];
  throw new Error("unsupported Darwin workspace test variant");
}

if (process.platform !== "darwin") {
  process.stdout.write("darwin workspace native build skipped on non-Darwin host\n");
  process.exit(0);
}

const output = readOutputArgument(process.argv.slice(2));
const variantArguments = readVariantArguments(process.argv.slice(2));
const nodeInclude = path.resolve(path.dirname(process.execPath), "..", "include", "node");
const { stdout: sdkOutput } = await executeFile("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
const sdkPath = sdkOutput.trim();
await access(path.join(nodeInclude, "node_api.h"));
await access(sdkPath);
await mkdir(path.dirname(output), { recursive: true });

const arguments_ = [
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-arch",
  "arm64",
  "-arch",
  "x86_64",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-std=c11",
  "-DNAPI_VERSION=10",
  "-DNODE_GYP_MODULE_NAME=darwin_workspace_fs",
  ...variantArguments,
  `-I${nodeInclude}`,
  "-isysroot",
  sdkPath,
  "-o",
  output,
  source,
];

await executeFile("xcrun", ["--sdk", "macosx", "clang", ...arguments_], {
  maxBuffer: 1024 * 1024,
});
process.stdout.write(`${output}\n`);
