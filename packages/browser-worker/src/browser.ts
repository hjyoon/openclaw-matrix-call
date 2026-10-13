import { BrowserMatrixRuntime } from "./runtime.js";
import type { BrowserSetup } from "./types.js";

declare global {
  interface Window {
    createMatrixCall: (setup: BrowserSetup) => BrowserMatrixRuntime;
    matrixCall: BrowserMatrixRuntime;
  }
}

window.createMatrixCall = (setup: BrowserSetup) => new BrowserMatrixRuntime(setup);
