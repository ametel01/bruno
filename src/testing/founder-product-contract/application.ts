import type { FounderProductContractClock } from "./clock";
import type { FounderProductContractProviderDoubles } from "./providers";

export type FounderProductContractPublicRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
};

export type FounderProductContractApplicationContext = {
  clock: FounderProductContractClock;
  providers: FounderProductContractProviderDoubles;
};

export type FounderProductContractPublicResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  json(): Promise<unknown>;
};

/** Adapter for the real persisted Founder application/API boundary. */
export type FounderProductContractApplication = {
  request(
    input: FounderProductContractPublicRequest,
    context?: FounderProductContractApplicationContext,
  ): Promise<FounderProductContractPublicResponse>;
};
