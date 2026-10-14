import { describe, expect, it, vi } from "vitest";
import { MemoryConversationStore, SynthesisLimitError, type AgentTurn, type PcmAudio, type ParticipantReference, type VerifiedParticipant } from "../../packages/core/src/index.js";
import { cancelable, VoiceAssistant, type VoiceOptions } from "../../packages/voice/src/index.js";

const reference = { roomId: "!room:example.org", rtcSessionId: "m.call#ROOM", participantId: "speaker" };
const proof = { ...reference, userId: "@owner:example.org", deviceId: "DEVICE", expiresAtMs: 2000, deviceVerified: true, mediaEncrypted: true };
const pcm = (): PcmAudio => ({ samples: new Int16Array([100, 200, 300]), sampleRate: 16_000, channels: 1 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture(overrides: Partial<VoiceOptions> = {}) {
  const events: string[] = [];
  const store = new MemoryConversationStore(1);
  const verify = vi.fn(async (ref: ParticipantReference, _signal: AbortSignal): Promise<VerifiedParticipant> => { events.push("verify"); return { ...proof, ...ref }; });
  const transcribe = vi.fn(async (_audio: PcmAudio, _signal: AbortSignal) => { events.push("recognize"); return " Hello "; });
  const reply = vi.fn(async (_turn: AgentTurn) => { events.push("agent"); return { text: "Response" }; });
  const synthesize = vi.fn(async (_text: string, _signal: AbortSignal) => { events.push("synthesize"); return pcm(); });
  const publish = vi.fn(async (_audio: PcmAudio, _signal: AbortSignal) => { events.push("publish"); });
  const options: VoiceOptions = { policy: { owners: [proof.userId, "@other:example.org"], rooms: [reference.roomId], agents: ["assistant"] },
    agentId: "assistant", agent: { id: "portable", historyMode: "messages", reply }, store, verifier: { verify },
    recognition: { transcribe }, synthesis: { synthesize }, transport: { publish }, now: () => 1000, ...overrides };
  const assistant = new VoiceAssistant(options);
  return { assistant, options, store, verify, transcribe, reply, synthesize, publish, events };
}

describe("portable voice turns", () => {
  it("keeps one full agent response in history while subdividing only bounded synthesis", async () => {
    const f = fixture(); const text = "abcdefgh".repeat(25);
    f.reply.mockResolvedValueOnce({ text }); f.synthesize.mockRejectedValueOnce(new SynthesisLimitError());
    expect(await f.assistant.receive(reference, pcm())).toBe("replied");
    expect(f.reply).toHaveBeenCalledOnce(); expect(f.publish).toHaveBeenCalledTimes(5);
    const id = f.reply.mock.calls[0]![0].conversationId;
    expect((await f.store.get(id))!.messages.map((message) => message.text)).toEqual(["Hello", text]);
    await f.assistant.receive(reference, pcm());
    expect(f.reply.mock.calls[1]![0].messages.map((message) => message.text)).toEqual(["Hello", text, "Hello"]);
    await f.assistant.endSession();
  });

  it("closes failed model work without synthesis, retries or inherited authority on the next utterance", async () => {
    const f = fixture(); await f.assistant.receive(reference, pcm());
    const id = f.reply.mock.calls[0]![0].conversationId;
    f.reply.mockRejectedValueOnce(new Error("model-unavailable"));
    await expect(f.assistant.receive(reference, pcm())).rejects.toThrow("model-unavailable");
    expect(f.reply).toHaveBeenCalledTimes(2); expect(f.synthesize).toHaveBeenCalledOnce();
    expect((await f.store.get(id))!.status).toBe("closed");
    await f.assistant.receive(reference, pcm());
    expect(f.reply.mock.calls[2]![0].conversationId).not.toBe(id);
    expect(f.reply.mock.calls[2]![0].messages.length).toBe(1);
    await f.assistant.endSession();
  });

  it("does not generate another part after the original speaker's device changes", async () => {
    const f = fixture(); f.reply.mockResolvedValueOnce({ text: "x".repeat(128) });
    f.publish.mockImplementationOnce(async () => { f.verify.mockResolvedValueOnce({ ...proof, deviceId: "OTHER" }); });
    await expect(f.assistant.receive(reference, pcm())).rejects.toThrow("identity-mismatch");
    expect(f.synthesize).toHaveBeenCalledOnce(); expect(f.publish).toHaveBeenCalledOnce(); expect(f.assistant.busy).toBe(false);
    expect((await f.store.get(f.reply.mock.calls[0]![0].conversationId))!.status).toBe("closed");
  });

  it("cancels a long answer during playback without another synthesis or model dispatch", async () => {
    const f = fixture(); f.reply.mockResolvedValueOnce({ text: "x".repeat(128) });
    f.publish.mockImplementationOnce(async () => { await f.assistant.endSession(); });
    await expect(f.assistant.receive(reference, pcm())).rejects.toThrow("call-closed");
    expect(f.reply).toHaveBeenCalledOnce(); expect(f.synthesize).toHaveBeenCalledOnce(); expect(f.publish).toHaveBeenCalledOnce();
    expect(f.publish.mock.calls[0]![0].samples.every((sample) => sample === 0)).toBe(true);
  });
  it("verifies before speech and agent access and before publishing, while sharing call history", async () => {
    const f = fixture(); const input = pcm();
    expect(await f.assistant.receive(reference, input)).toBe("replied");
    expect(f.events).toEqual(["verify", "recognize", "verify", "verify", "agent", "verify", "synthesize", "verify", "publish"]);
    expect(f.reply.mock.calls[0]![0].caller).toEqual(proof);
    expect(f.reply.mock.calls[0]![0].messages.map((item) => item.text)).toEqual(["Hello"]);
    expect(f.synthesize).toHaveBeenCalledWith("Response", expect.any(AbortSignal));
    expect(input.samples).toEqual(pcm().samples);
    expect(f.transcribe.mock.calls[0]![0].samples).toEqual(new Int16Array(3));
    expect(f.publish.mock.calls[0]![0].samples).toEqual(new Int16Array(3));
    await f.assistant.receive(reference, pcm());
    expect(f.reply.mock.calls[1]![0].conversationId).toBe(f.reply.mock.calls[0]![0].conversationId);
    expect(f.reply.mock.calls[1]![0].messages.map((item) => item.text)).toEqual(["Hello", "Response", "Hello"]);
    await f.assistant.endSession(); await f.assistant.endSession();
    expect((await f.store.get(f.reply.mock.calls[0]![0].conversationId))!.status).toBe("closed");
    await f.assistant.receive(reference, pcm());
    expect(f.reply.mock.calls[2]![0].conversationId).not.toBe(f.reply.mock.calls[0]![0].conversationId);
    await f.assistant.endSession();
  });

  it("does not create an agent conversation for silence", async () => {
    const f = fixture(); f.transcribe.mockResolvedValueOnce("  ");
    expect(await f.assistant.receive(reference, pcm())).toBe("silence");
    expect(f.reply).not.toHaveBeenCalled(); expect(f.synthesize).not.toHaveBeenCalled();
    await f.assistant.endSession();
    expect(await f.assistant.receive(reference, pcm())).toBe("replied"); await f.assistant.endSession();
  });

  it.each([0, -1, 300001, 1.5, NaN])("rejects invalid deadlines %s", (timeoutMs) => {
    expect(() => fixture({ timeoutMs })).toThrow("invalid-input");
  });

  it("requires a configured logical agent and immutable policy", () => {
    expect(() => fixture({ agentId: "unlisted" })).toThrow("invalid-input");
    expect(() => fixture({ policy: { owners: [], rooms: [reference.roomId], agents: ["assistant"] } })).toThrow("invalid-input");
  });

  it("uses real clocks when no clock override is supplied", async () => {
    const f = fixture({ now: undefined } as unknown as Partial<VoiceOptions>);
    f.verify.mockImplementation(async (ref) => ({ ...proof, ...ref, expiresAtMs: Date.now() + 30000 }));
    expect(await f.assistant.receive(reference, pcm())).toBe("replied"); await f.assistant.endSession();
  });

  it.each([{ ...reference, participantId: "" }, { ...reference, owner: true }])("rejects invalid identity references %#", async (ref) => {
    const f = fixture(); await expect(f.assistant.receive(ref, pcm())).rejects.toThrow("invalid-input");
    expect(f.verify).not.toHaveBeenCalled();
  });

  it("rejects invalid rooms, PCM and competing call slots before recognizing speech", async () => {
    const f = fixture();
    await expect(f.assistant.receive({ ...reference, roomId: "!other:example.org" }, pcm())).rejects.toThrow("forbidden");
    await expect(f.assistant.receive(reference, { ...pcm(), samples: new Int16Array() })).rejects.toThrow("Invalid PCM");
    f.transcribe.mockResolvedValueOnce(""); await f.assistant.receive(reference, pcm());
    await expect(f.assistant.receive({ ...reference, rtcSessionId: "other" }, pcm())).rejects.toThrow("call-busy");
    expect(f.transcribe).toHaveBeenCalledOnce(); await f.assistant.endSession();
  });

  it.each([
    { userId: "@visitor:example.org" }, { expiresAtMs: 1000 }, { deviceVerified: false }, { mediaEncrypted: false },
  ])("does not send unauthorized audio to recognition %#", async (extra) => {
    const f = fixture(); f.verify.mockResolvedValueOnce({ ...proof, ...extra });
    await expect(f.assistant.receive(reference, pcm())).rejects.toThrow();
    expect(f.transcribe).not.toHaveBeenCalled(); expect(f.reply).not.toHaveBeenCalled();
    expect(f.assistant.busy).toBe(false);
  });

  it("rejects oversized or failed recognition without agent dispatch and allows a fresh call", async () => {
    const f = fixture(); f.transcribe.mockResolvedValueOnce("x".repeat(16001));
    await expect(f.assistant.receive(reference, pcm())).rejects.toThrow("invalid-input");
    f.transcribe.mockRejectedValueOnce(new Error("speech unavailable"));
    await expect(f.assistant.receive(reference, pcm())).rejects.toThrow("speech unavailable");
    expect(f.reply).not.toHaveBeenCalled();
    expect(await f.assistant.receive(reference, pcm())).toBe("replied"); await f.assistant.endSession();
  });

  it.each([{ userId: "@other:example.org" }, { deviceId: "OTHER" }])("pins caller identity across STT and agent dispatch %#", async (extra) => {
    const f = fixture(); f.verify.mockResolvedValueOnce(proof).mockResolvedValueOnce({ ...proof, ...extra });
    await expect(f.assistant.receive(reference, pcm())).rejects.toThrow("identity-mismatch");
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("rechecks authority after synthesis and discards audio if the speaker changes", async () => {
    const f = fixture();
    f.verify.mockResolvedValueOnce(proof).mockResolvedValueOnce(proof).mockResolvedValueOnce(proof).mockResolvedValueOnce(proof)
      .mockResolvedValueOnce({ ...proof, deviceId: "OTHER" });
    await expect(f.assistant.receive(reference, pcm())).rejects.toThrow("identity-mismatch");
    expect(f.synthesize).toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
    expect((await f.store.get(f.reply.mock.calls[0]![0].conversationId))!.status).toBe("closed");
  });

  it.each(["agent", "synthesis", "publication"])("closes the conversation after %s failure", async (stage) => {
    const f = fixture();
    if (stage === "agent") f.reply.mockRejectedValueOnce(new Error(stage));
    else if (stage === "synthesis") f.synthesize.mockResolvedValueOnce({ ...pcm(), samples: new Int16Array() });
    else f.publish.mockRejectedValueOnce(new Error(stage));
    await expect(f.assistant.receive(reference, pcm())).rejects.toThrow();
    expect((await f.store.get(f.reply.mock.calls[0]![0].conversationId))!.status).toBe("closed");
    expect(await f.assistant.receive(reference, pcm())).toBe("replied"); await f.assistant.endSession();
  });

  it("drops overlapping input without an unbounded queue and copies caller-owned PCM", async () => {
    const f = fixture(); const gate = deferred<string>(); f.transcribe.mockReturnValueOnce(gate.promise);
    const input = pcm(); const pending = f.assistant.receive(reference, input);
    await vi.waitFor(() => expect(f.transcribe).toHaveBeenCalled());
    expect(f.assistant.busy).toBe(true); input.samples.fill(9);
    expect(f.transcribe.mock.calls[0]![0].samples[0]).toBe(100);
    expect(await f.assistant.receive(reference, pcm())).toBe("busy");
    gate.resolve("Hello"); await pending; await f.assistant.endSession();
  });

  it.each(["verification", "recognition", "agent", "synthesis", "publication"])
    ("cancels stalled %s and ignores late output even from an uncooperative port", async (stage) => {
      const f = fixture(); const gate = deferred<unknown>();
      if (stage === "verification") f.verify.mockReturnValueOnce(gate.promise as Promise<VerifiedParticipant>);
      else if (stage === "recognition") f.transcribe.mockReturnValueOnce(gate.promise as Promise<string>);
      else if (stage === "agent") f.reply.mockReturnValueOnce(gate.promise as Promise<{ text: string }>);
      else if (stage === "synthesis") f.synthesize.mockReturnValueOnce(gate.promise as Promise<PcmAudio>);
      else f.publish.mockReturnValueOnce(gate.promise as Promise<void>);
      const pending = f.assistant.receive(reference, pcm()); const assertion = expect(pending).rejects.toThrow("call-closed");
      const port = stage === "verification" ? f.verify : stage === "recognition" ? f.transcribe : stage === "agent" ? f.reply : stage === "synthesis" ? f.synthesize : f.publish;
      await vi.waitFor(() => expect(port).toHaveBeenCalled());
      await f.assistant.endSession(); await assertion;
      gate.resolve(stage === "verification" ? proof : stage === "recognition" ? "Late" : stage === "agent" ? { text: "Late" } : pcm());
      await Promise.resolve();
      if (stage !== "publication") expect(f.publish).not.toHaveBeenCalled();
      expect(f.assistant.busy).toBe(false);
    });

  it("cancels call opening without leaving persisted authority or an active reservation", async () => {
    const f = fixture(); const gate = deferred<VerifiedParticipant>();
    f.verify.mockResolvedValueOnce(proof).mockReturnValueOnce(gate.promise);
    const pending = f.assistant.receive(reference, pcm()); const assertion = expect(pending).rejects.toThrow("call-closed");
    await vi.waitFor(() => expect(f.verify).toHaveBeenCalledTimes(2));
    await f.assistant.endSession(); await assertion; gate.resolve(proof);
    await vi.waitFor(async () => expect(await f.assistant.receive(reference, pcm())).toBe("replied"));
    await f.assistant.endSession();
  });

  it("closes a call canceled between coordinator opening and voice ownership", async () => {
    const storage = new MemoryConversationStore(); let id = "";
    const f = fixture({ store: { get: (key) => storage.get(key), async put(record) {
      await storage.put(record); id = record.id;
      if (record.status === "active" && record.messages.length === 0) {
        queueMicrotask(() => queueMicrotask(() => { void f.assistant.endSession(); }));
      }
    } } });
    await expect(f.assistant.receive(reference, pcm())).rejects.toThrow("call-closed");
    await vi.waitFor(async () => expect((await storage.get(id))!.status).toBe("closed"));
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("keeps closure serialized and drops audio while storage cleanup is pending", async () => {
    const storage = new MemoryConversationStore(); const gate = deferred<void>();
    const f = fixture({ store: { get: (id) => storage.get(id), async put(record) {
      if (record.status === "closed") await gate.promise;
      await storage.put(record);
    } } });
    await f.assistant.receive(reference, pcm());
    const first = f.assistant.endSession(); expect(f.assistant.endSession()).toBe(first);
    expect(await f.assistant.receive(reference, pcm())).toBe("busy");
    gate.resolve(); await first; expect(f.assistant.busy).toBe(false);
  });

  it("enforces a total turn deadline without waiting for stalled recognition", async () => {
    const f = fixture({ timeoutMs: 15 }); f.transcribe.mockReturnValueOnce(new Promise(() => {}));
    await expect(f.assistant.receive(reference, pcm())).rejects.toThrow("operation was aborted due to timeout");
    expect(f.reply).not.toHaveBeenCalled(); expect(f.assistant.busy).toBe(false);
  });

  it("handles cancellation before waiting without unhandled operation rejection", async () => {
    const signal = AbortSignal.abort(new Error("closed"));
    await expect(cancelable(Promise.reject(new Error("late")), signal)).rejects.toThrow("closed");
    expect(await cancelable(Promise.resolve(1), new AbortController().signal)).toBe(1);
  });
});
