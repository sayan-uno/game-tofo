CREATE TABLE "case_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" varchar(12) NOT NULL,
	"ref_id" text,
	"at_ms" integer,
	"body" text,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_items_kind_check" CHECK (kind IN ('report','note','replay','voice','moment','sanction','status'))
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" varchar(12) NOT NULL,
	"subject_user_id" uuid,
	"subject_uid" varchar(12) NOT NULL,
	"status" varchar(12) DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"assigned_to" text,
	"opened_by" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution" varchar(16),
	"resolution_note" text,
	CONSTRAINT "cases_ref_unique" UNIQUE("ref"),
	CONSTRAINT "cases_status_check" CHECK (status IN ('open','resolved'))
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(8) DEFAULT 'report' NOT NULL,
	"reporter_user_id" uuid,
	"reporter_uid" varchar(12) NOT NULL,
	"subject_user_id" uuid,
	"subject_uid" varchar(12) NOT NULL,
	"category" varchar(12) NOT NULL,
	"note" text,
	"match_key" text,
	"lobby_id" text,
	"case_id" uuid,
	"status" varchar(12) DEFAULT 'new' NOT NULL,
	"handled_by" text,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_kind_check" CHECK (kind IN ('report','appeal')),
	CONSTRAINT "reports_status_check" CHECK (status IN ('new','attached','dismissed'))
);
--> statement-breakpoint
ALTER TABLE "case_items" ADD CONSTRAINT "case_items_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_case_items_case" ON "case_items" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_cases_status" ON "cases" USING btree ("status","opened_at");--> statement-breakpoint
CREATE INDEX "idx_cases_subject" ON "cases" USING btree ("subject_uid");--> statement-breakpoint
CREATE INDEX "idx_reports_queue" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_reports_subject" ON "reports" USING btree ("subject_uid","created_at");--> statement-breakpoint
CREATE INDEX "idx_reports_reporter" ON "reports" USING btree ("reporter_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_reports_case" ON "reports" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reports_once" ON "reports" USING btree ("reporter_user_id","subject_uid","match_key") WHERE match_key is not null;