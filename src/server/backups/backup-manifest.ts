export const BACKUP_STATUSES = [
  "pending",
  "uploading",
  "ready",
  "failed",
  "restoring",
  "restored",
] as const;

export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export type BackupSecretReferenceKind = "env" | "vault" | "external";

export type BackupSecretReference = {
  kind: BackupSecretReferenceKind;
  ref: string;
};

export type BackupFileMetadata = {
  path: string;
  sizeBytes?: number;
  sha256?: string;
  updatedAt?: string;
};

export type BackupLogMetadata = {
  source: string;
  stream: "stdout" | "stderr";
  level: string;
  sequenceFrom?: number;
  sequenceTo?: number;
  entryCount?: number;
};

export type BackupManifest = {
  schemaVersion: 1;
  agent: {
    id: string;
    name: string;
    status: string;
    templateKey: string;
    templateVersion: string;
    createdAt?: string;
    updatedAt?: string;
  };
  config: {
    modelProvider: string;
    modelName: string;
    scheduleMode: string;
    timezone: string;
    maxDailySpendCents: number;
    scheduleCron?: string | null;
    secretReferences?: Record<string, BackupSecretReference>;
  };
  templateSnapshot: Record<string, unknown>;
  systemPrompt: string;
  skills: {
    folderPath?: string;
    files: BackupFileMetadata[];
  };
  memory: {
    files: BackupFileMetadata[];
  };
  logs: {
    included: boolean;
    entries: BackupLogMetadata[];
  };
};

export type BackupManifestValidationResult =
  | { ok: true; manifest: BackupManifest }
  | { ok: false; errors: string[] };

const BACKUP_STATUS_TRANSITIONS = {
  pending: ["uploading", "failed"],
  uploading: ["ready", "failed"],
  ready: ["restoring", "failed"],
  failed: [],
  restoring: ["restored", "failed"],
  restored: [],
} as const satisfies Record<BackupStatus, readonly BackupStatus[]>;

const SECRET_KEY_PATTERN =
  /(api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|provider[_-]?token|registration[_-]?token|secret|token|password|credential|authorization|bearer)/i;

const RAW_SECRET_VALUE_PATTERNS = [
  /^Bearer\s+\S+/i,
  /^sk-[A-Za-z0-9_-]{8,}/,
  /^dop_v1_[A-Za-z0-9_-]{8,}/,
  /^agb_(run|reg)_[A-Za-z0-9_-]{8,}/,
  /^gh[pousr]_[A-Za-z0-9_]{8,}/,
  /^AKIA[A-Z0-9]{12,}/,
  /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/,
] as const;

export function isBackupStatus(value: unknown): value is BackupStatus {
  return typeof value === "string" && BACKUP_STATUSES.includes(value as BackupStatus);
}

export function canTransitionBackupStatus(from: BackupStatus, to: BackupStatus): boolean {
  return (BACKUP_STATUS_TRANSITIONS[from] as readonly BackupStatus[]).includes(to);
}

export function validateBackupManifest(input: unknown): BackupManifestValidationResult {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: ["manifest must be an object"] };
  }

  if (input.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }

  validateAgentSection(input.agent, errors);
  validateConfigSection(input.config, errors);
  requireRecord(input.templateSnapshot, "templateSnapshot", errors);
  requireNonEmptyString(input.systemPrompt, "systemPrompt", errors);
  validateFileCollection(input.skills, "skills", errors);
  validateFileCollection(input.memory, "memory", errors);
  validateLogsSection(input.logs, errors);

  collectRawSecretViolations(input, [], errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, manifest: input as BackupManifest };
}

function validateAgentSection(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("agent must be an object");
    return;
  }

  requireNonEmptyString(value.id, "agent.id", errors);
  requireNonEmptyString(value.name, "agent.name", errors);
  requireNonEmptyString(value.status, "agent.status", errors);
  requireNonEmptyString(value.templateKey, "agent.templateKey", errors);
  requireNonEmptyString(value.templateVersion, "agent.templateVersion", errors);
}

function validateConfigSection(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("config must be an object");
    return;
  }

  requireNonEmptyString(value.modelProvider, "config.modelProvider", errors);
  requireNonEmptyString(value.modelName, "config.modelName", errors);
  requireNonEmptyString(value.scheduleMode, "config.scheduleMode", errors);
  requireNonEmptyString(value.timezone, "config.timezone", errors);

  const maxDailySpendCents = value.maxDailySpendCents;
  if (
    typeof maxDailySpendCents !== "number" ||
    !Number.isInteger(maxDailySpendCents) ||
    maxDailySpendCents < 0
  ) {
    errors.push("config.maxDailySpendCents must be a nonnegative integer");
  }

  if (value.secretReferences !== undefined) {
    validateSecretReferences(value.secretReferences, errors);
  }
}

function validateSecretReferences(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("config.secretReferences must be an object");
    return;
  }

  for (const [name, reference] of Object.entries(value)) {
    if (!isRecord(reference)) {
      errors.push(`config.secretReferences.${name} must be an object`);
      continue;
    }

    for (const referenceKey of Object.keys(reference)) {
      if (referenceKey !== "kind" && referenceKey !== "ref") {
        errors.push(`config.secretReferences.${name}.${referenceKey} is not allowed`);
      }
    }

    if (!["env", "vault", "external"].includes(String(reference.kind))) {
      errors.push(`config.secretReferences.${name}.kind must be env, vault, or external`);
    }

    requireNonEmptyString(reference.ref, `config.secretReferences.${name}.ref`, errors);

    if (typeof reference.ref === "string" && hasRawSecretValue(reference.ref)) {
      errors.push(`config.secretReferences.${name}.ref must be a reference, not a raw secret`);
    }
  }
}

function validateFileCollection(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  if (!Array.isArray(value.files)) {
    errors.push(`${path}.files must be an array`);
    return;
  }

  value.files.forEach((file, index) => {
    validateFileMetadata(file, `${path}.files.${index}`, errors);
  });
}

function validateFileMetadata(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  requireNonEmptyString(value.path, `${path}.path`, errors);

  const sizeBytes = value.sizeBytes;
  if (
    sizeBytes !== undefined &&
    (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0)
  ) {
    errors.push(`${path}.sizeBytes must be a nonnegative integer`);
  }

  if (value.sha256 !== undefined && !isSha256(value.sha256)) {
    errors.push(`${path}.sha256 must be a lowercase sha256 hex digest`);
  }
}

function validateLogsSection(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("logs must be an object");
    return;
  }

  if (typeof value.included !== "boolean") {
    errors.push("logs.included must be a boolean");
  }

  if (!Array.isArray(value.entries)) {
    errors.push("logs.entries must be an array");
    return;
  }

  for (const [index, entry] of value.entries.entries()) {
    const path = `logs.entries.${index}`;

    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      continue;
    }

    requireNonEmptyString(entry.source, `${path}.source`, errors);
    if (entry.stream !== "stdout" && entry.stream !== "stderr") {
      errors.push(`${path}.stream must be stdout or stderr`);
    }
    requireNonEmptyString(entry.level, `${path}.level`, errors);
    validateOptionalNonnegativeInteger(entry.sequenceFrom, `${path}.sequenceFrom`, errors);
    validateOptionalNonnegativeInteger(entry.sequenceTo, `${path}.sequenceTo`, errors);
    validateOptionalNonnegativeInteger(entry.entryCount, `${path}.entryCount`, errors);
  }
}

function collectRawSecretViolations(value: unknown, path: string[], errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectRawSecretViolations(item, [...path, String(index)], errors);
    });
    return;
  }

  if (!isRecord(value)) {
    if (typeof value === "string" && hasRawSecretValue(value)) {
      errors.push(`${formatPath(path)} must not contain a raw secret-like value`);
    }
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = [...path, key];

    if (isAllowedSecretReferencePath(nestedPath)) {
      continue;
    }

    if (SECRET_KEY_PATTERN.test(key)) {
      errors.push(
        `${formatPath(nestedPath)} must use config.secretReferences instead of raw secrets`,
      );
      continue;
    }

    collectRawSecretViolations(nestedValue, nestedPath, errors);
  }
}

function isAllowedSecretReferencePath(path: string[]): boolean {
  return path[0] === "config" && path[1] === "secretReferences";
}

function requireRecord(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
  }
}

function requireNonEmptyString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
  }
}

function validateOptionalNonnegativeInteger(value: unknown, path: string, errors: string[]): void {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) < 0)) {
    errors.push(`${path} must be a nonnegative integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hasRawSecretValue(value: string): boolean {
  return RAW_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

function formatPath(path: string[]): string {
  return path.length === 0 ? "manifest" : path.join(".");
}
