import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { z } from "zod";
import { CallError, policySchema } from "@matrix-call/core";

const accountSchema = z.strictObject({
  enabled: z.boolean().default(false),
  policy: policySchema.optional(),
}).refine((account) => !account.enabled || account.policy !== undefined).readonly();

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
    blurb: "Portable Matrix calling adapters; RTC audio is not available yet",
  },
  capabilities: { chatTypes: ["group"], media: false, nativeCommands: false },
  configSchema: { schema: z.toJSONSchema(accountSchema, { unrepresentable: "any" }) },
  config: {
    listAccountIds: () => ["default"],
    defaultAccountId: () => "default",
    resolveAccount,
    isEnabled: (account) => account.enabled,
    isConfigured: () => false,
    unconfiguredReason: () => "RTC transport is not implemented in this development version",
    resolveAllowFrom: ({ cfg }) => resolveAccount(cfg).policy?.owners.slice() ?? [],
  },
};
