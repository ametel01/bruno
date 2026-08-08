import {
  DEFAULT_HERMES_DOCKER_CPUS,
  DEFAULT_HERMES_DOCKER_MEMORY,
  DEFAULT_HERMES_DOCKER_PIDS_LIMIT,
  DEFAULT_HERMES_RUNNER_MAX_AGENTS,
} from "@/src/runner-service/constants";

export const DIGITALOCEAN_RUNNER_HOST_MEMORY_RESERVE_MIB = 384;
export const DIGITALOCEAN_LOW_MEMORY_SWAP_RESILIENCE_SIZE_SLUG = "s-1vcpu-512mb-10gb";
export const PROVISIONAL_DIGITALOCEAN_RUNNER_SIZE_SLUG = "s-1vcpu-2gb";
export const HERMES_DOCKER_CPU_NANO_UNITS = 1_000_000_000;
export const MAX_HERMES_DOCKER_PIDS_LIMIT = 4096;

const DIGITALOCEAN_RUNNER_RESOURCE_PROFILES = {
  "s-1vcpu-512mb-10gb": {
    vcpus: 1,
    memoryMiB: 512,
    diskGiB: 10,
    monthlyCents: 400,
    lowMemorySwapResilience: true,
  },
  "s-1vcpu-1gb": {
    vcpus: 1,
    memoryMiB: 1024,
    diskGiB: 25,
    monthlyCents: 600,
    lowMemorySwapResilience: false,
  },
  "s-1vcpu-2gb": {
    vcpus: 1,
    memoryMiB: 2048,
    diskGiB: 50,
    monthlyCents: 1200,
    lowMemorySwapResilience: false,
  },
  "s-2vcpu-2gb": {
    vcpus: 2,
    memoryMiB: 2048,
    diskGiB: 60,
    monthlyCents: 1800,
    lowMemorySwapResilience: false,
  },
} as const satisfies Record<
  string,
  {
    vcpus: number;
    memoryMiB: number;
    diskGiB: number;
    monthlyCents: number;
    lowMemorySwapResilience: boolean;
  }
>;

export type SupportedDigitalOceanRunnerSizeSlug =
  keyof typeof DIGITALOCEAN_RUNNER_RESOURCE_PROFILES;

export type DigitalOceanRunnerResourceProfile = {
  sizeSlug: SupportedDigitalOceanRunnerSizeSlug;
  vcpus: number;
  memoryMiB: number;
  diskGiB: number;
  monthlyCents: number;
  lowMemorySwapResilience: boolean;
};

export type HermesRuntimeResourceProfile = {
  cpus: string;
  memory: string;
  pidsLimit: string;
};

export type RunnerResourceCompatibilityInput = {
  sizeSlug: string | null | undefined;
  runnerMaxAgents?: number;
  hermesDockerCpus?: string;
  hermesDockerMemory?: string;
  hermesDockerPidsLimit?: string;
};

export type RunnerCapacityProfileInput = {
  vcpus: number | null | undefined;
  memoryMiB: number | null | undefined;
  diskGiB: number | null | undefined;
  perHermesCpu?: number | null | undefined;
  perHermesMemoryMiB?: number | null | undefined;
  perHermesDiskGiB?: number | null | undefined;
  hostMemoryReserveMiB?: number | null | undefined;
  hostDiskReserveGiB?: number | null | undefined;
};

export type RunnerSelectableCapacityInput = RunnerCapacityProfileInput & {
  heartbeatMaxAgents?: number | null | undefined;
  configuredMaxAgents?: number | null | undefined;
  measuredMaxAgents?: number | null | undefined;
};

export type RunnerCapacityComputation = {
  cpuMaxAgents: number;
  memoryMaxAgents: number;
  diskMaxAgents: number;
  profileMaxAgents: number;
  heartbeatMaxAgents: number;
  configuredMaxAgents: number;
  measuredMaxAgents: number;
  selectableMaxAgents: number;
  failClosedReasons: string[];
};

export type RunnerResourceCompatibilityIssue = {
  field: string;
  message: string;
};

export type RunnerResourceCompatibilityResult =
  | {
      ok: true;
      profile: DigitalOceanRunnerResourceProfile;
      runnerMaxAgents: number;
      hermesRuntime: HermesRuntimeResourceProfile;
      requiredPhysicalMemoryMiB: number;
      hostMemoryReserveMiB: number;
    }
  | {
      ok: false;
      issues: RunnerResourceCompatibilityIssue[];
    };

export function listDigitalOceanRunnerResourceProfiles(): DigitalOceanRunnerResourceProfile[] {
  return (
    Object.keys(DIGITALOCEAN_RUNNER_RESOURCE_PROFILES) as SupportedDigitalOceanRunnerSizeSlug[]
  ).map((sizeSlug) => getDigitalOceanRunnerResourceProfile(sizeSlug));
}

export function getDigitalOceanRunnerResourceProfile(
  sizeSlug: SupportedDigitalOceanRunnerSizeSlug,
): DigitalOceanRunnerResourceProfile {
  return { sizeSlug, ...DIGITALOCEAN_RUNNER_RESOURCE_PROFILES[sizeSlug] };
}

export function findDigitalOceanRunnerResourceProfile(
  sizeSlug: string | null | undefined,
): DigitalOceanRunnerResourceProfile | null {
  const normalized = normalizeDigitalOceanSizeSlug(sizeSlug);
  if (!isSupportedDigitalOceanRunnerSizeSlug(normalized)) return null;
  return getDigitalOceanRunnerResourceProfile(normalized);
}

export function isSupportedDigitalOceanRunnerSizeSlug(
  sizeSlug: string | null,
): sizeSlug is SupportedDigitalOceanRunnerSizeSlug {
  return sizeSlug !== null && Object.hasOwn(DIGITALOCEAN_RUNNER_RESOURCE_PROFILES, sizeSlug);
}

export function isDigitalOceanLowMemorySwapResilienceProfile(sizeSlug: string): boolean {
  return findDigitalOceanRunnerResourceProfile(sizeSlug)?.lowMemorySwapResilience === true;
}

export function validateDigitalOceanRunnerResourceCompatibility(
  input: RunnerResourceCompatibilityInput,
): RunnerResourceCompatibilityResult {
  const issues: RunnerResourceCompatibilityIssue[] = [];
  const profile = findDigitalOceanRunnerResourceProfile(input.sizeSlug);
  const runnerMaxAgents = input.runnerMaxAgents ?? DEFAULT_HERMES_RUNNER_MAX_AGENTS;
  const cpus = input.hermesDockerCpus ?? DEFAULT_HERMES_DOCKER_CPUS;
  const memory = input.hermesDockerMemory ?? DEFAULT_HERMES_DOCKER_MEMORY;
  const pidsLimit = input.hermesDockerPidsLimit ?? DEFAULT_HERMES_DOCKER_PIDS_LIMIT;
  const parsedCpus = parseHermesDockerCpus(cpus);
  const parsedMemoryMiB = parseHermesDockerMemoryMiB(memory);
  const parsedPidsLimit = parseHermesDockerPidsLimit(pidsLimit);

  if (!profile) {
    issues.push({
      field: "BRUNO_DIGITALOCEAN_SIZE_SLUG",
      message:
        "BRUNO_DIGITALOCEAN_SIZE_SLUG must be one of the supported managed-runner resource profiles.",
    });
  }

  if (!Number.isInteger(runnerMaxAgents) || runnerMaxAgents <= 0) {
    issues.push({
      field: "BRUNO_RUNNER_MAX_AGENTS",
      message: "BRUNO_RUNNER_MAX_AGENTS must be a positive integer.",
    });
  }

  if (parsedCpus === null) {
    issues.push({
      field: "BRUNO_HERMES_DOCKER_CPUS",
      message: "BRUNO_HERMES_DOCKER_CPUS must be a positive Docker CPU value.",
    });
  }

  if (parsedMemoryMiB === null) {
    issues.push({
      field: "BRUNO_HERMES_DOCKER_MEMORY",
      message: "BRUNO_HERMES_DOCKER_MEMORY must be a positive whole-MiB Docker memory value.",
    });
  }

  if (parsedPidsLimit === null) {
    issues.push({
      field: "BRUNO_HERMES_DOCKER_PIDS_LIMIT",
      message: "BRUNO_HERMES_DOCKER_PIDS_LIMIT must be a positive integer.",
    });
  }

  if (
    issues.length > 0 ||
    !profile ||
    parsedCpus === null ||
    parsedMemoryMiB === null ||
    parsedPidsLimit === null
  ) {
    return { ok: false, issues };
  }

  const capacity = computeSelectableRunnerCapacity({
    vcpus: profile.vcpus,
    memoryMiB: profile.memoryMiB,
    diskGiB: profile.diskGiB,
    perHermesCpu: parsedCpus,
    perHermesMemoryMiB: parsedMemoryMiB,
    configuredMaxAgents: runnerMaxAgents,
    measuredMaxAgents: DEFAULT_HERMES_RUNNER_MAX_AGENTS,
  });

  if (runnerMaxAgents > capacity.cpuMaxAgents) {
    issues.push({
      field: "BRUNO_HERMES_DOCKER_CPUS",
      message: `Hermes CPU capacity (${parsedCpus * runnerMaxAgents}) exceeds ${profile.sizeSlug}'s ${profile.vcpus} vCPU profile.`,
    });
  }

  const requiredPhysicalMemoryMiB =
    parsedMemoryMiB * runnerMaxAgents + DIGITALOCEAN_RUNNER_HOST_MEMORY_RESERVE_MIB;
  if (runnerMaxAgents > capacity.memoryMaxAgents) {
    issues.push({
      field: "BRUNO_DIGITALOCEAN_SIZE_SLUG",
      message: `${profile.sizeSlug} has ${profile.memoryMiB} MiB physical RAM, but ${runnerMaxAgents} Hermes agent(s) require ${requiredPhysicalMemoryMiB} MiB including the ${DIGITALOCEAN_RUNNER_HOST_MEMORY_RESERVE_MIB} MiB runner/OS reserve. Swap is not counted as compatible memory.`,
    });
  }

  if (runnerMaxAgents > capacity.selectableMaxAgents) {
    issues.push({
      field: "BRUNO_RUNNER_MAX_AGENTS",
      message:
        "BRUNO_RUNNER_MAX_AGENTS above 1 is blocked until an exact measured CPU, memory, and disk capacity profile is approved.",
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    profile,
    runnerMaxAgents,
    hermesRuntime: { cpus, memory, pidsLimit },
    requiredPhysicalMemoryMiB,
    hostMemoryReserveMiB: DIGITALOCEAN_RUNNER_HOST_MEMORY_RESERVE_MIB,
  };
}

export function computeSelectableRunnerCapacity(
  input: RunnerSelectableCapacityInput,
): RunnerCapacityComputation {
  const failClosedReasons: string[] = [];
  const perHermesCpu = normalizePositiveNumber(
    input.perHermesCpu,
    "per_hermes_cpu",
    failClosedReasons,
  );
  const perHermesMemoryMiB = normalizePositiveInteger(
    input.perHermesMemoryMiB,
    "per_hermes_memory_mib",
    failClosedReasons,
  );
  const perHermesDiskGiB = normalizePositiveNumber(
    input.perHermesDiskGiB,
    "per_hermes_disk_gib",
    failClosedReasons,
  );
  const hostMemoryReserveMiB = normalizeNonNegativeInteger(
    input.hostMemoryReserveMiB ?? DIGITALOCEAN_RUNNER_HOST_MEMORY_RESERVE_MIB,
    "host_memory_reserve_mib",
    failClosedReasons,
  );
  const hostDiskReserveGiB = normalizeNonNegativeNumber(
    input.hostDiskReserveGiB,
    "host_disk_reserve_gib",
    failClosedReasons,
  );
  const vcpus = normalizePositiveNumber(input.vcpus, "profile_vcpus", failClosedReasons);
  const memoryMiB = normalizePositiveInteger(
    input.memoryMiB,
    "profile_memory_mib",
    failClosedReasons,
  );
  const diskGiB = normalizePositiveNumber(input.diskGiB, "profile_disk_gib", failClosedReasons);
  const cpuMaxAgents = floorCapacity(vcpus, perHermesCpu);
  const memoryMaxAgents = floorCapacity(memoryMiB - hostMemoryReserveMiB, perHermesMemoryMiB);
  const diskMaxAgents = floorCapacity(diskGiB - hostDiskReserveGiB, perHermesDiskGiB);
  const profileMaxAgents = normalizeComputedMax(
    Math.min(cpuMaxAgents, memoryMaxAgents, diskMaxAgents),
  );
  const heartbeatMaxAgents = normalizePositiveInteger(
    input.heartbeatMaxAgents,
    "heartbeat_max_agents",
    failClosedReasons,
  );
  const configuredMaxAgents = normalizePositiveInteger(
    input.configuredMaxAgents ?? DEFAULT_HERMES_RUNNER_MAX_AGENTS,
    "configured_max_agents",
    failClosedReasons,
  );
  const measuredMaxAgents = normalizePositiveInteger(
    input.measuredMaxAgents,
    "measured_max_agents",
    failClosedReasons,
  );

  return {
    cpuMaxAgents,
    memoryMaxAgents,
    diskMaxAgents,
    profileMaxAgents,
    heartbeatMaxAgents,
    configuredMaxAgents,
    measuredMaxAgents,
    selectableMaxAgents: Math.min(
      profileMaxAgents,
      heartbeatMaxAgents,
      configuredMaxAgents,
      measuredMaxAgents,
    ),
    failClosedReasons,
  };
}

export function parseHermesDockerMemoryMiB(value: string): number | null {
  const match = /^([1-9][0-9]*)([bkmg])?$/i.exec(value.trim());
  if (!match?.[1]) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return null;

  const unit = match[2]?.toLowerCase() ?? "b";
  const bytes =
    unit === "g"
      ? amount * 1024 * 1024 * 1024
      : unit === "m"
        ? amount * 1024 * 1024
        : unit === "k"
          ? amount * 1024
          : amount;

  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % (1024 * 1024) !== 0) {
    return null;
  }

  return bytes / (1024 * 1024);
}

export function parseHermesDockerCpus(value: string): number | null {
  const normalized = value.trim();
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) return null;
  const cpus = Number(normalized);
  if (!Number.isFinite(cpus) || cpus <= 0) return null;
  const nanoCpus = cpus * HERMES_DOCKER_CPU_NANO_UNITS;
  if (!Number.isSafeInteger(nanoCpus) || nanoCpus < 1) return null;
  return cpus;
}

export function parseHermesDockerPidsLimit(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_HERMES_DOCKER_PIDS_LIMIT ? parsed : null;
}

function normalizeDigitalOceanSizeSlug(sizeSlug: string | null | undefined): string | null {
  const normalizedSizeSlug = sizeSlug?.trim();
  if (!normalizedSizeSlug) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(normalizedSizeSlug)) return null;
  return normalizedSizeSlug;
}

function normalizePositiveInteger(
  value: number | null | undefined,
  field: string,
  failClosedReasons: string[],
): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  failClosedReasons.push(field);
  return DEFAULT_HERMES_RUNNER_MAX_AGENTS;
}

function normalizeNonNegativeInteger(
  value: number | null | undefined,
  field: string,
  failClosedReasons: string[],
): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  failClosedReasons.push(field);
  return 0;
}

function normalizePositiveNumber(
  value: number | null | undefined,
  field: string,
  failClosedReasons: string[],
): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  failClosedReasons.push(field);
  return 1;
}

function normalizeNonNegativeNumber(
  value: number | null | undefined,
  field: string,
  failClosedReasons: string[],
): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  failClosedReasons.push(field);
  return 0;
}

function floorCapacity(available: number, perAgent: number): number {
  if (!Number.isFinite(available) || !Number.isFinite(perAgent) || perAgent <= 0) {
    return DEFAULT_HERMES_RUNNER_MAX_AGENTS;
  }
  return Math.max(0, Math.floor(available / perAgent));
}

function normalizeComputedMax(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_HERMES_RUNNER_MAX_AGENTS;
}
