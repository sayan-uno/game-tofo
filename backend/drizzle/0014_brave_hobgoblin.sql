CREATE TABLE "party_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"room" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"roster" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "party_sessions_key_key" UNIQUE("key")
);
--> statement-breakpoint
CREATE INDEX "idx_party_sessions_room" ON "party_sessions" USING btree ("room","started_at");--> statement-breakpoint
CREATE INDEX "idx_party_sessions_started" ON "party_sessions" USING btree ("started_at");