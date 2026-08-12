import { pathToFileURL } from "node:url";
import {
  DEFAULT_LOCAL_OPTIMIZED_HERMES_IMAGE,
  OPTIMIZED_HERMES_IMAGE_CONTRACT,
  smokeHermesAgentImage,
} from "@/scripts/smoke-hermes-agent-image";

async function main() {
  const image = process.env.BRUNO_HERMES_IMAGE?.trim() || DEFAULT_LOCAL_OPTIMIZED_HERMES_IMAGE;
  const summary = await smokeHermesAgentImage(image, OPTIMIZED_HERMES_IMAGE_CONTRACT);
  console.log(JSON.stringify({ event: "optimized_hermes_agent_image_smoke_passed", ...summary }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
