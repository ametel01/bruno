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
        post: (body) => sendJson(adapter, client.v2.droplets.toPostRequestInformation(body)),
        byDroplet_id: (id) => ({
          delete: () =>
            sendNoContent(
              adapter,
              client.v2.droplets.byDroplet_id(id).toDeleteRequestInformation(),
            ),
        }),
      },
      firewalls: {
        post: (body) => sendJson(adapter, client.v2.firewalls.toPostRequestInformation(body)),
      },
      tags: {
        byTag_id: (tag) => ({
          resources: {
            post: (body) =>
              sendNoContent(
                adapter,
                client.v2.tags.byTag_id(tag).resources.toPostRequestInformation(body),
              ),
          },
        }),
      },
    },
  };
}

async function sendJson(adapter, requestInfo) {
  const response = await send(adapter, requestInfo);

  if (response.status === 204) {
    return undefined;
  }

  return response.json();
}

async function sendNoContent(adapter, requestInfo) {
  await send(adapter, requestInfo);
}

async function send(adapter, requestInfo) {
  const request = await adapter.convertToNativeRequest(requestInfo);
  const response = await fetch(buildUrl(requestInfo), {
    method: request.method,
    headers: request.headers,
    body: request.body,
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
