-- ==============================================================================
-- Migration 00029: 新增 3 张 50 积分兑换码
--
-- 背景：「积分管理与充值」弹窗内的「兑换码 / 卡券快速核销」目前仅有 VIP888（100 积分）
--       一张可用卡密，演示与联调时缺少中等面额的券，故补充 3 张 50 积分券。
--
-- 口径：不修改 00028 的 coupons 表结构与 redeem_coupon 核销逻辑，仅补充券库数据。
--       max_uses = 0（不限总量，便于多账号反复验证），per_user_limit = 1（每人限兑一次），
--       expires_at = NULL（永不过期），与 VIP888 保持一致。
-- ==============================================================================

INSERT INTO public.coupons (code, credits, description, max_uses, per_user_limit, expires_at, is_active)
VALUES
  ('VIP50A', 50, 'VIP50A 体验卡密 · 兑换到账 50 积分', 0, 1, NULL, true),
  ('VIP50B', 50, 'VIP50B 体验卡密 · 兑换到账 50 积分', 0, 1, NULL, true),
  ('VIP50C', 50, 'VIP50C 体验卡密 · 兑换到账 50 积分', 0, 1, NULL, true)
ON CONFLICT (code) DO NOTHING;
