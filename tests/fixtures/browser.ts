export const credentials = { baseUrl: "https://matrix.example.org", userId: "@bot:example.org", deviceId: "CALL-BOT", accessToken: "private-token" };
export const configuration = {
  credentialsFile: "/run/secrets/matrix.json", profileDir: "/data/profile", assetDir: "/app/assets",
  owners: ["@owner:example.org"], rooms: ["!room"],
  focusUrls: ["https://focus.example.org"], sfuUrls: ["wss://sfu.example.org"],
  devices: [{ userId: "@owner:example.org", deviceId: "OWNER", ed25519: "A".repeat(43), curve25519: "B".repeat(43) }],
};
