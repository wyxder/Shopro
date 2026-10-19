/**
 * 支付宝 AI 网页应用收款 - 前端统一 API
 * 约定：签名、验签、金额校验全部在 Edge Function 服务端完成，前端只负责：
 * 1) 下单获取支付表单 HTML；2) 渲染并提交表单跳转支付宝；3) 回跳后向服务端查询最终支付结果。
 * 严禁前端拼接网关 URL 或信任同步跳转参数判定支付成功。
 */
import { supabase } from '@/db/supabase';

export interface AlipayOrderResult {
  order_no: string;
  order_id: string;
  payment_html: string;
  plan_name: string;
  amount: string;
}

export interface AlipayQueryResult {
  order_no: string;
  local_status: string;
  trade_status: string;
  amount: string;
}

async function extractInvokeError(error: any): Promise<Error> {
  try {
    const text = await error?.context?.text?.();
    if (text) {
      const parsed = JSON.parse(text);
      return new Error(parsed.message || text);
    }
  } catch {
    // 非 JSON 响应体，退回原始 message
  }
  return new Error(error?.message || '支付服务请求失败');
}

/** 统一下单：服务端创建订单并返回 alipay.trade.page.pay 表单 HTML */
export async function createAlipayOrder(planId: string): Promise<AlipayOrderResult> {
  const { data, error } = await supabase.functions.invoke('alipay-payment-order', {
    body: { plan_id: planId },
  });
  if (error) throw await extractInvokeError(error);
  if (data?.code !== 0 || !data?.data) throw new Error(data?.message || '下单失败');
  return data.data as AlipayOrderResult;
}

/**
 * 拦截浏览器第三方插件（如 content-script）抛出的未捕获异常，防止其污染控制台或阻塞应用逻辑。
 * 典型报错：chrome-extension://... TypeError: Cannot read properties of undefined (reading 'indexOf')
 */
export function initExtensionErrorGuard(): void {
  if (typeof window === 'undefined') return;

  const isExtensionError = (err: any): boolean => {
    const stack = String(err?.stack || '');
    const msg = String(err?.message || err || '');
    return (
      stack.includes('chrome-extension://') ||
      msg.includes('chrome-extension://') ||
      msg.includes('checkExceptionProcess') ||
      stack.includes('checkExceptionProcess')
    );
  };

  window.addEventListener('error', (event) => {
    if (isExtensionError(event.error) || (event.filename && event.filename.startsWith('chrome-extension://'))) {
      event.preventDefault();
      event.stopPropagation();
      console.warn('[AlipayGuard] 已拦截第三方扩展内部异常，保护主流程正常运行:', event.message);
    }
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    if (isExtensionError(event.reason)) {
      event.preventDefault();
      event.stopPropagation();
      console.warn('[AlipayGuard] 已拦截第三方扩展未处理 Promise 拒绝:', event.reason);
    }
  }, true);
}

/**
 * 渲染支付宝 pageExec 生成的表单并自动提交，或直接处理网关重定向 URL。
 * 兼容两种支付调起响应：
 * 1) 直接网关 URL（https://openapi.alipay.com/gateway.do?...） -> 立即 window.location.href 跳转；
 * 2) 包含 <form action="..." method="post"> 的 HTML 字符串 -> 挂载至当前文档 DOM 并通过原型方法提交。
 */
export function renderAndSubmitAlipayForm(paymentHtml: string): void {
  if (!paymentHtml || typeof paymentHtml !== 'string') {
    throw new Error('未接收到支付宝支付凭据，请重试');
  }

  const trimmed = paymentHtml.trim();

  // 1. 若响应直接为 URL（如 GET 模式返回的网关地址），直接执行跳转
  if (/^https?:\/\//i.test(trimmed)) {
    window.location.href = trimmed;
    return;
  }

  // 2. 将 HTML 插入宿主文档 DOM 容器，避免 DOMParser 跨文档引起的节点上下文问题
  const container = document.createElement('div');
  container.id = `alipay-submit-container-${Date.now()}`;
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '-9999px';
  container.style.width = '1px';
  container.style.height = '1px';
  container.style.opacity = '0';
  container.style.pointerEvents = 'none';
  container.innerHTML = trimmed;
  document.body.appendChild(container);

  // 3. 查找并提交表单
  const form = container.querySelector('form');
  if (form) {
    try {
      // 强制使用 HTMLFormElement.prototype.submit，避免内部 input 具有 name="submit" 覆盖方法
      HTMLFormElement.prototype.submit.call(form);
      return;
    } catch (e) {
      console.warn('[Alipay] 原型 submit 调用异常，尝试原生 submit:', e);
      try {
        form.submit();
        return;
      } catch (err2) {
        console.warn('[Alipay] 原生 submit 也失败，将尝试提取 action 跳转:', err2);
      }
    }
  }

  // 4. 容错兜底：从表单或 HTML 中通过正则提取 action 或目标网关 URL
  const actionMatch = trimmed.match(/action=["'](https?:\/\/[^"']+)["']/i);
  if (actionMatch && actionMatch[1]) {
    window.location.href = actionMatch[1];
    return;
  }

  const urlMatch = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
  if (urlMatch && urlMatch[0]) {
    window.location.href = urlMatch[0];
    return;
  }

  throw new Error('支付表单解析失败，请重试');
}

/** 交易查询兜底：GET 参数必须拼接在 URL 上（.rules/supabase-edge-function-get-body） */
export async function queryAlipayOrder(orderNo: string): Promise<AlipayQueryResult> {
  const { data, error } = await supabase.functions.invoke(
    `alipay-trade-query?order_no=${encodeURIComponent(orderNo)}`,
    { body: {} },
  );
  if (error) throw await extractInvokeError(error);
  if (data?.code !== 0 || !data?.data) throw new Error(data?.message || '订单查询失败');
  return data.data as AlipayQueryResult;
}

/** 交易操作：退款 / 退款查询（管理员）/ 关闭交易（本人或管理员） */
export async function alipayTradeOps(params: {
  action: 'refund' | 'refundQuery' | 'close';
  order_no: string;
  refund_amount?: string;
  refund_reason?: string;
  out_request_no?: string;
}): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('alipay-trade-ops', {
    body: params,
  });
  if (error) throw await extractInvokeError(error);
  if (data?.code !== 0) throw new Error(data?.message || '交易操作失败');
  return (data.data ?? {}) as Record<string, unknown>;
}
