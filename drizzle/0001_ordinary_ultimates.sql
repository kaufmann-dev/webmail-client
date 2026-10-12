ALTER TYPE "public"."mail_provider" ADD VALUE 'exchange';--> statement-breakpoint
ALTER TABLE "mail_account" ADD COLUMN "server" text;--> statement-breakpoint
ALTER TABLE "mail_account" ADD COLUMN "username" text;