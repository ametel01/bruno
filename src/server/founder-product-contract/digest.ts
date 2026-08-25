import "server-only";

import { createHash } from "node:crypto";

export function founderProductContractDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
