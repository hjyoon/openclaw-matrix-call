export const request = {
  protocolVersion: 1 as const,
  conversationId: "b45c5d9c-4e72-47df-b945-bde05545dbe8",
  turnId: "58c385e3-b601-4a6e-9d9f-9b2156c4f109",
  agentId: "assistant",
  caller: {
    roomId: "!room:example.org", rtcSessionId: "rtc-1", participantId: "participant-1",
    userId: "@owner:example.org", deviceId: "DEVICE", expiresAtMs: 2_000,
    deviceVerified: true, mediaEncrypted: true,
  },
  messages: [{ role: "user" as const, text: "Hello", senderId: "@owner:example.org", timestampMs: 1_000 }],
};
