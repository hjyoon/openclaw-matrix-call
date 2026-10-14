import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const { matrixCallChannel } = await import(pathToFileURL(path.join(root, "packages/openclaw-plugin/dist/index.js")));
const filename = path.join(root, "packages/openclaw-plugin/openclaw.plugin.json");
const manifest = JSON.parse(await readFile(filename, "utf8"));
manifest.channelConfigs = {
  "matrix-call": {
    schema: matrixCallChannel.configSchema.schema,
    label: "Matrix Call",
    description: "Experimental Matrix calling policy and authenticated media control",
    commands: { nativeCommandsAutoEnabled: false, nativeSkillsAutoEnabled: false },
  },
};
await writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`);
