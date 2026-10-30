// 全局配置：Key 与各类阈值集中在这里，方便统一调整
// 注意：小程序端无法真正保密 Key，请务必在腾讯位置服务后台为该 Key 设置
// 「WebService API」用途、绑定小程序 AppID，并开启额度告警。
module.exports = {
  // 腾讯位置服务 WebService Key（在 https://lbs.qq.com/dev/console/key/manage 申请）
  QQ_MAP_KEY: "PTJBZ-CPPWH-35TDP-WLTZB-5FCI5-3IFRX",
  // 该 Key 的 WebServiceAPI Secret Key（控制台勾选「SN 校验」后生成），用于计算 sig
  // 只有开启了 SN 校验才需要；留空则不带 sig 请求
  QQ_MAP_SK: "gIoJaloo1rNE98Ij0JNERKwsddWFQfUL",
  QQ_MAP_HOST: "https://apis.map.qq.com",

  // 续航圈
  CIRCLES: {
    count: 9, // 同心圆数量，越多渐变越细腻
    minAlpha: 0.12, // 最内圈透明度
    maxAlpha: 0.18, // 最外圈透明度
  },

  // 默认参数
  DEFAULTS: {
    soc: 80, // 当前电量 %
    reserve: 15, // 安全预留 %
    detourFactor: 70, // 绕路系数 70 = 0.7
    roundTrip: false,
  },

  RANGE_LIMITS: {
    fullRangeKm: [5, 300],
    soc: [5, 100],
    reserve: [0, 40],
    detourFactor: [60, 90],
  },

  // 补电推荐算法参数
  PLANNER: {
    sampleInterval: 3000, // 采样间隔（米）
    sampleMaxRatio: 0.15, // 采样间隔不超过可用续航的 15%
    searchRadius: 1000, // 站点搜索半径（米，腾讯接口上限 1000）
    maxDetour: 800, // 允许的最大垂距（米）
    maxStations: 3, // 最多推荐站数
    minGap: 800, // 与上一补电点的最小间距（米），避免刚出发就补电
    chargeTargetSoc: 0.8, // 充电补到 80%
    swapTargetSoc: 1, // 换电补到 100%
    swapMinutes: 3, // 换电耗时
    chargePowerW: 250, // 充电功率（瓦）
    positionPeak: 0.9, // 位置分峰值：可达范围的 90% 附近最优
    weights: {
      swap: { position: 0.35, detour: 0.2, type: 0.3, reliability: 0.15 },
      charge: { position: 0.35, detour: 0.2, type: 0.3, reliability: 0.15 },
      time: { position: 0.3, detour: 0.2, type: 0.35, reliability: 0.15 },
      detour: { position: 0.35, detour: 0.35, type: 0.15, reliability: 0.15 },
    },
    maxRequestsPerPlan: 15, // 单次规划请求上限
  },

  CACHE: {
    routeTtlMs: 10 * 60 * 1000, // 路线缓存 10 分钟
    poiTtlMs: 30 * 60 * 1000, // 站点缓存 30 分钟
    gridSize: 0.01, // 起点网格精度（约 1km）
    minMoveMeters: 200, // 位置变化小于该值不重绘
  },

  // 演示模式：还没有真实 POI 数据 / 没配 Key 时，用沿路的假站点看交互效果
  // 上线前务必保持 useMockStations: false（假站点不可用于真实出行）
  DEMO: {
    useMockStations: false,
  },
};
