import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

export async function buildBrowserAssets(root, output) {
  await mkdir(output, { recursive: true });
  const result = await build({ absWorkingDir: root, entryPoints: ["packages/browser-worker/src/browser.ts"], outfile: path.join(output, "browser.js"), bundle: true, platform: "browser", format: "esm", target: "es2023", metafile: true, legalComments: "none", logLevel: "warning" });
  const require = createRequire(path.join(root, "package.json"));
  const matrixRequire = createRequire(require.resolve("matrix-js-sdk"));
  const wasmPackage = path.dirname(matrixRequire.resolve("@matrix-org/matrix-sdk-crypto-wasm"));
  await cp(path.join(wasmPackage, "pkg/matrix_sdk_crypto_wasm_bg.wasm"), path.join(output, "matrix_sdk_crypto_wasm_bg.wasm"));
  await cp(require.resolve("livekit-client/e2ee-worker"), path.join(output, "e2ee-worker.js"));
  return result.metafile;
}

export async function copyBrowserLicenses(root, output, metadata) {
  await mkdir(output, { recursive: true });
  const require = createRequire(path.join(root, "package.json"));
  const files = [...Object.keys(metadata.inputs).filter((file) => file.includes("node_modules/")), require.resolve("playwright-core")];
  const packages = new Map();
  for (const file of files) {
    let dir = path.dirname(path.resolve(root, file));
    while (dir !== path.dirname(dir)) {
      let pkg;
      try { pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")); } catch {}
      if (pkg?.name && pkg.version) { packages.set(`${pkg.name}@${pkg.version}`, { dir, pkg }); break; }
      dir = path.dirname(dir);
    }
  }
  const index = [];
  for (const [id, { dir, pkg }] of [...packages].sort()) {
    const destination = path.join(output, encodeURIComponent(id));
    await mkdir(destination, { recursive: true });
    const files = (await readdir(dir)).filter((file) => /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(file));
    if (!pkg.license || files.length === 0) throw new Error(`Missing third-party license: ${id}`);
    for (const file of files) await cp(path.join(dir, file), path.join(destination, file));
    index.push({ name: pkg.name, version: pkg.version, license: pkg.license, files: files.map((file) => `${encodeURIComponent(id)}/${file}`) });
  }
  await writeFile(path.join(output, "index.json"), JSON.stringify(index, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const metadata = await buildBrowserAssets(root, path.join(root, "assets"));
  await copyBrowserLicenses(root, path.join(root, "licenses"), metadata);
}
