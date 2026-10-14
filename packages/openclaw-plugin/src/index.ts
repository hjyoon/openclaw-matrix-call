import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { matrixCallChannel } from "./channel.js";
import { createNativeAgentService } from "./service.js";
import { createNativeWorkerControl, NativeControlError, nativeControlErrorCode } from "./control.js";

export { OpenClawAgentAdapter } from "./agent.js";
export { matrixCallChannel } from "./channel.js";

export default defineChannelPluginEntry({
  id: "matrix-call",
  name: "Matrix Call",
  description: "Experimental portable Matrix calling integration",
  plugin: matrixCallChannel,
  registerFull(api) {
    const control = createNativeWorkerControl(api);
    api.registerCommand({
      name: "matrixcall",
      description: "Control configured Matrix Call worker media",
      acceptsArgs: true,
      requireAuth: true,
      channels: ["matrix"],
      handler: control.command,
    });
    if (api.registrationMode === "full") {
      api.registerService(createNativeAgentService(api));
      api.registerService(control.service);
      api.registerGatewayMethod("matrixcall.control", async ({ params, respond, signal, hasCurrentClientAuthority }) => {
        const assertAuthorized = () => { if (!hasCurrentClientAuthority?.()) throw new NativeControlError("forbidden"); };
        try {
          const result = await control.execute(params, assertAuthorized, signal);
          assertAuthorized();
          respond(true, result);
        } catch (error) {
          const code = nativeControlErrorCode(error);
          respond(false, undefined, { code: "UNAVAILABLE", message: `Matrix Call control unavailable: ${code}` });
        }
      }, { scope: "operator.admin", profileAccess: "independent" });
    }
  },
});
