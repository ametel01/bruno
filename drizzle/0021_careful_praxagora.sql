ALTER TYPE "public"."agent_secret_kind" ADD VALUE IF NOT EXISTS 'openai_api_key' BEFORE 'telegram_bot_token';--> statement-breakpoint
ALTER TYPE "public"."agent_secret_kind" ADD VALUE IF NOT EXISTS 'anthropic_api_key' BEFORE 'telegram_bot_token';
