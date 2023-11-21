import { scrypt } from "crypto";

export class KeyInfo {
  readonly keyId: number;
  readonly apiKeyId: number;
  readonly name: string;
  readonly scopes: string[];
  readonly expiresAt: Date | null;

  constructor(
    keyId: number,
    apiKeyId: number,
    name: string = "",
    scopes: string[] = [],
    expiresInSeconds: number | null = null,
  ) {
    this.keyId = keyId;
    this.apiKeyId = apiKeyId;
    this.name = name;
    this.scopes = scopes;
    this.expiresAt =
      expiresInSeconds !== null && expiresInSeconds !== undefined
        ? new Date(Date.now() + expiresInSeconds * 1000)
        : null;
  }

  get isExpired() {
    return this.expiresAt !== null && this.expiresAt < new Date();
  }

  hasScopes(scopes: string | string[]) {
    if (typeof scopes === "string") {
      scopes = [scopes];
    }
    return scopes.every((scope) => this.scopes.includes(scope));
  }
}

export class KeyRegistry {
  public salt: string | null;
  private keys: Map<string, KeyInfo>;
  private usageCounts: Map<number, number>;

  constructor() {
    this.salt = null;
    this.keys = new Map();
    this.usageCounts = new Map();
  }

  public async get(apiKey: string) {
    const hash = await this.hashApiKey(apiKey.trim());
    const key = this.keys.get(hash);
    if (!key || key.isExpired) {
      return null;
    }
    this.usageCounts.set(
      key.apiKeyId,
      (this.usageCounts.get(key.apiKeyId) || 0) + 1,
    );
    return key;
  }

  private async hashApiKey(apiKey: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.salt) {
        throw new Error("Apitally API keys not initialized");
      }
      scrypt(
        apiKey,
        Buffer.from(this.salt, "hex"),
        32,
        { N: 256, r: 4, p: 1 },
        (err, derivedKey) => {
          if (err) reject(err);
          resolve(derivedKey.toString("hex"));
        },
      );
    });
  }

  public update(keys: Record<string, any>) {
    this.keys.clear();
    for (const [hash, data] of Object.entries(keys)) {
      this.keys.set(
        hash,
        new KeyInfo(
          data["key_id"],
          data["api_key_id"],
          data["name"],
          data["scopes"],
          data["expires_in_seconds"],
        ),
      );
    }
  }

  public getAndResetUsageCounts(): Record<number, number> {
    const data = Object.fromEntries(this.usageCounts);
    this.usageCounts.clear();
    return data;
  }
}

export abstract class KeyCacheBase {
  private clientId: string;
  private env: string;

  constructor(clientId: string, env: string) {
    this.clientId = clientId;
    this.env = env;
  }

  get cacheKey() {
    return `apitally:keys:${this.clientId}:${this.env}`;
  }

  abstract store(data: string): void;

  abstract retrieve(): string | null;
}
