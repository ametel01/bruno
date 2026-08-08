import { isAuthorizedCronRequest, readCronSecretConfig } from "@/src/server/env";

export type WakeupOperatorAuthorizationDependencies = {
  readConfig?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
};

export function authorizeWakeupOperatorRequest(
  request: Request,
  dependencies: WakeupOperatorAuthorizationDependencies,
): Response | null {
  const config = (dependencies.readConfig ?? readCronSecretConfig)();
  if (!config.ok) {
    return wakeupOperatorErrorResponse(
      503,
      "wakeup_operator_configuration_invalid",
      "Wakeup operator access is not configured safely.",
    );
  }

  if (
    !(dependencies.authorize ?? isAuthorizedCronRequest)({
      authorizationHeader: request.headers.get("authorization"),
      secret: config.secret,
    })
  ) {
    return wakeupOperatorErrorResponse(
      401,
      "wakeup_operator_unauthorized",
      "Wakeup operator authorization is invalid.",
    );
  }

  return null;
}

export function wakeupOperatorErrorResponse(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers: wakeupNoStoreHeaders() });
}

export function wakeupNoStoreHeaders() {
  return { "Cache-Control": "no-store" };
}
