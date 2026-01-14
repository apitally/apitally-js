import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

describe("Get or create instance UUID", () => {
  let tempDir: string;
  let getOrCreateInstanceUuid: (clientId: string, env: string) => string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "apitally-test-"));
    vi.doMock("node:os", () => ({ tmpdir: () => tempDir }));
  });

  beforeEach(async () => {
    vi.resetModules();
    const module = await import("../../src/common/instance.js");
    getOrCreateInstanceUuid = module.getOrCreateInstanceUuid;
    rmSync(join(tempDir, "apitally"), { recursive: true, force: true });
  });

  afterAll(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Creates new UUID for new client/env", () => {
    const uuid = getOrCreateInstanceUuid("client-1", "dev");
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("Different clients/envs get different UUIDs", () => {
    const uuid1 = getOrCreateInstanceUuid("client-3", "dev");
    const uuid2 = getOrCreateInstanceUuid("client-3", "prod");
    const uuid3 = getOrCreateInstanceUuid("client-4", "dev");
    expect(uuid2).not.toBe(uuid1);
    expect(uuid3).not.toBe(uuid1);
  });

  it("Reuses UUID when PID matches (hot reload)", () => {
    const uuid1 = getOrCreateInstanceUuid("client-2", "dev");
    const uuid2 = getOrCreateInstanceUuid("client-2", "dev");
    expect(uuid1).toBe(uuid2);
  });

  it("Reuses UUID when claiming slot from dead process", () => {
    const apitallyDir = join(tempDir, "apitally");
    mkdirSync(apitallyDir, { recursive: true });

    const clientId = "test-client";
    const env = "test-env";
    const hash = createHash("sha256")
      .update(`${clientId}:${env}`)
      .digest("hex")
      .slice(0, 8);

    const existingUuid = "550e8400-e29b-41d4-a716-446655440000";
    const deadPid = 99999999;

    writeFileSync(join(apitallyDir, `instance_${hash}_0.uuid`), existingUuid);
    writeFileSync(join(apitallyDir, `instance_${hash}_0.pid`), String(deadPid));

    const uuid = getOrCreateInstanceUuid(clientId, env);
    expect(uuid).toBe(existingUuid);
  });
});

describe("Validate lock files", () => {
  let tempDir: string;
  let validateLockFiles: (appEnvHash: string) => void;

  const hash = "abcd1234";

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "apitally-test-"));
    vi.doMock("node:os", () => ({ tmpdir: () => tempDir }));
  });

  beforeEach(async () => {
    vi.resetModules();
    const module = await import("../../src/common/instance.js");
    validateLockFiles = module.validateLockFiles;
    mkdirSync(join(tempDir, "apitally"), { recursive: true });
  });

  afterEach(() => {
    rmSync(join(tempDir, "apitally"), { recursive: true, force: true });
  });

  afterAll(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Deletes files older than 24 hours", () => {
    const uuidFile = join(tempDir, "apitally", `instance_${hash}_0.uuid`);
    const pidFile = join(tempDir, "apitally", `instance_${hash}_0.pid`);

    writeFileSync(uuidFile, "550e8400-e29b-41d4-a716-446655440000");
    writeFileSync(pidFile, "99999999");

    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(uuidFile, oldTime, oldTime);

    validateLockFiles(hash);

    expect(existsSync(uuidFile)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("Deletes files with invalid UUID", () => {
    const uuidFile = join(tempDir, "apitally", `instance_${hash}_0.uuid`);
    const pidFile = join(tempDir, "apitally", `instance_${hash}_0.pid`);

    writeFileSync(uuidFile, "not-a-valid-uuid");
    writeFileSync(pidFile, "99999999");

    validateLockFiles(hash);

    expect(existsSync(uuidFile)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("Deletes duplicate UUID files", () => {
    const duplicateUuid = "550e8400-e29b-41d4-a716-446655440000";
    const uuidFile0 = join(tempDir, "apitally", `instance_${hash}_0.uuid`);
    const pidFile0 = join(tempDir, "apitally", `instance_${hash}_0.pid`);
    const uuidFile1 = join(tempDir, "apitally", `instance_${hash}_1.uuid`);
    const pidFile1 = join(tempDir, "apitally", `instance_${hash}_1.pid`);

    writeFileSync(uuidFile0, duplicateUuid);
    writeFileSync(pidFile0, "99999999");
    writeFileSync(uuidFile1, duplicateUuid);
    writeFileSync(pidFile1, "99999998");

    validateLockFiles(hash);

    expect(existsSync(uuidFile0)).toBe(true);
    expect(existsSync(uuidFile1)).toBe(false);
    expect(existsSync(pidFile1)).toBe(false);
  });

  it("Deletes PID file when process is dead", () => {
    const uuidFile = join(tempDir, "apitally", `instance_${hash}_0.uuid`);
    const pidFile = join(tempDir, "apitally", `instance_${hash}_0.pid`);

    writeFileSync(uuidFile, "550e8400-e29b-41d4-a716-446655440000");
    writeFileSync(pidFile, "99999999");

    validateLockFiles(hash);

    expect(existsSync(uuidFile)).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("Deletes orphaned PID files", () => {
    const pidFile = join(tempDir, "apitally", `instance_${hash}_0.pid`);
    writeFileSync(pidFile, "99999999");

    validateLockFiles(hash);

    expect(existsSync(pidFile)).toBe(false);
  });
});
