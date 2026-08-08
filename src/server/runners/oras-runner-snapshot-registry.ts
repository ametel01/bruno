import "server-only";

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  RunnerSnapshotRegistryAdapter,
  RunnerSnapshotRegistryArtifact,
  RunnerSnapshotRegistryFile,
} from "@/src/server/runners/runner-snapshot-registry";

const execFileAsync = promisify(execFile);

export type OrasCommandRunner = (
  args: string[],
  options: { cwd?: string },
) => Promise<{ stdout: string }>;

export class OrasRunnerSnapshotRegistryAdapter implements RunnerSnapshotRegistryAdapter {
  constructor(private readonly runOras: OrasCommandRunner = runOrasCommand) {}

  async listTags(repository: string): Promise<string[]> {
    const { stdout } = await this.runOras(["repo", "tags", repository, "--format", "json"], {});
    let raw: unknown;

    try {
      raw = JSON.parse(stdout);
    } catch {
      throw new Error("Runner snapshot OCI tag listing is not valid JSON.");
    }
    if (
      !isRecord(raw) ||
      !Array.isArray(raw.tags) ||
      raw.tags.some((tag) => typeof tag !== "string")
    ) {
      throw new Error("Runner snapshot OCI tag listing schema is invalid.");
    }

    return raw.tags;
  }

  async publish(
    input: Parameters<RunnerSnapshotRegistryAdapter["publish"]>[0],
  ): Promise<{ ociReference: string }> {
    return withTempDirectory(async (directory) => {
      for (const file of input.files) {
        await writeFile(join(directory, file.name), file.contents, { mode: 0o600 });
      }

      const { stdout } = await this.runOras(
        [
          "push",
          "--artifact-type",
          input.artifactType,
          "--annotation",
          `org.opencontainers.image.source=${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY ?? "ametel01/bruno"}`,
          `${input.repository}:${input.tag}`,
          ...input.files.map((file) => `${file.name}:${file.mediaType}`),
          "--format",
          "go-template={{.digest}}",
        ],
        { cwd: directory },
      );
      const digest = stdout.trim();

      return { ociReference: `${input.repository}@${digest}` };
    });
  }

  async retrieve(ociReference: string): Promise<RunnerSnapshotRegistryArtifact> {
    return withTempDirectory(async (directory) => {
      const [{ stdout: manifestBytes }] = await Promise.all([
        this.runOras(["manifest", "fetch", ociReference], {}),
        this.runOras(["pull", ociReference, "--output", directory], {}),
      ]);
      const manifest = parseOciManifest(manifestBytes);
      const names = (await readdir(directory)).sort();
      const files: RunnerSnapshotRegistryFile[] = [];

      for (const name of names) {
        const mediaType = manifest.layers.get(name);
        if (!mediaType) {
          throw new Error("Runner snapshot OCI manifest did not describe a retrieved file.");
        }
        files.push({
          name,
          mediaType,
          contents: await readFile(join(directory, name), "utf8"),
        });
      }

      return {
        ociReference,
        artifactType: manifest.artifactType,
        files,
      };
    });
  }
}

async function runOrasCommand(
  args: string[],
  options: { cwd?: string },
): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync("oras", args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return { stdout };
}

async function withTempDirectory<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "bruno-snapshot-oci-"));

  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseOciManifest(value: string): {
  artifactType: string;
  layers: Map<string, string>;
} {
  let raw: unknown;

  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("Runner snapshot OCI manifest is not valid JSON.");
  }

  if (!isRecord(raw) || typeof raw.artifactType !== "string" || !Array.isArray(raw.layers)) {
    throw new Error("Runner snapshot OCI manifest schema is invalid.");
  }

  const layers = new Map<string, string>();
  for (const layer of raw.layers) {
    if (
      !isRecord(layer) ||
      typeof layer.mediaType !== "string" ||
      !isRecord(layer.annotations) ||
      typeof layer.annotations["org.opencontainers.image.title"] !== "string"
    ) {
      throw new Error("Runner snapshot OCI layer schema is invalid.");
    }
    layers.set(layer.annotations["org.opencontainers.image.title"], layer.mediaType);
  }

  return { artifactType: raw.artifactType, layers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
