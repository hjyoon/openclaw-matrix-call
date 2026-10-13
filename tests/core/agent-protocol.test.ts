import { describe, expect, it } from "vitest";
import { CallError, parseAgentRequest } from "../../packages/core/src/index.js";
import { request } from "../fixtures/agent.js";

describe("portable agent protocol", () => {
  it("validates and freezes a request without provider-specific fields", () => {
    const parsed = parseAgentRequest(request);
    expect(parsed).toEqual(request);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.caller)).toBe(true);
    expect(Object.isFrozen(parsed.messages[0])).toBe(true);
  });

  it.each([
    null,
    { ...request, protocolVersion: 2 },
    { ...request, conversationId: "agent:main:session" },
    { ...request, messages: [] },
    { ...request, caller: { ...request.caller, owner: true } },
    { ...request, gatewayToken: "operator-secret" },
  ])("rejects invalid or unsupported requests %#", (value) => {
    expect(() => parseAgentRequest(value)).toThrowError(new CallError("invalid-input"));
  });
});
