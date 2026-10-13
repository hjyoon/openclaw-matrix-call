export type CallPolicy = Readonly<{
  owners: readonly string[];
  rooms: readonly string[];
  agents: readonly string[];
}>;

export type ParticipantReference = Readonly<{
  roomId: string;
  rtcSessionId: string;
  participantId: string;
}>;

export type VerifiedParticipant = ParticipantReference &
  Readonly<{
    userId: string;
    deviceId: string;
    expiresAtMs: number;
    deviceVerified: boolean;
    mediaEncrypted: boolean;
  }>;

export interface ParticipantVerifier {
  verify(reference: ParticipantReference, signal: AbortSignal): Promise<VerifiedParticipant>;
}

export type ConversationMessage = Readonly<{
  role: "user" | "assistant";
  text: string;
  senderId: string;
  timestampMs: number;
}>;

export type ConversationRecord = Readonly<{
  schemaVersion: 1;
  id: string;
  roomId: string;
  rtcSessionId: string;
  agentId: string;
  createdAtMs: number;
  status: "active" | "closed";
  messages: readonly ConversationMessage[];
}>;

export interface ConversationStore {
  put(record: ConversationRecord): Promise<void>;
  get(id: string): Promise<ConversationRecord | undefined>;
}

export type AgentTurn = Readonly<{
  protocolVersion: 1;
  conversationId: string;
  turnId: string;
  agentId: string;
  caller: VerifiedParticipant;
  messages: readonly ConversationMessage[];
  signal: AbortSignal;
}>;

export type AgentReply = Readonly<{ text: string }>;

export interface AgentPort {
  readonly id: string;
  readonly historyMode: "messages" | "host-session";
  reply(turn: AgentTurn): Promise<AgentReply>;
}

export type PcmAudio = Readonly<{
  samples: Int16Array;
  sampleRate: number;
  channels: 1;
}>;

export interface SpeechRecognitionPort {
  transcribe(audio: PcmAudio, signal: AbortSignal): Promise<string>;
}

export interface SpeechSynthesisPort {
  synthesize(text: string, signal: AbortSignal): Promise<PcmAudio>;
}

export interface RtcTransportPort {
  connect(roomId: string, signal: AbortSignal): Promise<void>;
  publish(audio: PcmAudio, signal: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
}
