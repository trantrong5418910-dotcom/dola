/**
 * 模型 / 设置档位。Settings 2.0 目前为占位，参数由飞哥后续填。
 */
export const MODEL_PROFILES = Object.freeze({
  seedance_2_5: {
    id: 'seedance_2_5',
    label: 'Seedance 2.5',
    params: { /* 默认 Seedance 2.5 路径，无额外覆盖 */ },
  },
  seedance_2_0: {
    id: 'seedance_2_0',
    label: 'Seedance 2.0',
    params: { /* 专家 15 秒路径 */ },
  },
  settings_2_0: {
    id: 'settings_2_0',
    label: 'Settings 2.0',
    // 占位：后续由飞哥填写具体生成参数
    params: {},
  },
});

export function resolveModelProfile(id) {
  return MODEL_PROFILES[id] || MODEL_PROFILES.seedance_2_5;
}
