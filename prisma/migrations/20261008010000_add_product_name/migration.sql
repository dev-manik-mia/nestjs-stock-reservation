-- Add as nullable first so the migration succeeds on tables that already hold rows.
ALTER TABLE "Product" ADD COLUMN "name" VARCHAR(255);

-- Backfill existing products with a placeholder derived from their id; rename them afterwards.
UPDATE "Product" SET "name" = 'Product ' || "id"::text WHERE "name" IS NULL;

ALTER TABLE "Product" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "Product" ADD CONSTRAINT "product_name_not_blank" CHECK (btrim("name") <> '');
