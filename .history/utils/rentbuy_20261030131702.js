// 骑士「租车 / 买车」回本测算 —— 纯计算逻辑
// 只做手动输入的计算，不涉及商家、品牌、平台，也不做任何撮合与交易引导。
// 约定：所有输入先经过 normalize() 校验；返回值中不会出现 NaN / Infinity。

// 残值三档（按车价的比例，%）
const PRESET_PERCENTS = {
  conservative: 15,
  normal: 25,
  optimistic: 40,
};

const DEFAULTS = {
  // 租车方案
  rentMonthly: 400, // 月租金（元）
  deposit: 500, // 押金（元）
  rentMonths: 24, // 租期（月）
  rentIncludesSwap: true, // 租金是否含电池 / 换电
  rentSwapFee: 0, // 含换电时，每月换电费用（元）
  rentMaintenance: 0, // 租车期间月均维修保养（元）

  // 买车方案
  vehiclePrice: 2500, // 车价（不含电池，元）
  batteryPrice: 1500, // 电池价格（元）
  oneTimeFee: 300, // 上牌 / 保险 / 杂费（一次性，元）
  buyMaintenance: 40, // 月均维修保养（元）
  batteryLife: 24, // 电池使用寿命（月）
  holdMonths: 24, // 持有期（月）

  // 使用情况
  kmMode: "orders", // km: 按每天公里数；orders: 按每天单量 × 平均单距
  dailyKm: 100, // 每天跑多少公里
  dailyOrders: 30, // 每天多少单
  avgOrderKm: 3.3, // 平均单距（km）
  workDays: 26, // 每月出勤天数
  electricityPrice: 1.0, // 电费单价（元/度）
  whPerKm: 11, // 单公里电耗（Wh/km）
  energyMode: "charge", // charge: 自己充电；swap: 外部换电
  swapPrice: 5, // 单次换电价格（元）
  swapsPerDay: 1, // 每天换电次数
  perOrderIncome: 5, // 每单到手收入（元/单），扣平台抽成后、未扣电费维修

  // 残值
  residualPreset: "normal", // conservative / normal / optimistic / custom
  residualPercent: 25, // 残值比例（%，基于车价）
};

// 输入范围限制：[最小值, 最大值]
const LIMITS = {
  rentMonthly: [0, 20000],
  deposit: [0, 100000],
  rentMonths: [1, 120],
  rentSwapFee: [0, 10000],
  rentMaintenance: [0, 10000],

  vehiclePrice: [0, 200000],
  batteryPrice: [0, 100000],
  oneTimeFee: [0, 50000],
  buyMaintenance: [0, 10000],
  batteryLife: [1, 120],
  holdMonths: [1, 120],

  dailyKm: [0, 500],
  dailyOrders: [0, 300],
  avgOrderKm: [0, 100],
  workDays: [0, 31],
  electricityPrice: [0, 20],
  whPerKm: [0, 200],
  swapPrice: [0, 200],
  swapsPerDay: [0, 50],
  perOrderIncome: [0, 1000],

  residualPercent: [0, 100],
};

const MONTH_MAX = 60; // 回本点遍历上限（月）
const CURVE_MONTHS = 36; // 折线图横轴上限（月）

function toNumber(raw, fallback) {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : fallback;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clampNumber(raw, key) {
  const fallback = DEFAULTS[key];
  const range = LIMITS[key] || [0, Number.MAX_SAFE_INTEGER];
  const value = toNumber(raw, fallback);
  return Math.min(range[1], Math.max(range[0], value));
}

function toBool(raw, fallback) {
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === 1 || raw === "1") return true;
  if (raw === "false" || raw === 0 || raw === "0") return false;
  return fallback;
}

// 校验并补全参数：空值 / 非法值一律回落到默认值
function normalize(input) {
  const src = input || {};
  const presetKey = Object.prototype.hasOwnProperty.call(
    PRESET_PERCENTS,
    src.residualPreset,
  )
    ? src.residualPreset
    : null;

  return {
    rentMonthly: clampNumber(src.rentMonthly, "rentMonthly"),
    deposit: clampNumber(src.deposit, "deposit"),
    rentMonths: clampNumber(src.rentMonths, "rentMonths"),
    rentIncludesSwap: toBool(src.rentIncludesSwap, DEFAULTS.rentIncludesSwap),
    rentSwapFee: clampNumber(src.rentSwapFee, "rentSwapFee"),
    rentMaintenance: clampNumber(src.rentMaintenance, "rentMaintenance"),

    vehiclePrice: clampNumber(src.vehiclePrice, "vehiclePrice"),
    batteryPrice: clampNumber(src.batteryPrice, "batteryPrice"),
    oneTimeFee: clampNumber(src.oneTimeFee, "oneTimeFee"),
    buyMaintenance: clampNumber(src.buyMaintenance, "buyMaintenance"),
    batteryLife: clampNumber(src.batteryLife, "batteryLife"),
    holdMonths: clampNumber(src.holdMonths, "holdMonths"),

    kmMode: src.kmMode === "orders" ? "orders" : "km",
    dailyKm: clampNumber(src.dailyKm, "dailyKm"),
    dailyOrders: clampNumber(src.dailyOrders, "dailyOrders"),
    avgOrderKm: clampNumber(src.avgOrderKm, "avgOrderKm"),
    workDays: clampNumber(src.workDays, "workDays"),
    electricityPrice: clampNumber(src.electricityPrice, "electricityPrice"),
    whPerKm: clampNumber(src.whPerKm, "whPerKm"),
    energyMode: src.energyMode === "swap" ? "swap" : "charge",
    swapPrice: clampNumber(src.swapPrice, "swapPrice"),
    swapsPerDay: clampNumber(src.swapsPerDay, "swapsPerDay"),
    perOrderIncome: clampNumber(src.perOrderIncome, "perOrderIncome"),

    residualPreset: presetKey || "custom",
    residualPercent: presetKey
      ? PRESET_PERCENTS[presetKey]
      : clampNumber(src.residualPercent, "residualPercent"),
  };
}

// 月能源成本（元/月）
// 充电：日公里 × Wh/km ÷ 1000 × 电价 × 出勤天数
// 换电：单次价格 × 每天次数 × 出勤天数
function calcMonthlyEnergy(p, dailyKm) {
  if (p.energyMode === "swap") {
    return p.swapPrice * p.swapsPerDay * p.workDays;
  }
  return (dailyKm * p.whPerKm) / 1000 * p.electricityPrice * p.workDays;
}

function round(value, digits) {
  const factor = Math.pow(10, digits === undefined ? 2 : digits);
  return Math.round(value * factor) / factor;
}

/**
 * 核心计算
 * @param {object} input 原始输入（可以是字符串，内部统一校验）
 * @returns {object} { params, paybackMonth, curve, compare, ... }
 */
function calc(input) {
  const p = normalize(input);

  // 1. 使用强度
  const dailyKm = p.kmMode === "orders" ? p.dailyOrders * p.avgOrderKm : p.dailyKm;
  const monthlyKm = dailyKm * p.workDays;

  // 2. 月能源成本
  const energyMonthly = calcMonthlyEnergy(p, dailyKm);

  // 3. 租车：月总成本 = 月租 + 维修 + 能源（含换电则按换电费，默认 0）
  const rentEnergy = p.rentIncludesSwap ? p.rentSwapFee : energyMonthly;
  const rentMonthly = p.rentMonthly + p.rentMaintenance + rentEnergy;

  // 4. 买车：初始投入 + 月成本 + 电池到期更换 − 残值
  const initialCost = p.vehiclePrice + p.batteryPrice + p.oneTimeFee;
  const buyMonthlyRecurring = energyMonthly + p.buyMaintenance;
  const residualRatio = p.residualPercent / 100;

  const residualAt = (month) =>
    p.vehiclePrice * residualRatio * Math.min(month / p.holdMonths, 1);
  const replacementCountAt = (month) => Math.floor(month / p.batteryLife);

  const buyCumulative = (month) =>
    initialCost +
    buyMonthlyRecurring * month +
    replacementCountAt(month) * p.batteryPrice -
    residualAt(month);

  const rentCumulative = (month) => rentMonthly * month;

  // 5. 回本点：1..60 月内，买车累计净成本首次低于租车
  let paybackMonth = null;
  for (let month = 1; month <= MONTH_MAX; month += 1) {
    if (buyCumulative(month) < rentCumulative(month)) {
      paybackMonth = month;
      break;
    }
  }

  // 6. 折线图数据 0..36 月
  const curve = [];
  for (let month = 0; month <= CURVE_MONTHS; month += 1) {
    curve.push({
      month,
      rent: round(rentCumulative(month), 2),
      buy: round(buyCumulative(month), 2),
    });
  }

  // 7. 对比表
  const perKm = (total, month) => {
    const km = monthlyKm * month;
    return km > 0 ? total / km : 0;
  };
  const hold = p.holdMonths;
  const rentAtHold = rentCumulative(hold);
  const buyAtHold = buyCumulative(hold);

  const pickBetter = (rentValue, buyValue) => {
    if (Math.abs(rentValue - buyValue) < 0.005) return "";
    return rentValue < buyValue ? "rent" : "buy";
  };

  const compare = {
    monthly: {
      rent: round(rentMonthly, 2),
      buy: round(buyMonthlyRecurring, 2),
      better: pickBetter(rentMonthly, buyMonthlyRecurring),
    },
    perKm: {
      rent: round(perKm(rentAtHold, hold), 3),
      buy: round(perKm(buyAtHold, hold), 3),
      better: pickBetter(perKm(rentAtHold, hold), perKm(buyAtHold, hold)),
    },
    t12: {
      rent: round(rentCumulative(12), 2),
      buy: round(buyCumulative(12), 2),
      better: pickBetter(rentCumulative(12), buyCumulative(12)),
    },
    t24: {
      rent: round(rentCumulative(24), 2),
      buy: round(buyCumulative(24), 2),
      better: pickBetter(rentCumulative(24), buyCumulative(24)),
    },
  };

  // 8. 保本单量（填了每单净收入才计算）
  let breakeven = null;
  if (p.perOrderIncome > 0) {
    const buyMonthlyAverage =
      (initialCost +
        replacementCountAt(hold) * p.batteryPrice -
        residualAt(hold)) /
        hold +
      buyMonthlyRecurring;
    breakeven = {
      perOrderIncome: p.perOrderIncome,
      rentOrders: Math.ceil(rentMonthly / p.perOrderIncome),
      buyOrders: Math.ceil(buyMonthlyAverage / p.perOrderIncome),
    };
  }

  // 9. 收入口径回本：买车投入 ÷ 每月净赚（跑单收入 − 能源 − 维修）
  //    单量在「按每天公里数」模式下用 里程 ÷ 平均单距 反推
  const ordersPerDay =
    p.kmMode === "orders"
      ? p.dailyOrders
      : p.avgOrderKm > 0
        ? dailyKm / p.avgOrderKm
        : 0;
  const monthlyIncome = ordersPerDay * p.perOrderIncome * p.workDays;
  const monthlyNetIncome = monthlyIncome - energyMonthly - p.buyMaintenance;
  const incomePaybackMonths =
    monthlyNetIncome > 0 ? initialCost / monthlyNetIncome : null;
  const income = {
    ordersPerDay: round(ordersPerDay, 1),
    monthlyIncome: round(monthlyIncome, 2),
    monthlyNetIncome: round(monthlyNetIncome, 2),
    paybackMonths: incomePaybackMonths === null ? null : round(incomePaybackMonths, 2),
    paybackDays:
      incomePaybackMonths === null ? null : round(incomePaybackMonths * 30.4, 1),
  };

  return {
    params: p,
    dailyKm: round(dailyKm, 2),
    monthlyKm: round(monthlyKm, 1),
    energyMonthly: round(energyMonthly, 2),
    rent: {
      monthly: round(rentMonthly, 2),
      energy: round(rentEnergy, 2),
      maintenance: p.rentMaintenance,
    },
    buy: {
      monthly: round(buyMonthlyRecurring, 2),
      initial: round(initialCost, 2),
      residualAtHold: round(residualAt(hold), 2),
      replacementCountAtHold: replacementCountAt(hold),
      replacementCostAtHold: round(replacementCountAt(hold) * p.batteryPrice, 2),
    },
    compare,
    totalsAtHold: {
      rent: round(rentAtHold, 2),
      buy: round(buyAtHold, 2),
      diff: round(rentAtHold - buyAtHold, 2),
    },
    // > 0 表示持有期结束时买车更省
    savingsAtHold: round(rentAtHold - buyAtHold, 2),
    paybackMonth,
    curve,
    depositLocked: round(p.deposit, 2),
    breakeven,
    income,
  };
}

module.exports = {
  calc,
  normalize,
  PRESET_PERCENTS,
  DEFAULTS,
  LIMITS,
  MONTH_MAX,
  CURVE_MONTHS,
};
