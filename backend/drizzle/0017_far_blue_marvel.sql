CREATE TABLE "notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"body" text NOT NULL,
	"audience" varchar(12) NOT NULL,
	"uids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_by" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"expires_at" timestamp with time zone,
	CONSTRAINT "notices_audience_check" CHECK (audience IN ('everyone','online','players'))
);
--> statement-breakpoint
CREATE INDEX "idx_notices_sent" ON "notices" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "idx_notices_expiry" ON "notices" USING btree ("expires_at");