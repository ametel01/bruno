const SECRET_REDACTION_RULES: Array<[RegExp, string]> = [
  [
    /https:\/\/api\.telegram\.org\/bot\d{6,}:[A-Za-z0-9_-]{20,}\/[A-Za-z0-9_/-]+/g,
    "[redacted-telegram-url]",
  ],
  [/\bsk-or-v1-[A-Za-z0-9_-]+\b/g, "[redacted-openrouter-key]"],
  [/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-telegram-token]"],
  [/\bagb_(?:agent|reg|run)_[A-Za-z0-9_-]+\b/g, "[redacted-agentbay-token]"],
  [/(authorization\s*[:=]\s*Bearer\s+)[^\s,;]+/gi, "$1[redacted-bearer-token]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, "$1[redacted-bearer-token]"],
  [
    /\b(OPENROUTER_API_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_ALLOWED_USERS|API_SERVER_KEY)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/g,
    "$1=[redacted-env-value]",
  ],
  [/([?&](?:api[_-]?key|authorization|key|secret|token)=)[^&\s]+/gi, "$1[redacted-url-secret]"],
  [/agentbay-secret-canary-[A-Za-z0-9_-]+/g, "[redacted-secret-canary]"],
];

export function redactSecretText(value: string): string {
  return SECRET_REDACTION_RULES.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    value,
  );
}
