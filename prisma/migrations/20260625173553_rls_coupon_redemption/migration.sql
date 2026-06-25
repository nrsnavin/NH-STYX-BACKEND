-- Extend row-level security to coupon redemptions (customer-owned), matching
-- the policy style of migration `enable_rls`.
ALTER TABLE "CouponRedemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CouponRedemption" FORCE ROW LEVEL SECURITY;
CREATE POLICY coupon_redemption_tenant_isolation ON "CouponRedemption"
  USING (app_current_customer() IS NULL OR "customerId" = app_current_customer())
  WITH CHECK (app_current_customer() IS NULL OR "customerId" = app_current_customer());
