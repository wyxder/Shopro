/**
 * 积分与套餐相关统一 API
 */
import { supabase } from '@/db/supabase';
import { handleApiRequest, type ApiResponse } from './client';

export interface UserCreditsInfo {
  total: number;
  used: number;
  left: number;
  planName?: string;
  status?: string;
}

export async function fetchUserCredits(userId: string): Promise<ApiResponse<UserCreditsInfo>> {
  return handleApiRequest(async () => {
    const res = await supabase
      .from('user_plans')
      .select('credits_total, credits_used, status, plan:plans(name)')
      .eq('user_id', userId)
      .maybeSingle();

    if (res.error) {
      return { data: null, error: res.error };
    }

    const total = res.data?.credits_total ?? 20;
    const used = res.data?.credits_used ?? 0;
    const left = Math.max(0, total - used);
    const planName = (res.data as any)?.plan?.name || '免费版';

    return {
      data: {
        total,
        used,
        left,
        planName,
        status: res.data?.status || 'active',
      },
      error: null,
    };
  });
}

// ── 兑换码 / 卡券核销 ─────────────────────────────────────────────────────────
export type RedeemCode =
  | 'OK'
  | 'INVALID'
  | 'EXPIRED'
  | 'USED_UP'
  | 'ALREADY_REDEEMED'
  | 'NO_AUTH'
  | 'SYSTEM';

export interface RedeemCouponResult {
  success: boolean;
  creditsAdded: number;
  balance: number;
  message: string;
  code: RedeemCode;
}

/**
 * redeemCoupon - 兑换码核销（调用后端 SECURITY DEFINER RPC redeem_coupon）
 *
 * 服务端统一完成：券存在性/启用/有效期/总量/单用户重复核销校验 →
 * 为当前登录用户发放积分（user_plans.credits_total 增加）→
 * 写入 credit_logs 审计流水。客户端仅提交兑换码字符串，无法篡改到账金额。
 */
export async function redeemCoupon(code: string): Promise<RedeemCouponResult> {
  const trimmed = (code || '').trim();
  if (!trimmed) {
    return { success: false, creditsAdded: 0, balance: 0, message: '请输入兑换码', code: 'INVALID' };
  }

  const fallback = (code: RedeemCode): string =>
    ({
      INVALID: '兑换码无效',
      EXPIRED: '兑换码已过期',
      USED_UP: '该兑换码已被使用',
      ALREADY_REDEEMED: '该兑换码已被使用',
      NO_AUTH: '请先登录后再兑换',
      SYSTEM: '系统异常，请稍后重试',
      OK: '兑换成功',
    })[code];

  try {
    const { data, error } = await supabase.rpc('redeem_coupon', { p_code: trimmed });

    // RPC 传输层错误（网络/权限/函数缺失等）统一归一为系统异常，避免暴露内部细节
    if (error) {
      console.error('[redeemCoupon] RPC 调用失败:', error);
      return { success: false, creditsAdded: 0, balance: 0, message: fallback('SYSTEM'), code: 'SYSTEM' };
    }

    const res = data as
      | { ok?: boolean; credits_added?: number; balance?: number; error?: string; code?: RedeemCode }
      | null;

    if (res?.ok) {
      const added = Number(res.credits_added ?? 0);
      return {
        success: true,
        creditsAdded: added,
        balance: Number(res.balance ?? 0),
        message: `兑换成功，已为您到账 +${added} 积分`,
        code: 'OK',
      };
    }

    const failCode: RedeemCode = res?.code ?? 'SYSTEM';
    return {
      success: false,
      creditsAdded: 0,
      balance: 0,
      message: res?.error || fallback(failCode),
      code: failCode,
    };
  } catch (err) {
    console.error('[redeemCoupon] 核销过程产生异常:', err);
    return { success: false, creditsAdded: 0, balance: 0, message: fallback('SYSTEM'), code: 'SYSTEM' };
  }
}
