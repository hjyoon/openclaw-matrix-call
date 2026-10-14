import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

export async function provisionMatrixChat({ api, homeserver, registrationSecret, roomId, creator, owner, peer, chatPeer, username }) {
  const client = chatPeer ?? {
    trust: (value) => peer.evaluate(({ userId, deviceId, keys }) => window.matrixTest.trust(userId, deviceId, keys), value),
    replies: (value) => peer.evaluate(({ roomId, botId }) => window.matrixTest.commandReplies(roomId, botId), value),
    send: (value) => peer.evaluate(({ roomId, text, botId }) => window.matrixTest.sendCommand(roomId, text, botId), value),
  };
  const endpoint = `${homeserver}/_synapse/admin/v1/register`;
  const { nonce } = await api(endpoint, "GET");
  const password = randomBytes(32).toString("hex");
  const mac = createHmac("sha1", registrationSecret).update([nonce, username, password, "notadmin"].join("\0")).digest("hex");
  const account = await api(endpoint, "POST", { nonce, username, password, admin: false, mac });
  const identity = await api(`${homeserver}/_matrix/client/v3/account/whoami`, "GET", undefined, account.access_token);
  assert.equal(identity.user_id, account.user_id); assert.equal(identity.device_id, account.device_id);
  await api(`${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, "POST", { user_id: account.user_id }, creator.accessToken);
  await api(`${homeserver}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, "POST", {}, account.access_token);
  const seen = new Set();
  const evidence = { commands: 0, replies: 0, encryptedCommands: 0, encryptedReplies: 0 };
  const config = {
    enabled: true, homeserver, accessToken: account.access_token, userId: account.user_id, deviceId: account.device_id,
    encryption: true, startupVerification: "off", network: { dangerouslyAllowPrivateNetwork: true },
    autoJoin: "off", joinIntro: false, dm: { policy: "disabled", sessionScope: "per-room" },
    groupPolicy: "allowlist", groupAllowFrom: [owner.userId], groups: { [roomId]: { requireMention: false, users: [owner.userId] } }, threadReplies: "off",
  };
  return {
    config, evidence,
    async prepare(waitFor) {
      await waitFor(async () => {
        const response = await api(`${homeserver}/_matrix/client/v3/keys/query`, "POST", { device_keys: { [account.user_id]: [account.device_id] } }, owner.accessToken);
        const device = response.device_keys?.[account.user_id]?.[account.device_id];
        if (!device) return false;
        assert.equal(device.user_id, account.user_id); assert.equal(device.device_id, account.device_id);
        const keys = { ed25519: device.keys[`ed25519:${account.device_id}`], curve25519: device.keys[`curve25519:${account.device_id}`] };
        return client.trust({ userId: account.user_id, deviceId: account.device_id, keys });
      }, "published encrypted messaging device", 30_000);
      for (const event of await client.replies({ roomId, botId: account.user_id })) seen.add(event.id);
    },
    async request(pathname, value, waitFor) {
      const operation = pathname.split("/").at(-1);
      assert(["status", "join", "leave"].includes(operation));
      const text = `/matrixcall ${operation}${operation === "join" ? " " + value.roomId : operation === "leave" ? " " + value.sessionId : ""}`;
      const sent = await client.send({ roomId, text, botId: account.user_id });
      evidence.commands++;
      const wire = await api(`${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(sent.event_id)}`, "GET", undefined, owner.accessToken);
      assert.equal(wire.sender, owner.userId); assert.equal(wire.type, "m.room.encrypted"); assert.equal(wire.content.algorithm, "m.megolm.v1.aes-sha2");
      assert.equal(wire.content.body, undefined); evidence.encryptedCommands++;
      let reply;
      await waitFor(async () => {
        const replies = (await client.replies({ roomId, botId: account.user_id })).filter((event) => !seen.has(event.id));
        if (!replies.length) return false;
        assert.equal(replies.length, 1); reply = replies[0]; seen.add(reply.id); return true;
      }, `encrypted Matrix ${operation} reply`, 70_000);
      assert.equal(reply.type, "m.room.encrypted"); assert.equal(reply.algorithm, "m.megolm.v1.aes-sha2");
      evidence.replies++; evidence.encryptedReplies++;
      const prefix = "Matrix Call control unavailable: ";
      if (reply.text.startsWith(prefix)) {
        const error = reply.text.slice(prefix.length); const status = { forbidden: 403, "invalid-request": 400, "not-found": 404, busy: 409 }[error];
        assert(status, "Unexpected encrypted control error"); return { status, value: { error } };
      }
      assert(reply.text.startsWith("Matrix Call media control: "));
      return { status: 200, value: JSON.parse(reply.text.slice("Matrix Call media control: ".length).split(". Assistant readiness")[0]) };
    },
  };
}
