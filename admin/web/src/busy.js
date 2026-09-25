/**
 * 全局「有请求在飞」计数。
 *
 * 为什么需要：之前只有表格自己有 v-loading，一旦某个操作慢（dola 的浏览器探测、
 * 批量导入、维护任务动辄几十秒），用户屏幕上什么反馈都没有，不知道系统在干什么、
 * 也不知道该不该再点一次。
 *
 * 用法：api.js 在每个请求进出时各加减一次；AdminLayout 顶部的进度条绑 isBusy。
 * 不要在业务代码里手动调用 busyBegin/busyEnd —— 交给 api.js 统一管，
 * 否则漏配对会让进度条永远显示「加载中」。
 */
import { ref, computed } from 'vue';

/** 正在进行的请求数 */
export const pending = ref(0);

/** 是否有请求在飞（进度条 v-show 用它） */
export const isBusy = computed(() => pending.value > 0);

/** 给进度条 title 用的一句人话 */
export const busyText = computed(() => (pending.value ? `${pending.value} 个请求进行中` : ''));

export function busyBegin() {
  pending.value += 1;
}

/** 用 Math.max 兜底：万一有并发导致多减，也不会变成负数把进度条锁死 */
export function busyEnd() {
  pending.value = Math.max(0, pending.value - 1);
}
