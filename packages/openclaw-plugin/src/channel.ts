import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { z } from "zod";
import { isAbsolute } from "node:path";
import { CallError, policySchema } from "@matrix-call/core";

const accountSchema = z.strictObject({
  enabled: z.boolean().default(false),
  policy: policySchema.optional(),
  selfCalls: z.boolean().default(false),
  thirdPartyCalls: z.boolean().default(false),
  agentService: z.strictObject({
    secretFile: z.string().min(1).max(4096).refine(isAbsolute),
    host: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(19793),
    timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  }).readonly().optional(),
  workerControl: z.strictObject({
    baseUrl: z.string().url().max(4096),
    secretFile: z.string().min(1).max(4096).refine(isAbsolute),
    timeoutMs: z.number().int().min(1).max(300_000).default(35_000),
    allowInsecureLoopback: z.boolean().default(false),
  }).readonly().optional(),
}).refine((account) => (!account.enabled || account.policy !== undefined) && (!account.thirdPartyCalls || account.selfCalls)).readonly();

type MatrixCallAccount = z.infer<typeof accountSchema> & { accountId: "default" };

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): MatrixCallAccount {
  if (accountId && accountId !== "default") throw new CallError("invalid-input");
  const parsed = accountSchema.safeParse(cfg.channels?.["matrix-call"] ?? {});
  if (!parsed.success) throw new CallError("invalid-input");
  return Object.freeze({ accountId: "default", ...parsed.data });
}

export const matrixCallChannel: ChannelPlugin<MatrixCallAccount> = {
  id: "matrix-call",
  meta: {
    id: "matrix-call",
    label: "Matrix Call",
    selectionLabel: "Matrix Call (experimental)",
    docsPath: "https://github.com/hjyoon/openclaw-matrix-call/blob/main/docs/implementation-status.md",
    blurb: "Experimental MatrixRTC media control and delegated agent service",
  },
  capabilities: { chatTypes: ["group"], media: false, nativeCommands: false },
  configSchema: { schema: {
    ...z.toJSONSchema(accountSchema, { unrepresentable: "any", io: "input" }),
    allOf: [{
      if: { required: ["enabled"], properties: { enabled: { const: true } } },
      then: { required: ["policy"] },
    }, {
      if: { required: ["thirdPartyCalls"], properties: { thirdPartyCalls: { const: true } } },
      then: { required: ["selfCalls"], properties: { selfCalls: { const: true } } },
    }],
  } },
  config: {
    listAccountIds: () => ["default"],
    defaultAccountId: () => "default",
    resolveAccount,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => Boolean(account.enabled && account.policy && account.agentService && account.workerControl),
    unconfiguredReason: () => "Configure an enabled policy, agent service and worker control",
    resolveAllowFrom: ({ cfg }) => resolveAccount(cfg).policy?.owners.slice() ?? [],
  },
};
