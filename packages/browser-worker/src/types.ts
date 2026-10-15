export type DeviceKeys = Readonly<{ ed25519: string; curve25519: string }>;

export type DevicePin = DeviceKeys & Readonly<{ userId: string; deviceId: string }>;

export type BrowserDial = Readonly<{ recipientId: string; ringTimeoutMs: number }>;

export type MatrixCredentials = Readonly<{
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
}>;

export type BrowserPolicy = Readonly<{
  owners: readonly string[];
  rooms: readonly string[];
  focusUrls: readonly string[];
  sfuUrls: readonly string[];
  roomAliasFormat?: "json-array" | "legacy-pipe";
  devices: readonly DevicePin[];
  allowInsecureLoopback: boolean;
}>;

export type BrowserSetup = Readonly<{
  credentials: MatrixCredentials;
  policy: BrowserPolicy;
  expectedKeys: DeviceKeys | undefined;
  captureAudio?: boolean;
}>;
