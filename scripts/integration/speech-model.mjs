import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

export async function prepareSpeechModel(root, name = "base") {
  const pins = JSON.parse(await readFile(path.join(root, "deployment/speech-engines.json"), "utf8"));
  assert(Object.hasOwn(pins.models, name), "Unknown pinned speech model");
  const pin = pins.models[name];
  const directory = path.join(root, ".cache/speech");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `ggml-${name}.bin`);
  const model = { file, bytes: pin.bytes, sha256: pin.sha256 };
  const { verifySpeechModel } = await import(pathToFileURL(path.join(root, "dist/speech-worker/index.js")));
  try { await verifySpeechModel(model); return model; } catch {}
  const temporary = path.join(directory, `download-${randomUUID()}.bin`);
  const output = await open(temporary, "wx", 0o600);
  try {
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(300_000) });
    assert(response.ok && response.body, "Speech model download unavailable");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of Readable.fromWeb(response.body)) {
      bytes += chunk.length;
      assert(bytes <= pin.bytes, "Speech model download exceeds its pinned size");
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    assert.equal(bytes, pin.bytes);
    assert.equal(hash.digest("hex"), pin.sha256);
    await output.chmod(0o444);
    await output.close();
    await rename(temporary, file);
    await verifySpeechModel(model);
    return model;
  } finally { await output.close(); await rm(temporary, { force: true }); }
}
