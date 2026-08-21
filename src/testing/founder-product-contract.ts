/**
 * Public testing seams for the persisted Founder application contract.
 *
 * Lifecycle behavior belongs to the production application and its public API.
 * This module only re-exports injectable boundaries and the evidence ledger.
 */

export * from "./founder-product-contract/application";
export * from "./founder-product-contract/clock";
export * from "./founder-product-contract/harness";
export * from "./founder-product-contract/ledger";
export * from "./founder-product-contract/providers";
export * from "./founder-product-contract/scenarios";
export * from "./founder-product-contract/types";
