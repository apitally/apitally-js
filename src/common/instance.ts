import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_DIR = join(tmpdir(), "apitally");
const MAX_SLOTS = 100;
const MAX_LOCK_AGE_MS = 24 * 60 * 60 * 1000;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getOrCreateInstanceUuid(clientId: string, env: string): string {
  try {
    mkdirSync(TEMP_DIR, { recursive: true });
  } catch {
    return randomUUID();
  }

  const hash = getAppEnvHash(clientId, env);
  validateLockFiles(hash);

  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const pidFile = join(TEMP_DIR, `instance_${hash}_${slot}.pid`);
    const uuidFile = join(TEMP_DIR, `instance_${hash}_${slot}.uuid`);

    // Try atomic exclusive create of PID file
    try {
      const fd = openSync(pidFile, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return getOrCreateUuid(uuidFile);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        continue;
      }
    }

    // PID file exists - check if it's ours (hot reload)
    try {
      const pid = parseInt(readFileSync(pidFile, "utf-8"), 10);
      if (pid === process.pid) {
        return readFileSync(uuidFile, "utf-8");
      }
    } catch {
      // Read error - try next slot
    }
  }

  return randomUUID();
}

function getAppEnvHash(clientId: string, env: string): string {
  return createHash("sha256")
    .update(`${clientId}:${env}`)
    .digest("hex")
    .slice(0, 8);
}

function getOrCreateUuid(uuidFile: string): string {
  try {
    const existingUuid = readFileSync(uuidFile, "utf-8").trim();
    if (validateUuid(existingUuid)) {
      return existingUuid;
    }
  } catch {
    // File doesn't exist or read error
  }

  const newUuid = randomUUID();
  writeFileSync(uuidFile, newUuid);
  return newUuid;
}

function validateUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function deleteFiles(...paths: string[]) {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      // Ignore errors
    }
  }
}

export function validateLockFiles(appEnvHash: string) {
  let files: string[];
  try {
    files = readdirSync(TEMP_DIR);
  } catch {
    return;
  }

  const prefix = `instance_${appEnvHash}_`;
  const uuidFiles = files
    .filter((f) => f.startsWith(prefix) && f.endsWith(".uuid"))
    .sort();

  const seenUuids = new Set<string>();
  const now = Date.now();

  for (const uuidFileName of uuidFiles) {
    const uuidFile = join(TEMP_DIR, uuidFileName);
    const pidFile = join(TEMP_DIR, uuidFileName.replace(".uuid", ".pid"));

    try {
      const stat = statSync(uuidFile);

      // Delete if older than 24 hours
      if (now - stat.mtimeMs > MAX_LOCK_AGE_MS) {
        deleteFiles(uuidFile, pidFile);
        continue;
      }

      // Delete if UUID is invalid
      const uuid = readFileSync(uuidFile, "utf-8").trim();
      if (!validateUuid(uuid)) {
        deleteFiles(uuidFile, pidFile);
        continue;
      }

      // Delete if UUID is a duplicate
      if (seenUuids.has(uuid)) {
        deleteFiles(uuidFile, pidFile);
        continue;
      }
      seenUuids.add(uuid);

      // Delete if PID is dead
      try {
        const pid = parseInt(readFileSync(pidFile, "utf-8"), 10);
        if (!isPidAlive(pid)) {
          deleteFiles(pidFile);
        }
      } catch {
        // Ignore PID file doesn't exist or read error
      }
    } catch {
      // Ignore stat or read error
    }
  }

  // Clean up orphaned .pid files (no matching .uuid file)
  const pidFiles = files.filter(
    (f) => f.startsWith(prefix) && f.endsWith(".pid"),
  );
  for (const pidFileName of pidFiles) {
    const uuidFileName = pidFileName.replace(".pid", ".uuid");
    if (!files.includes(uuidFileName)) {
      deleteFiles(join(TEMP_DIR, pidFileName));
    }
  }
}
