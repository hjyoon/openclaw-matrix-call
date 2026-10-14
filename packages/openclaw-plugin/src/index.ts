import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { matrixCallChannel } from "./channel.js";
import { createNativeAgentService } from "./service.js";

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
      handler: () => ({ text: "Matrix Call is experimental. An optional signed agent service provides delegated, tool-free ingress. Worker control and native call entry remain unavailable." }),
    });
    if (api.registrationMode === "full") api.registerService(createNativeAgentService(api));
  },
});
