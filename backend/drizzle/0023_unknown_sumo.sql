CREATE TABLE "gem_packs" (
	"id" varchar(24) PRIMARY KEY NOT NULL,
	"gems" integer NOT NULL,
	"price_paise" integer NOT NULL,
	"art" varchar(32) NOT NULL,
	"tag" varchar(24),
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_prices" (
	"item_id" varchar(48) PRIMARY KEY NOT NULL,
	"kind" varchar(12) NOT NULL,
	"currency" varchar(8),
	"price" bigint DEFAULT 0 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_prices_currency" CHECK ("item_prices"."currency" is null or "item_prices"."currency" in ('coin','gem')),
	CONSTRAINT "item_prices_price" CHECK ("item_prices"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_items" (
	"user_id" uuid NOT NULL,
	"item_id" varchar(48) NOT NULL,
	"currency" varchar(8),
	"price_paid" bigint DEFAULT 0 NOT NULL,
	"source" varchar(16) DEFAULT 'purchase' NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_items_user_id_item_id_pk" PRIMARY KEY("user_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "user_items" ADD CONSTRAINT "user_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_items_item" ON "user_items" USING btree ("item_id");