import { BaseKeyProvider } from "livekit-client";

export class MatrixMediaKeyProvider extends BaseKeyProvider {
  #localIdentity: string | undefined;
  readonly #latestIndices = new Map<string, number>();
  constructor() {
    super({
      sharedKey: false,
      ratchetWindowSize: 0,
      failureTolerance: 0,
      keyringSize: 256,
      keySize: 128,
    });
  }

  bindLocalIdentity(identity: string): void {
    if (!/^\S{1,1024}$/.test(identity) || (this.#localIdentity !== undefined && this.#localIdentity !== identity)) {
      throw new Error("Invalid MatrixRTC local identity");
    }
    this.#localIdentity = identity;
  }

  override getLatestManuallySetKeyIndex(): number {
    return this.#localIdentity === undefined ? 0 : (this.#latestIndices.get(this.#localIdentity) ?? 0);
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
    this.#latestIndices.set(participantIdentity, index);
    this.onSetEncryptionKey(material, participantIdentity, index);
    return true;
  }
}
