-- Row-Level Security: isolate each shop owner's data at the database layer,
-- as defence-in-depth behind the application's store/owner scoping.
--
-- A request binds its customer via the `app.customer_id` GUC (see
-- src/lib/prisma.ts). The policies below treat an empty/unset GUC as
-- "full access", so trusted callers — staff, system jobs, migrations,
-- login/register — keep working unchanged. Only when a customer is bound do
-- the policies restrict every protected table to that customer's own rows.

-- ----------------------------------------------------------------------------
-- Order-number sequence
-- ----------------------------------------------------------------------------
-- Order numbers previously came from a global `SELECT count(*) FROM "Order"`,
-- which is both racy and wrong under RLS (a customer would only see their own
-- orders). A sequence is gap-free, concurrency-safe and unaffected by RLS.
DO $$
DECLARE next_start bigint;
BEGIN
  SELECT COALESCE(COUNT(*), 0) + 1 INTO next_start FROM "Order";
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS order_number_seq START WITH %s', next_start);
END $$;

-- ----------------------------------------------------------------------------
-- Tenant helper + policies
-- ----------------------------------------------------------------------------
-- The bound customer id, or NULL when unset/empty (the full-access path).
CREATE OR REPLACE FUNCTION app_current_customer() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.customer_id', true), '') $$;

-- Customer (own profile)
ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_tenant_isolation ON "Customer"
  USING (app_current_customer() IS NULL OR id = app_current_customer())
  WITH CHECK (app_current_customer() IS NULL OR id = app_current_customer());

-- Address
ALTER TABLE "Address" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Address" FORCE ROW LEVEL SECURITY;
CREATE POLICY address_tenant_isolation ON "Address"
  USING (app_current_customer() IS NULL OR "customerId" = app_current_customer())
  WITH CHECK (app_current_customer() IS NULL OR "customerId" = app_current_customer());

-- Cart
ALTER TABLE "Cart" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Cart" FORCE ROW LEVEL SECURITY;
CREATE POLICY cart_tenant_isolation ON "Cart"
  USING (app_current_customer() IS NULL OR "customerId" = app_current_customer())
  WITH CHECK (app_current_customer() IS NULL OR "customerId" = app_current_customer());

-- CartItem (scoped through its parent cart)
ALTER TABLE "CartItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CartItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY cartitem_tenant_isolation ON "CartItem"
  USING (app_current_customer() IS NULL OR EXISTS (
    SELECT 1 FROM "Cart" c WHERE c.id = "CartItem"."cartId"
      AND c."customerId" = app_current_customer()))
  WITH CHECK (app_current_customer() IS NULL OR EXISTS (
    SELECT 1 FROM "Cart" c WHERE c.id = "CartItem"."cartId"
      AND c."customerId" = app_current_customer()));

-- Order
ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;
CREATE POLICY order_tenant_isolation ON "Order"
  USING (app_current_customer() IS NULL OR "customerId" = app_current_customer())
  WITH CHECK (app_current_customer() IS NULL OR "customerId" = app_current_customer());

-- OrderItem (scoped through its parent order)
ALTER TABLE "OrderItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY orderitem_tenant_isolation ON "OrderItem"
  USING (app_current_customer() IS NULL OR EXISTS (
    SELECT 1 FROM "Order" o WHERE o.id = "OrderItem"."orderId"
      AND o."customerId" = app_current_customer()))
  WITH CHECK (app_current_customer() IS NULL OR EXISTS (
    SELECT 1 FROM "Order" o WHERE o.id = "OrderItem"."orderId"
      AND o."customerId" = app_current_customer()));

-- Payment (scoped through its parent order)
ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_tenant_isolation ON "Payment"
  USING (app_current_customer() IS NULL OR EXISTS (
    SELECT 1 FROM "Order" o WHERE o.id = "Payment"."orderId"
      AND o."customerId" = app_current_customer()))
  WITH CHECK (app_current_customer() IS NULL OR EXISTS (
    SELECT 1 FROM "Order" o WHERE o.id = "Payment"."orderId"
      AND o."customerId" = app_current_customer()));

-- WishlistItem
ALTER TABLE "WishlistItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WishlistItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY wishlist_tenant_isolation ON "WishlistItem"
  USING (app_current_customer() IS NULL OR "customerId" = app_current_customer())
  WITH CHECK (app_current_customer() IS NULL OR "customerId" = app_current_customer());
