ALTER TABLE "party_sessions" ADD COLUMN "r2_key" text;--> statement-breakpoint
ALTER TABLE "party_sessions" ADD COLUMN "bytes" integer;--> statement-breakpoint
ALTER TABLE "party_sessions" ADD COLUMN "event_count" integer;--> statement-breakpoint
ALTER TABLE "party_sessions" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_party_sessions_expiry" ON "party_sessions" USING btree ("expires_at");