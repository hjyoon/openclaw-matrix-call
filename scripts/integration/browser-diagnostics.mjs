import { writeFile } from "node:fs/promises";
import path from "node:path";
import { installCaptureProbe } from "../../tests/integration/capture-probe.js";

function installRuntimeProbe() {
  let factory;
  Object.defineProperty(window, "createMatrixCall", {
    configurable: true, get: () => factory,
    set(original) {
      factory = (...args) => {
        const runtime = original(...args);
        const state = { polls: 0, inputs: 0, resumes: 0, publications: 0, finished: 0, publishing: false, failure: false };
        window.matrixRuntimeProbe = state;
        const take = runtime.takeAudio.bind(runtime); const resume = runtime.resumeAudio.bind(runtime); const publish = runtime.publish.bind(runtime);
        runtime.takeAudio = () => { state.polls++; const audio = take(); if (audio) state.inputs++; return audio; };
        runtime.resumeAudio = () => { resume(); state.resumes++; };
        runtime.publish = async (...values) => {
          state.publications++; state.publishing = true;
          try { await publish(...values); state.finished++; }
          catch (error) { state.failure = true; throw error; }
          finally { state.publishing = false; }
        };
        return runtime;
      };
    },
  });
}

export async function writeBrowserDiagnostics(directory) {
  const file = path.join(directory, "browser-diagnostics.mjs");
  const source = `import { chromium } from "/app/node_modules/playwright-core/index.mjs";
import { writeFile, rename } from "node:fs/promises";
const launch = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (...args) => {
  const context = await launch(...args);
  await context.addInitScript(${installCaptureProbe.toString()});
  await context.addInitScript(${installRuntimeProbe.toString()});
  context.on("page", (page) => {
    let pending = false;
    const timer = setInterval(async () => {
      if (pending) return; pending = true;
      try {
        const state = await page.evaluate(() => ({ connected: window.matrixCall?.status().connected ?? false,
          runtime: window.matrixRuntimeProbe ?? null, capture: window.matrixCaptureProbe }));
        await writeFile("/data/browser-diagnostics.json.tmp", JSON.stringify(state), { mode: 0o600 });
        await rename("/data/browser-diagnostics.json.tmp", "/data/browser-diagnostics.json");
      } catch {} finally { pending = false; }
    }, 500);
    timer.unref(); page.on("close", () => clearInterval(timer));
  });
  return context;
};
`;
  await writeFile(file, source, { mode: 0o600 });
  return "/data/browser-diagnostics.mjs";
}
