ALTER TABLE "voice_recordings" ADD COLUMN "kind" varchar(8) DEFAULT 'track' NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_recordings" ADD COLUMN "offset_ms" integer;--> statement-breakpoint
ALTER TABLE "voice_recordings" ADD COLUMN "roster" jsonb;--> statement-breakpoint
ALTER TABLE "voice_recordings" ADD CONSTRAINT "voice_recordings_kind_check" CHECK (kind IN ('track','mix'));