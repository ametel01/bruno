ALTER TABLE "operator_ai_connection_receipts" DROP CONSTRAINT "operator_ai_connection_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "operator_ai_connections" DROP CONSTRAINT "operator_ai_connections_provider_check";--> statement-breakpoint
ALTER TABLE "operator_conversation_works" DROP CONSTRAINT "operator_conversation_works_provider_check";--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD COLUMN "provider_subject_id" text;--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD COLUMN "provider_account_label" text;--> statement-breakpoint
ALTER TABLE "operator_ai_connection_receipts" ADD CONSTRAINT "operator_ai_connection_receipts_provider_check" CHECK ("operator_ai_connection_receipts"."provider" IN ('openai', 'anthropic'));--> statement-breakpoint
ALTER TABLE "operator_ai_connections" ADD CONSTRAINT "operator_ai_connections_provider_check" CHECK ("operator_ai_connections"."provider" IN ('openai', 'anthropic'));--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD CONSTRAINT "operator_conversation_works_provider_subject_check" CHECK ("operator_conversation_works"."provider_subject_id" IS NULL OR length(trim("operator_conversation_works"."provider_subject_id")) BETWEEN 1 AND 200);--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD CONSTRAINT "operator_conversation_works_provider_account_label_check" CHECK ("operator_conversation_works"."provider_account_label" IS NULL OR length(trim("operator_conversation_works"."provider_account_label")) BETWEEN 1 AND 200);--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD CONSTRAINT "operator_conversation_works_provider_check" CHECK ("operator_conversation_works"."provider" IN ('openai', 'anthropic'));