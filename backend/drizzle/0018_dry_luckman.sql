CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"kind" varchar(8) NOT NULL,
	"body" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"item_id" varchar(40),
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "events_kind_check" CHECK (kind IN ('image','video','html'))
);
--> statement-breakpoint
CREATE INDEX "idx_events_created" ON "events" USING btree ("created_at");