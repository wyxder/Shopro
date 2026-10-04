-- ==============================================================================
-- Migration 00028: 兑换码 / 卡券核销体系（Coupons & Redemption）
--
-- 目标：为「积分管理与充值」弹窗的「兑换码 / 卡券快速核销」提供真实可用的后端核销能力。
-- 口径：与现有积分体系完全一致 —— 发放积分统一走 user_plans.credits_total 增加，
--       并同步写入 credit_logs 审计流水（type 必须落在 credit_logs_type_check 白名单内，
--       本迁移使用 'bonus'），顶部余额与积分明细经 Realtime / credits_changed 事件即时刷新。
--
-- 安全设计：
--   1. coupons / coupon_redemptions 均开启 RLS 且不下发任何 client 策略，
--      普通登录用户无法直读券库（防枚举/刷券）。
--   2. redeem_coupon 为 SECURITY DEFINER，仅接收兑换码字符串，
--      发放积分额度、可用性、有效期、重复核销等全部在服务端校验，客户端无法篡改金额。
--   3. FOR UPDATE 行锁串行化同券并发核销，杜绝「重复提交 / 超发」。
-- ==============================================================================

-- ── 1. 卡券主表 ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.coupons (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,                 -- 统一以大写存储，核销时按 upper(trim) 匹配
  credits        integer NOT NULL CHECK (credits > 0), -- 兑换成功新增的积分数
  description    text,                                 -- 展示于积分流水的说明文案
  max_uses       integer NOT NULL DEFAULT 0,           -- 总核销次数上限，0 = 不限
  per_user_limit integer NOT NULL DEFAULT 1,           -- 单用户可核销次数
  used_count     integer NOT NULL DEFAULT 0,           -- 已核销总次数
  expires_at     timestamptz,                          -- 过期时间，NULL = 永不过期
  is_active      boolean NOT NULL DEFAULT true,        -- 是否启用
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── 2. 核销审计表（记录谁在何时核销了哪张券、到账多少、余额几何）──────────────
CREATE TABLE IF NOT EXISTS public.coupon_redemptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id     uuid NOT NULL REFERENCES public.coupons(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code          text NOT NULL,
  credits       integer NOT NULL,
  balance_after integer,
  redeemed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coupon_redemptions_user_idx   ON public.coupon_redemptions(user_id);
CREATE INDEX IF NOT EXISTS coupon_redemptions_coupon_idx ON public.coupon_redemptions(coupon_id);

-- ── 3. 开启 RLS 且不下发任何 client 策略：仅 SECURITY DEFINER RPC 可访问 ───────
ALTER TABLE public.coupons            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupon_redemptions ENABLE ROW LEVEL SECURITY;

-- ── 4. 核销 RPC：服务端原子校验 + 发放积分 + 写审计流水 ────────────────────────
CREATE OR REPLACE FUNCTION public.redeem_coupon(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     uuid := auth.uid();
  v_code        text := upper(btrim(COALESCE(p_code, '')));
  v_coupon      public.coupons%ROWTYPE;
  v_user_uses   int;
  v_plan_id     uuid;
  v_total       int;
  v_used        int;
  v_balance     int;
BEGIN
  -- 4.0 必须登录
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'error', '请先登录后再兑换');
  END IF;

  -- 4.1 兑换码存在且启用
  IF v_code = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID', 'error', '兑换码无效');
  END IF;

  -- 锁定券行，串行化并发核销（防重复提交 / 超发）
  SELECT * INTO v_coupon FROM public.coupons WHERE code = v_code FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID', 'error', '兑换码无效');
  END IF;
  IF NOT v_coupon.is_active THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID', 'error', '兑换码无效');
  END IF;

  -- 4.2 是否过期
  IF v_coupon.expires_at IS NOT NULL AND v_coupon.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EXPIRED', 'error', '兑换码已过期');
  END IF;

  -- 4.3 总量是否已被核销完
  IF v_coupon.max_uses > 0 AND v_coupon.used_count >= v_coupon.max_uses THEN
    RETURN jsonb_build_object('ok', false, 'code', 'USED_UP', 'error', '该兑换码已被使用');
  END IF;

  -- 4.4 当前用户是否已达个人核销上限
  SELECT count(*) INTO v_user_uses
    FROM public.coupon_redemptions
   WHERE coupon_id = v_coupon.id AND user_id = v_user_id;
  IF v_user_uses >= v_coupon.per_user_limit THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_REDEEMED', 'error', '该兑换码已被使用');
  END IF;

  -- 4.5 发放积分：锁定并更新 user_plans.credits_total（与充值/退款口径一致）
  SELECT credits_total, credits_used INTO v_total, v_used
    FROM public.user_plans WHERE user_id = v_user_id FOR UPDATE;

  IF NOT FOUND THEN
    -- 兜底：极少数无套餐记录的用户，按「免费版」初始化并直接入账
    SELECT id INTO v_plan_id FROM public.plans WHERE name = '免费版' LIMIT 1;
    IF v_plan_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SYSTEM', 'error', '系统异常，请稍后重试');
    END IF;
    INSERT INTO public.user_plans (user_id, plan_id, credits_total, credits_used, status)
    VALUES (v_user_id, v_plan_id, v_coupon.credits, 0, 'active')
    RETURNING credits_total, credits_used INTO v_total, v_used;
  ELSE
    UPDATE public.user_plans
       SET credits_total = credits_total + v_coupon.credits,
           updated_at    = now()
     WHERE user_id = v_user_id
    RETURNING credits_total, credits_used INTO v_total, v_used;
  END IF;

  v_balance := GREATEST(0, v_total - v_used);

  -- 4.6 写积分审计流水（type='bonus' 落在白名单内，action 标记为券核销）
  INSERT INTO public.credit_logs (
    user_id, amount, type, action, description, credits_after, balance_after
  )
  VALUES (
    v_user_id, v_coupon.credits, 'bonus', 'coupon_redeem',
    COALESCE(v_coupon.description, '兑换码核销') || ' (' || v_coupon.code || ')',
    v_balance, v_balance
  );

  -- 4.7 写核销审计记录 + 累加券使用次数
  INSERT INTO public.coupon_redemptions (coupon_id, user_id, code, credits, balance_after)
  VALUES (v_coupon.id, v_user_id, v_coupon.code, v_coupon.credits, v_balance);

  UPDATE public.coupons
     SET used_count = used_count + 1, updated_at = now()
   WHERE id = v_coupon.id;

  RETURN jsonb_build_object(
    'ok', true,
    'credits_added', v_coupon.credits,
    'balance', v_balance,
    'redeemed_code', v_coupon.code
  );
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_coupon(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_coupon(text) TO authenticated, service_role;

-- ── 5. 种子数据：可直接用于验证的卡密 VIP888（兑换成功新增 100 积分）──────────
--    max_uses=0（不限总量，便于跨账号反复验证），per_user_limit=1（每人限兑一次），永不过期。
INSERT INTO public.coupons (code, credits, description, max_uses, per_user_limit, expires_at, is_active)
VALUES ('VIP888', 100, 'VIP888 体验卡密 · 兑换到账 100 积分', 0, 1, NULL, true)
ON CONFLICT (code) DO NOTHING;
