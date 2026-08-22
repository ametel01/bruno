import "server-only";

const LEMON_SQUEEZY_API_BASE_URL = "https://api.lemonsqueezy.com/v1";
const PROVIDER_REQUEST_TIMEOUT_MILLISECONDS = 15_000;

export type LemonSqueezyCommerceStatus =
  | "active"
  | "past_due"
  | "unpaid"
  | "cancelled"
  | "expired"
  | "refunded";

export type LemonSqueezyConfig = {
  mode: "test" | "live";
  apiKey: string;
  storeId: string;
  variantId: string;
  webhookSecret: string;
};

export type ReconciledLemonSqueezySubscription = {
  subscriptionId: string;
  orderId: string;
  status: LemonSqueezyCommerceStatus;
  updatedAt: string;
  endsAt: string | null;
};

export type ReconciledLemonSqueezyOrder = {
  orderId: string;
  status: "pending" | "failed" | "paid" | "refunded" | "partial_refund" | "fraudulent";
  total: number;
  refundedAmount: number;
  updatedAt: string;
};

export type LemonSqueezyCommerceProvider = {
  createCheckout(input: {
    checkoutCorrelation: string;
    redirectUrl: string;
    expiresAt: string;
  }): Promise<{ checkoutId: string; checkoutUrl: string }>;
  readSubscription(input: { subscriptionId: string }): Promise<ReconciledLemonSqueezySubscription>;
  readOrder(input: { orderId: string }): Promise<ReconciledLemonSqueezyOrder>;
  cancelSubscription(input: { subscriptionId: string }): Promise<void>;
  refundOrder(input: { orderId: string }): Promise<ReconciledLemonSqueezyOrder>;
};

export function readLemonSqueezyConfig(
  input: Record<string, string | undefined> = process.env,
): LemonSqueezyConfig | null {
  const rawMode = input.BRUNO_LEMON_SQUEEZY_MODE?.trim() ?? "off";
  if (rawMode === "off") return null;
  if (rawMode !== "test" && rawMode !== "live") {
    throw new Error("BRUNO_LEMON_SQUEEZY_MODE must be off, test, or live.");
  }

  const apiKey = requiredSecret(input.BRUNO_LEMON_SQUEEZY_API_KEY, "API key");
  const webhookSecret = requiredSecret(input.BRUNO_LEMON_SQUEEZY_WEBHOOK_SECRET, "webhook secret");
  const storeId = requiredProviderId(input.BRUNO_LEMON_SQUEEZY_STORE_ID, "store ID");
  const variantId = requiredProviderId(input.BRUNO_LEMON_SQUEEZY_VARIANT_ID, "variant ID");
  return { mode: rawMode, apiKey, webhookSecret, storeId, variantId };
}

export class LemonSqueezyApiProvider implements LemonSqueezyCommerceProvider {
  readonly #config: LemonSqueezyConfig;
  readonly #fetch: typeof fetch;

  constructor(input: {
    config: LemonSqueezyConfig;
    fetch?: typeof fetch;
  }) {
    if (process.env.NODE_ENV === "test" && input.fetch === undefined) {
      throw new Error("Lemon Squeezy network access is disabled in test processes.");
    }
    this.#config = input.config;
    this.#fetch = input.fetch ?? fetch;
  }

  async createCheckout(input: {
    checkoutCorrelation: string;
    redirectUrl: string;
    expiresAt: string;
  }): Promise<{ checkoutId: string; checkoutUrl: string }> {
    if (!isOpaqueCheckoutCorrelation(input.checkoutCorrelation)) {
      throw new Error("Checkout Correlation is invalid.");
    }
    const redirectUrl = requireRedirectUrl(input.redirectUrl, this.#config.mode);
    const expiresAt = requireExactFutureInstant(input.expiresAt);
    const body = await this.#request("/checkouts", {
      method: "POST",
      body: {
        data: {
          type: "checkouts",
          attributes: {
            checkout_data: {
              custom: { checkout_correlation: input.checkoutCorrelation },
            },
            product_options: { redirect_url: redirectUrl },
            checkout_options: { skip_trial: true },
            expires_at: expiresAt,
          },
          relationships: {
            store: { data: { type: "stores", id: this.#config.storeId } },
            variant: { data: { type: "variants", id: this.#config.variantId } },
          },
        },
      },
    });
    const data = readResource(body, "checkouts");
    requireExpectedTestMode(data.attributes, this.#config.mode);
    requireRelationshipId(data.relationships, "store", this.#config.storeId);
    requireRelationshipId(data.relationships, "variant", this.#config.variantId);
    const checkoutData = readRecord(data.attributes.checkout_data);
    const customData = readRecord(checkoutData.custom);
    if (
      customData.checkout_correlation !== input.checkoutCorrelation ||
      Object.keys(customData).length !== 1
    ) {
      throw new Error("Lemon Squeezy checkout custom data is invalid.");
    }
    if (readExactInstant(data.attributes, "expires_at") !== expiresAt) {
      throw new Error("Lemon Squeezy checkout expiry does not match Bruno.Ai authority.");
    }
    const checkoutUrl = readString(data.attributes, "url");
    const parsedUrl = new URL(checkoutUrl);
    if (parsedUrl.protocol !== "https:" || !isLemonSqueezyCheckoutHost(parsedUrl.hostname)) {
      throw new Error("Lemon Squeezy returned an invalid hosted checkout URL.");
    }
    return { checkoutId: data.id, checkoutUrl };
  }

  async readSubscription(input: {
    subscriptionId: string;
  }): Promise<ReconciledLemonSqueezySubscription> {
    const subscriptionId = requireProviderId(input.subscriptionId, "subscription ID");
    const body = await this.#request(`/subscriptions/${subscriptionId}`, { method: "GET" });
    const data = readResource(body, "subscriptions");
    if (data.id !== subscriptionId) {
      throw new Error("Lemon Squeezy returned a different subscription.");
    }
    const attributes = data.attributes;
    requireExpectedTestMode(attributes, this.#config.mode);
    requireConfiguredResource(attributes, "store_id", this.#config.storeId);
    requireConfiguredResource(attributes, "variant_id", this.#config.variantId);
    return {
      subscriptionId,
      orderId: String(readPositiveInteger(attributes, "order_id")),
      status: parseCommerceStatus(readString(attributes, "status")),
      updatedAt: readExactInstant(attributes, "updated_at"),
      endsAt: readNullableExactInstant(attributes, "ends_at"),
    };
  }

  async refundOrder(input: { orderId: string }): Promise<ReconciledLemonSqueezyOrder> {
    const orderId = requireProviderId(input.orderId, "order ID");
    await this.#request(`/orders/${orderId}/refund`, {
      method: "POST",
      body: {
        data: {
          type: "orders",
          id: orderId,
        },
      },
    });
    return this.readOrder({ orderId });
  }

  async readOrder(input: { orderId: string }): Promise<ReconciledLemonSqueezyOrder> {
    const orderId = requireProviderId(input.orderId, "order ID");
    const orderBody = await this.#request(`/orders/${orderId}`, { method: "GET" });
    const order = readResource(orderBody, "orders");
    if (order.id !== orderId) throw new Error("Lemon Squeezy returned a different order.");
    requireExpectedTestMode(order.attributes, this.#config.mode);
    requireConfiguredResource(order.attributes, "store_id", this.#config.storeId);
    return {
      orderId,
      status: parseOrderStatus(readString(order.attributes, "status")),
      total: readPositiveInteger(order.attributes, "total"),
      refundedAmount: readNonNegativeInteger(order.attributes, "refunded_amount"),
      updatedAt: readExactInstant(order.attributes, "updated_at"),
    };
  }

  async cancelSubscription(input: { subscriptionId: string }): Promise<void> {
    const subscriptionId = requireProviderId(input.subscriptionId, "subscription ID");
    const body = await this.#request(`/subscriptions/${subscriptionId}`, { method: "DELETE" });
    const subscription = readResource(body, "subscriptions");
    if (subscription.id !== subscriptionId) {
      throw new Error("Lemon Squeezy returned a different subscription.");
    }
    requireExpectedTestMode(subscription.attributes, this.#config.mode);
    const status = readString(subscription.attributes, "status");
    if (status !== "cancelled" && status !== "expired") {
      throw new Error("Lemon Squeezy subscription cancellation was not confirmed.");
    }
  }

  async #request(
    path: string,
    input: { method: "GET" | "POST" | "DELETE"; body?: unknown },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MILLISECONDS);
    try {
      const response = await this.#fetch(`${LEMON_SQUEEZY_API_BASE_URL}${path}`, {
        method: input.method,
        headers: {
          Accept: "application/vnd.api+json",
          Authorization: `Bearer ${this.#config.apiKey}`,
          "Content-Type": "application/vnd.api+json",
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Lemon Squeezy request failed with status ${response.status}.`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Lemon Squeezy request timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function isOpaqueCheckoutCorrelation(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function requiredSecret(value: string | undefined, label: string): string {
  if (!value || value.trim() !== value || value.length < 20 || value.length > 512) {
    throw new Error(`Lemon Squeezy ${label} is not configured safely.`);
  }
  return value;
}

function requiredProviderId(value: string | undefined, label: string): string {
  return requireProviderId(value ?? "", label);
}

function requireProviderId(value: string, label: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new Error(`Lemon Squeezy ${label} is invalid.`);
  }
  return value;
}

function requireRedirectUrl(value: string, mode: "test" | "live"): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(mode === "test" && url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password
  ) {
    throw new Error("Checkout return URL is invalid.");
  }
  return url.toString();
}

function requireExactFutureInstant(value: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) {
    throw new Error("Checkout expiry is invalid.");
  }
  return instant.toISOString();
}

function isLemonSqueezyCheckoutHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "lemonsqueezy.com" || normalized.endsWith(".lemonsqueezy.com");
}

function readResource(
  value: unknown,
  expectedType: string,
): {
  id: string;
  attributes: Record<string, unknown>;
  relationships: Record<string, unknown>;
} {
  const root = readRecord(value);
  const data = readRecord(root.data);
  const id = readString(data, "id");
  if (readString(data, "type") !== expectedType) {
    throw new Error("Lemon Squeezy returned an unexpected resource type.");
  }
  return {
    id,
    attributes: readRecord(data.attributes),
    relationships: readRecord(data.relationships),
  };
}

function requireRelationshipId(
  relationships: Record<string, unknown>,
  name: string,
  expected: string,
): void {
  const relationship = readRecord(relationships[name]);
  const data = readRecord(relationship.data);
  if (readString(data, "id") !== expected) {
    throw new Error(`Lemon Squeezy checkout ${name} does not match Bruno.Ai configuration.`);
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Lemon Squeezy returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Lemon Squeezy response field ${key} is invalid.`);
  }
  return value;
}

function readPositiveInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Lemon Squeezy response field ${key} is invalid.`);
  }
  return value as number;
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Lemon Squeezy response field ${key} is invalid.`);
  }
  return value as number;
}

function readExactInstant(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) {
    throw new Error(`Lemon Squeezy response field ${key} is invalid.`);
  }
  return instant.toISOString();
}

function readNullableExactInstant(record: Record<string, unknown>, key: string): string | null {
  if (record[key] === null) return null;
  return readExactInstant(record, key);
}

function requireExpectedTestMode(attributes: Record<string, unknown>, mode: "test" | "live"): void {
  if (attributes.test_mode !== (mode === "test")) {
    throw new Error("Lemon Squeezy resource mode does not match Bruno.Ai configuration.");
  }
}

function requireConfiguredResource(
  attributes: Record<string, unknown>,
  field: string,
  expected: string,
): void {
  const value = attributes[field];
  if ((typeof value === "number" ? String(value) : value) !== expected) {
    throw new Error(`Lemon Squeezy ${field} does not match Bruno.Ai configuration.`);
  }
}

function parseCommerceStatus(value: string): LemonSqueezyCommerceStatus {
  switch (value) {
    case "active":
    case "past_due":
    case "unpaid":
    case "cancelled":
    case "expired":
      return value;
    default:
      throw new Error("Lemon Squeezy subscription status is not eligible for Product Entitlement.");
  }
}

function parseOrderStatus(value: string): ReconciledLemonSqueezyOrder["status"] {
  switch (value) {
    case "pending":
    case "failed":
    case "paid":
    case "refunded":
    case "partial_refund":
    case "fraudulent":
      return value;
    default:
      throw new Error("Lemon Squeezy Order status is invalid.");
  }
}
