ALTER TABLE "mcp_account_access" ADD COLUMN "max_age_days" integer;--> statement-breakpoint
ALTER TABLE "mcp_account_access" ADD COLUMN "allow_attachments" boolean DEFAULT true NOT NULL;