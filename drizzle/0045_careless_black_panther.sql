CREATE TYPE "public"."operator_conversation_message_role" AS ENUM('founder', 'operator');--> statement-breakpoint
CREATE TYPE "public"."operator_conversation_message_status" AS ENUM('complete', 'paused');--> statement-breakpoint
CREATE TYPE "public"."operator_conversation_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TYPE "public"."operator_conversation_work_state" AS ENUM('running', 'completed', 'paused', 'failed');--> statement-breakpoint
CREATE TABLE "operator_conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"work_id" uuid,
	"sequence" integer NOT NULL,
	"role" "operator_conversation_message_role" NOT NULL,
	"status" "operator_conversation_message_status" DEFAULT 'complete' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_conversation_messages_body_check" CHECK (length(trim("operator_conversation_messages"."body")) BETWEEN 1 AND 12000),
	CONSTRAINT "operator_conversation_messages_sequence_check" CHECK ("operator_conversation_messages"."sequence" >= 1)
);
--> statement-breakpoint
CREATE TABLE "operator_conversation_works" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"state" "operator_conversation_work_state" DEFAULT 'running' NOT NULL,
	"founder_message_id" uuid,
	"operator_message_id" uuid,
	"provider_connection_id" uuid,
	"recovery_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_conversation_works_request_id_check" CHECK (length(trim("operator_conversation_works"."request_id")) BETWEEN 1 AND 200),
	CONSTRAINT "operator_conversation_works_checkpoint_id_check" CHECK (length(trim("operator_conversation_works"."checkpoint_id")) BETWEEN 1 AND 240),
	CONSTRAINT "operator_conversation_works_recovery_message_check" CHECK ("operator_conversation_works"."state" IN ('paused', 'failed') OR "operator_conversation_works"."recovery_message" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "operator_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"status" "operator_conversation_status" DEFAULT 'active' NOT NULL,
	"next_sequence" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_conversations_next_sequence_check" CHECK ("operator_conversations"."next_sequence" >= 1)
);
--> statement-breakpoint
ALTER TABLE "operator_conversation_messages" ADD CONSTRAINT "operator_conversation_messages_conversation_id_operator_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."operator_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_conversation_messages" ADD CONSTRAINT "operator_conversation_messages_work_id_operator_conversation_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."operator_conversation_works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_conversation_works" ADD CONSTRAINT "operator_conversation_works_conversation_id_operator_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."operator_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_conversations" ADD CONSTRAINT "operator_conversations_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_conversation_messages_sequence_idx" ON "operator_conversation_messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "operator_conversation_messages_conversation_idx" ON "operator_conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_conversation_works_request_id_idx" ON "operator_conversation_works" USING btree ("conversation_id","request_id");--> statement-breakpoint
CREATE INDEX "operator_conversation_works_checkpoint_idx" ON "operator_conversation_works" USING btree ("conversation_id","checkpoint_id");--> statement-breakpoint
CREATE INDEX "operator_conversation_works_state_idx" ON "operator_conversation_works" USING btree ("conversation_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_conversations_operator_id_idx" ON "operator_conversations" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "operator_conversations_status_idx" ON "operator_conversations" USING btree ("status");