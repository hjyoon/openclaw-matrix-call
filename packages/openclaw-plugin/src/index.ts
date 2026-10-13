import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { matrixCallChannel } from "./channel.js";

export { OpenClawAgentAdapter } from "./agent.js";
export { matrixCallChannel } from "./channel.js";

export default defineChannelPluginEntry({
  id: "matrix-call",
  name: "Matrix Call",
  description: "Experimental portable Matrix calling integration",
  plugin: matrixCallChannel,
  registerFull(api) {
    api.registerCommand({
      name: "matrixcall",
      description: "Show Matrix Call implementation status",
      acceptsArgs: false,
      requireAuth: true,
      handler: () => ({ text: "Matrix Call is experimental. The standalone worker has encrypted MatrixRTC audio; native call wiring and model-backed dispatch are unavailable." }),
    });
  },
});
