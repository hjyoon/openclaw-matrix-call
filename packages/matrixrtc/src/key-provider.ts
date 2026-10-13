import { BaseKeyProvider } from "livekit-client";

export class MatrixMediaKeyProvider extends BaseKeyProvider {
  constructor() {
    super({
      sharedKey: false,
      ratchetWindowSize: 0,
      failureTolerance: 0,
      keyringSize: 256,
      keySize: 128,
    });
  }

  async install(
    participantIdentity: string,
    bytes: Uint8Array<ArrayBuffer>,
    index: number,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    if (
      !/^\S{1,1024}$/.test(participantIdentity) ||
      !(bytes instanceof Uint8Array) || bytes.byteLength !== 16 ||
      !Number.isInteger(index) || index < 0 || index > 255
    ) {
      throw new Error("Invalid MatrixRTC media key");
    }
    const material = await crypto.subtle.importKey("raw", bytes.slice(), "HKDF", false, ["deriveBits", "deriveKey"]);
    if (!isCurrent()) return false;
    this.onSetEncryptionKey(material, participantIdentity, index);
    return true;
  }
}
