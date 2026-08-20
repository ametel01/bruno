export const dynamic = "force-dynamic";

/**
 * The legacy agent terminal is intentionally retired. Full Hermes Setup is
 * available only through the Founder Troubleshooting boundary.
 */
export async function POST(
  _request?: Request,
  _context?: unknown,
  _dependencies?: unknown,
): Promise<Response> {
  return Response.json(
    {
      ok: false,
      error: {
        code: "troubleshooting_required",
        message: "Full Hermes Setup is available only from Founder Troubleshooting.",
      },
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
