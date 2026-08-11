import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  DigitalOceanApiProvider,
  type DigitalOceanProvider,
} from "@/src/server/runners/digitalocean-provider";

const SNAPSHOT_ID = /^[1-9][0-9]{0,18}$/;
const SNAPSHOT_NAME = /^bruno-snapshot-builder-[a-f0-9]{12}-[1-9][0-9]{0,19}$/;
const REGION = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export type RunnerSnapshotRetirementProvider = Required<
  Pick<DigitalOceanProvider, "readImageAvailability" | "deleteImage" | "verifyImageAbsent">
>;

export type RunnerSnapshotRetirementEvidence = {
  schemaVersion: "bruno.runner.snapshot.retirement.v1";
  snapshotId: string;
  snapshotName: string;
  region: string;
  retiredAt: string;
  absenceVerified: true;
};

export async function retireSupersededRunnerSnapshot(
  input: { snapshotId: string; expectedName: string; expectedRegion: string },
  dependencies: {
    provider: RunnerSnapshotRetirementProvider;
    now?: () => Date;
    signal?: AbortSignal;
  },
): Promise<RunnerSnapshotRetirementEvidence> {
  const snapshotId = input.snapshotId.trim();
  const expectedName = input.expectedName.trim();
  const expectedRegion = input.expectedRegion.trim();
  if (
    !SNAPSHOT_ID.test(snapshotId) ||
    !SNAPSHOT_NAME.test(expectedName) ||
    !REGION.test(expectedRegion)
  ) {
    throw new Error("Superseded snapshot retirement target is invalid.");
  }

  const context = dependencies.signal ? { signal: dependencies.signal } : undefined;
  const observed = await dependencies.provider.readImageAvailability(
    { imageId: snapshotId },
    context,
  );
  if (!observed.ok) {
    const alreadyAbsent = await dependencies.provider.verifyImageAbsent(
      { imageId: snapshotId },
      context,
    );
    if (!alreadyAbsent.ok) {
      throw new Error("Superseded snapshot identity could not be verified.");
    }
    return retirementEvidence({
      snapshotId,
      snapshotName: expectedName,
      region: expectedRegion,
      now: dependencies.now,
    });
  }

  const image = observed.value;
  if (
    image.id !== snapshotId ||
    image.name !== expectedName ||
    image.status !== "available" ||
    image.architecture !== "amd64" ||
    image.regions.length !== 1 ||
    image.regions[0] !== expectedRegion
  ) {
    throw new Error("Superseded snapshot identity did not match the authorized target.");
  }

  const deleted = await dependencies.provider.deleteImage({ imageId: snapshotId }, context);
  if (!deleted.ok) {
    throw new Error("Superseded snapshot deletion did not complete authoritatively.");
  }
  const absent = await dependencies.provider.verifyImageAbsent({ imageId: snapshotId }, context);
  if (!absent.ok) {
    throw new Error("Superseded snapshot absence could not be verified.");
  }

  return retirementEvidence({
    snapshotId,
    snapshotName: expectedName,
    region: expectedRegion,
    now: dependencies.now,
  });
}

function retirementEvidence(input: {
  snapshotId: string;
  snapshotName: string;
  region: string;
  now: (() => Date) | undefined;
}): RunnerSnapshotRetirementEvidence {
  const retiredAt = (input.now ?? (() => new Date()))().toISOString();
  return {
    schemaVersion: "bruno.runner.snapshot.retirement.v1",
    snapshotId: input.snapshotId,
    snapshotName: input.snapshotName,
    region: input.region,
    retiredAt,
    absenceVerified: true,
  };
}

function parseArgs(values: string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid runner snapshot retirement argument near ${key ?? "<end>"}.`);
    }
    parsed.set(key.slice(2), value);
  }
  return {
    snapshotId: requiredArg(parsed, "snapshot-id"),
    expectedName: requiredArg(parsed, "expected-name"),
    expectedRegion: requiredArg(parsed, "expected-region"),
    output: requiredArg(parsed, "output"),
  };
}

function requiredArg(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}

function readRequiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2 * 60 * 1000);
  try {
    const provider = new DigitalOceanApiProvider({
      token: readRequiredEnv("BRUNO_DIGITALOCEAN_TOKEN"),
    });
    const evidence = await retireSupersededRunnerSnapshot(args, {
      provider,
      signal: controller.signal,
    });
    await writeFile(args.output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write("Superseded runner snapshot absence verified.\n");
  } finally {
    clearTimeout(timeout);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
