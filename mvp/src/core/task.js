/**
 * 归一化任务模型 + 状态机。
 * 不同 provider 的状态词不一样，对外只暴露这 4 个终态/中间态。
 */

/** 对外统一状态 */
export const Status = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
};

/** 已终态（不会再变化） */
export const TERMINAL = new Set([Status.SUCCEEDED, Status.FAILED]);

export const STATUS_LABEL_ZH = {
  queued: '排队中',
  processing: '处理中',
  succeeded: '已成功',
  failed: '已失败',
  unknown: '未知',
};

const ALIASES = {
  queued: Status.QUEUED,
  pending: Status.QUEUED,
  waiting: Status.QUEUED,
  submitted: Status.QUEUED,
  processing: Status.PROCESSING,
  running: Status.PROCESSING,
  generating: Status.PROCESSING,
  succeeded: Status.SUCCEEDED,
  success: Status.SUCCEEDED,
  completed: Status.SUCCEEDED,
  done: Status.SUCCEEDED,
  failed: Status.FAILED,
  error: Status.FAILED,
  cancelled: Status.FAILED,
  canceled: Status.FAILED,
};

/**
 * 把 provider 的原始状态词映射成统一状态。
 * 认不出来的原样小写返回，上层按 UNKNOWN 处理，不静默吞掉。
 */
export function normalizeStatus(raw) {
  if (raw == null) return Status.UNKNOWN;
  const key = String(raw).trim().toLowerCase();
  return ALIASES[key] ?? (Object.values(Status).includes(key) ? key : Status.UNKNOWN);
}

export function isTerminal(status) {
  return TERMINAL.has(status);
}

/**
 * 归一化任务对象。所有 provider 都返回这个形状，上层代码完全不用改。
 * @typedef {object} Task
 * @property {string} id            任务 ID
 * @property {string} status        Status 之一
 * @property {string} statusText    原始状态词（调试用）
 * @property {string|null} url      视频直链（成功后才有）
 * @property {string|null} error    失败原因
 * @property {string|null} notice   服务端提示（如排队预估、查询限频提示）
 * @property {number|null} charged  扣掉的积分
 * @property {string|null} createdAt
 * @property {boolean} canDelete
 * @property {object} raw           原始响应，出问题的时候查它
 */
export function normalizeTask(raw, { idHint = null } = {}) {
  const r = raw ?? {};
  const statusText = r.status ?? r.public_state ?? r.state ?? null;
  // 实测：未完成时这些字段是空字符串 ""，统一转成 null，别让上层拿到假值
  const orNull = (v) => (v == null || v === '' ? null : v);
  return {
    id: String(r.task_id ?? r.id ?? idHint ?? ''),
    status: normalizeStatus(statusText),
    statusText: statusText ? String(statusText) : null,
    url: orNull(r.url ?? r.video_url ?? r.result_url),
    error: orNull(r.error ?? r.public_error ?? r.message),
    notice: orNull(r.estimated_wait ?? r.query_notice),
    charged: r.charged_points != null ? Number(r.charged_points) : null,
    createdAt: r.created_at ?? r.createdAt ?? null,
    updatedAt: r.updated_at ?? null,
    billingState: orNull(r.billing_state),
    /** 服务端是否真的去上游查了一次（快速重复查询会是 false，走缓存） */
    refreshed: r.refreshed ?? null,
    canDelete: Boolean(r.can_delete),
    raw: r,
  };
}

/** 把各种形状的创建响应里的 task_id 挖出来；挖不到返回 null（调用方走列表 diff 兜底） */
export function extractTaskId(json) {
  if (!json || typeof json !== 'object') return null;
  const direct = ['task_id', 'taskId', 'id'];
  for (const k of direct) if (json[k] != null && json[k] !== '') return String(json[k]);
  for (const wrap of ['task', 'data', 'result', 'job']) {
    if (json[wrap] && typeof json[wrap] === 'object') {
      for (const k of direct) if (json[wrap][k] != null && json[wrap][k] !== '') return String(json[wrap][k]);
    }
  }
  return null;
}
