CREATE TABLE "payment_hook_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"outcome" varchar(12) NOT NULL,
	"detail" text NOT NULL,
	"body" text NOT NULL,
	"amount_paise" integer,
	"upi_ref" text,
	"session_id" uuid,
	"uid" varchar(12),
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_hook_log_outcome" CHECK ("payment_hook_log"."outcome" in ('verified','unmatched','duplicate','ignored','rejected','malformed'))
);
--> statement-breakpoint
CREATE TABLE "payment_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"uid" varchar(12) NOT NULL,
	"username" text NOT NULL,
	"pack_id" varchar(24) NOT NULL,
	"gems" integer NOT NULL,
	"base_paise" integer NOT NULL,
	"amount_paise" integer NOT NULL,
	"collision_offset" integer DEFAULT 0 NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"grace_until" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"hook_id" bigint,
	"upi_ref" text,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_sessions_status" CHECK ("payment_sessions"."status" in ('pending','paid','approved','expired','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "payment_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"upi_id" text DEFAULT '' NOT NULL,
	"payee_name" text DEFAULT 'TOFO' NOT NULL,
	"hook_key" text DEFAULT '' NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_settings_singleton" CHECK ("payment_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" varchar(8) NOT NULL,
	"delta" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"reason" varchar(40) NOT NULL,
	"ref" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_ledger_currency" CHECK ("wallet_ledger"."currency" in ('coin','gem'))
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"coins" bigint DEFAULT 0 NOT NULL,
	"gems" bigint DEFAULT 0 NOT NULL,
	"spent_paise" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hooklog_created" ON "payment_hook_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_hooklog_outcome" ON "payment_hook_log" USING btree ("outcome","created_at");--> statement-breakpoint
CREATE INDEX "idx_hooklog_amount" ON "payment_hook_log" USING btree ("amount_paise","created_at");--> statement-breakpoint
CREATE INDEX "idx_paysess_created" ON "payment_sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_paysess_status" ON "payment_sessions" USING btree ("status","grace_until");--> statement-breakpoint
CREATE INDEX "idx_paysess_amount" ON "payment_sessions" USING btree ("amount_paise","grace_until");--> statement-breakpoint
CREATE INDEX "idx_paysess_user" ON "payment_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_sessions_upi_ref_key" ON "payment_sessions" USING btree ("upi_ref") WHERE "payment_sessions"."upi_ref" is not null;--> statement-breakpoint
CREATE INDEX "idx_ledger_user" ON "wallet_ledger" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "idx_ledger_created" ON "wallet_ledger" USING btree ("created_at");