/**
 * 提示词优化（常规风格，适合 Dola / Seedance 视频生成）
 *
 * 输入一段短提示词（如「风景」），输出更具体、有画面感的提示词，
 * 但不堆砌术语、不写成复杂分镜剧本。
 *
 * @example
 *   import { optimizeVideoPrompt } from './prompt-optimize.js';
 *   optimizeVideoPrompt('风景', { seconds: 15, ratio: '16:9' });
 */

const SCENE_HINTS = Object.freeze({
  风景: '开阔自然风景，远山与天空层次分明，光线柔和，镜头缓慢横移',
  城市: '城市街景，建筑与行人自然流动，傍晚暖光，镜头平稳推进',
  海边: '海岸线与海浪，天光反射在水面上，微风，镜头缓慢跟拍海平线',
  森林: '林间光影穿过树叶，地面有雾气，安静，镜头缓缓向前穿行',
  夜景: '夜间灯火与倒影，色温偏暖，氛围安静，镜头缓慢横移',
});

/**
 * @param {string} raw 用户原始提示词
 * @param {{ seconds?: number, ratio?: string, keepRaw?: boolean }} [opts]
 * @returns {{ original: string, optimized: string, seconds: number, ratio: string }}
 */
export function optimizeVideoPrompt(raw, opts = {}) {
  const original = String(raw ?? '').trim();
  const seconds = Number(opts.seconds) > 0 ? Number(opts.seconds) : 15;
  const ratio = String(opts.ratio || '16:9').trim() || '16:9';
  const seed = original || '风景';

  // 已足够具体（较长且含镜头/光影词）则只做轻量收尾，避免过度改写
  const alreadyRich = seed.length >= 24 && /(镜头|光|景|运镜|推进|横移|跟拍)/.test(seed);
  let core = seed;
  if (!alreadyRich) {
    const hintKey = Object.keys(SCENE_HINTS).find((key) => seed === key || seed.includes(key));
    const hint = hintKey ? SCENE_HINTS[hintKey] : `${seed}，画面清晰自然，主体明确，光线柔和`;
    core = seed === hintKey || SCENE_HINTS[seed]
      ? hint
      : `${seed}，${hint.includes(seed) ? hint.replace(seed, '').replace(/^，/, '') : '画面清晰，主体突出，光影自然'}`;
    // 去重逗号空白
    core = core.replace(/，{2,}/g, '，').replace(/\s+/g, ' ').trim();
  }

  const motion = seconds >= 15
    ? '整体节奏舒缓，避免突变切换'
    : '动作简洁连贯，避免大幅晃动';

  const optimized = [
    core,
    `画面比例 ${ratio}`,
    '写实风格，色彩自然，细节清楚',
    motion,
  ].join('，');

  return { original: seed, optimized, seconds, ratio };
}

/** 仅返回优化后的字符串，方便网关/脚本直接当 prompt 用 */
export function optimizeVideoPromptText(raw, opts = {}) {
  return optimizeVideoPrompt(raw, opts).optimized;
}

export default optimizeVideoPrompt;
