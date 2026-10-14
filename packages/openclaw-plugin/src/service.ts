import { once } from "node:events";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createLoggerBackedRuntime } from "openclaw/plugin-sdk/runtime";
import { readSecretFileSync } from "openclaw/plugin-sdk/secret-file";
import { createAgentServer } from "@matrix-call/agent-http";
import { OpenClawAgentAdapter } from "./agent.js";
import { matrixCallChannel } from "./channel.js";

export function createNativeAgentService(api: Pick<OpenClawPluginApi, "runtime" | "lifecycle">): OpenClawPluginService {
  let worker: ReturnType<typeof createAgentServer> | undefined;
  let transition = Promise.resolve();
  const close = async (): Promise<void> => {
    if (!worker) return;
    await worker.close();
    worker = undefined;
  };
  const schedule = (operation: () => Promise<void>): Promise<void> => {
    const result = transition.then(operation);
    transition = result.catch(() => {});
    return result;
  };
  return {
    id: "matrix-call-agent",
    reload: { configPrefixes: ["channels.matrix-call"] },
    start: (context) => schedule(async () => {
      await close();
      let phase = "configuration";
      try {
        const account = matrixCallChannel.config.resolveAccount(context.config);
        if (!account.enabled || !account.agentService) return;
        const settings = account.agentService;
        phase = "credentials";
        const secret = readSecretFileSync(settings.secretFile, "Matrix Call agent secret", { maxBytes: 65, rejectSymlink: true });
        if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("Invalid agent credential");
        phase = "runtime";
        const background = api.lifecycle.runInBackgroundContext;
        if (!background) throw new Error("Managed plugin background context unavailable");
        const adapter = new OpenClawAgentAdapter({
          runtime: api.runtime, policy: account.policy!,
          commandRuntime: createLoggerBackedRuntime({ logger: {
            info: () => {},
            error: () => { context.logger.error("Matrix Call agent command failed"); },
          } }),
        });
        phase = "listener";
        await background(async () => {
          worker = createAgentServer({ secret, policy: account.policy!, timeoutMs: settings.timeoutMs, agent: {
            id: adapter.id, historyMode: adapter.historyMode,
            reply: (turn) => background(() => adapter.reply(turn)),
          } });
          const listening = once(worker.server, "listening");
          worker.server.listen(settings.port, settings.host);
          await listening;
        });
        context.logger.info("Matrix Call agent service started with delegated, tool-free ingress");
      } catch {
        await close();
        throw new Error(`Matrix Call agent service could not start (${phase})`);
      }
    }),
    stop: () => schedule(close),
  };
}
