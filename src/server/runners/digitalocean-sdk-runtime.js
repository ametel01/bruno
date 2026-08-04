import {
  createDigitalOceanClient,
  DigitalOceanApiKeyAuthenticationProvider,
} from "@digitalocean/dots";
import { FetchRequestAdapter } from "@microsoft/kiota-http-fetchlibrary";

export function createDigitalOceanSdkClient(token, apiBaseUrl) {
  const authProvider = new DigitalOceanApiKeyAuthenticationProvider(token);
  const adapter = new FetchRequestAdapter(authProvider);

  if (apiBaseUrl) {
    adapter.baseUrl = apiBaseUrl.replace(/\/v2\/?$/, "");
  }

  const client = createDigitalOceanClient(adapter);

  return {
    v2: {
      droplets: {
        get: (input, context) =>
          sendJson(
            adapter,
            client.v2.droplets.toGetRequestInformation({
              queryParameters: { tagName: input.tagName, perPage: input.perPage },
            }),
            context,
          ),
        post: (body, context) =>
          sendJson(adapter, client.v2.droplets.toPostRequestInformation(body), context),
        byDroplet_id: (id) => ({
          get: (context) =>
            sendJson(
              adapter,
              client.v2.droplets.byDroplet_id(id).toGetRequestInformation(),
              context,
            ),
          delete: (context) =>
            sendNoContent(
              adapter,
              client.v2.droplets.byDroplet_id(id).toDeleteRequestInformation(),
              context,
            ),
        }),
      },
      account: {
        keys: {
          get: (context) =>
            sendJson(adapter, client.v2.account.keys.toGetRequestInformation(), context),
          post: (body, context) =>
            sendJson(adapter, client.v2.account.keys.toPostRequestInformation(body), context),
        },
      },
      firewalls: {
        get: (input, context) =>
          sendJson(
            adapter,
            client.v2.firewalls.toGetRequestInformation({
              queryParameters: { perPage: input.perPage },
            }),
            context,
          ),
        post: (body, context) =>
          sendJson(adapter, client.v2.firewalls.toPostRequestInformation(body), context),
        byFirewall_id: (id) => ({
          get: (context) =>
            sendJson(
              adapter,
              client.v2.firewalls.byFirewall_id(id).toGetRequestInformation(),
              context,
            ),
          delete: (context) =>
            sendNoContent(
              adapter,
              client.v2.firewalls.byFirewall_id(id).toDeleteRequestInformation(),
              context,
            ),
        }),
      },
      tags: {
        byTag_id: (tag) => ({
          resources: {
            post: (body, context) =>
              sendNoContent(
                adapter,
                client.v2.tags.byTag_id(tag).resources.toPostRequestInformation(body),
                context,
              ),
          },
        }),
      },
    },
  };
}

async function sendJson(adapter, requestInfo, context) {
  const response = await send(adapter, requestInfo, context);

  if (response.status === 204) {
    return undefined;
  }

  return response.json();
}

async function sendNoContent(adapter, requestInfo, context) {
  await send(adapter, requestInfo, context);
}

async function send(adapter, requestInfo, context) {
  const request = await adapter.convertToNativeRequest(requestInfo);
  const response = await fetch(buildUrl(requestInfo), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: context?.signal,
  });

  if (!response.ok) {
    throw await createDigitalOceanHttpError(response);
  }

  return response;
}

function buildUrl(requestInfo) {
  const pathParameters = requestInfo.pathParameters ?? {};
  let url = requestInfo.urlTemplate
    .replace("{+baseurl}", String(pathParameters.baseurl ?? "https://api.digitalocean.com"))
    .replace("{droplet_id}", encodeURIComponent(String(pathParameters.droplet_id ?? "")))
    .replace("{firewall_id}", encodeURIComponent(String(pathParameters.firewall_id ?? "")))
    .replace("{tag_id}", encodeURIComponent(String(pathParameters.tag_id ?? "")))
    .replace(/\{\?[^}]+\}/g, "");

  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(requestInfo.queryParameters ?? {})) {
    if (value !== undefined && value !== null) {
      searchParams.set(key, String(value));
    }
  }

  const query = searchParams.toString();

  if (query) {
    url = `${url}?${query}`;
  }

  return url;
}

async function createDigitalOceanHttpError(response) {
  const body = await response.text();
  const message = safeDigitalOceanErrorMessage(response.status, body);
  const error = new Error(message);
  error.statusCode = response.status;
  return error;
}

function safeDigitalOceanErrorMessage(status, body) {
  try {
    const parsed = JSON.parse(body);
    const message = typeof parsed.message === "string" ? parsed.message : null;

    return message
      ? `DigitalOcean API request failed with status ${status}: ${message}`
      : `DigitalOcean API request failed with status ${status}.`;
  } catch {
    return `DigitalOcean API request failed with status ${status}.`;
  }
}
