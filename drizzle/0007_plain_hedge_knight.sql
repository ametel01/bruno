ALTER TABLE "agents" ADD COLUMN "template_version" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "template_snapshot_json" jsonb;--> statement-breakpoint
UPDATE "agents"
SET
	"template_version" = '1.0.0',
	"template_snapshot_json" = CASE "template_key"
		WHEN 'research_agent' THEN '{"key":"research_agent","version":"1.0.0","name":"Research Agent","description":"Tracks a research question, gathers source notes, and produces concise summaries for later review.","defaultTools":["Web search","Notes","Summaries"],"defaultSchedule":"Manual","defaultSystemPrompt":"You are a Research Agent. Gather relevant information, keep source notes, and produce concise summaries. Do not take external actions or contact third parties. Ask for approval before using any integration or publishing output.","requiredIntegrations":[]}'::jsonb
		WHEN 'inbox_triage_agent' THEN '{"key":"inbox_triage_agent","version":"1.0.0","name":"Inbox Triage Agent","description":"Reviews incoming messages, groups them by urgency, and drafts response notes for operator review.","defaultTools":["Inbox review","Priority summary","Reply drafts"],"defaultSchedule":"Manual","defaultSystemPrompt":"You are an Inbox Triage Agent. Review message context, classify urgency, summarize requested action, and draft replies for human review. Do not send messages or change mailbox state without explicit approval.","requiredIntegrations":[]}'::jsonb
		WHEN 'github_issue_agent' THEN '{"key":"github_issue_agent","version":"1.0.0","name":"GitHub Issue Agent","description":"Reviews repository issues, summarizes context, and prepares triage notes for maintainers.","defaultTools":["Issue review","Reproduction checklist","Maintainer summary"],"defaultSchedule":"Manual","defaultSystemPrompt":"You are a GitHub Issue Agent. Review issue context, identify reproduction steps, blockers, and likely next actions, then prepare maintainer-facing triage notes. Do not change issues, labels, branches, or code without explicit approval.","requiredIntegrations":[]}'::jsonb
		WHEN 'social_content_agent' THEN '{"key":"social_content_agent","version":"1.0.0","name":"Social Content Agent","description":"Turns source notes or long-form updates into channel-specific post drafts and publishing checklists.","defaultTools":["Source notes","Post drafts","Publishing checklist"],"defaultSchedule":"Manual","defaultSystemPrompt":"You are a Social Content Agent. Convert approved source material into concise post drafts, variants, and publishing checklists. Do not publish or schedule posts without explicit approval.","requiredIntegrations":[]}'::jsonb
		ELSE jsonb_build_object(
			'key',
			"template_key",
			'version',
			'1.0.0',
			'name',
			"template_key",
			'description',
			'Legacy template metadata snapshot.',
			'defaultTools',
			'[]'::jsonb,
			'defaultSchedule',
			'Manual',
			'defaultSystemPrompt',
			'You are an AgentBay agent. Follow the operator instructions and keep responses concise.',
			'requiredIntegrations',
			'[]'::jsonb
		)
	END;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "template_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "template_snapshot_json" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "template_version" SET DEFAULT '1.0.0';--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "template_snapshot_json" SET DEFAULT '{"key":"research_agent","version":"1.0.0","name":"Research Agent","description":"Tracks a research question, gathers source notes, and produces concise summaries for later review.","defaultTools":["Web search","Notes","Summaries"],"defaultSchedule":"Manual","defaultSystemPrompt":"You are a Research Agent. Gather relevant information, keep source notes, and produce concise summaries. Do not take external actions or contact third parties. Ask for approval before using any integration or publishing output.","requiredIntegrations":[]}'::jsonb;
