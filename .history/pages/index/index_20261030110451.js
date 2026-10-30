// 电动车续航计算器 - 小程序版
// 计算逻辑与桌面网页版保持一致，功率-速度曲线已用真实车辆数据校准
// (48V30Ah、电机额定约800W、实测满油门极速约55km/h)

const { maybeShowServiceTip } = require("../../utils/serviceTip");

const BATTERY_TYPES = [
  {
    key: "ternary",
    label: "三元锂",
    hint: "能量密度高、自重轻(48V30Ah约9kg)、内阻小；放电深度高(实测可用约95%)，耐低温好",
    energyDensity: 160, // Wh/kg，Pack成组能量密度
    batteryEff: 0.95, // 动态放电有效利用深度(DOD)
    tempFactors: [1.0, 0.92, 0.82, 0.68], // 适宜、凉爽、寒冷、极寒保持率
  },
  {
    key: "lfp",
    label: "磷酸铁锂",
    hint: "更安全、循环寿命长(2000+次)；但自重大(48V30Ah约16kg)、控制器欠压截断早(实测可用约88%)、极度怕冷",
    energyDensity: 90, // Wh/kg，磷酸铁锂成组能量密度(仅为三元锂的约56%)
    batteryEff: 0.88, // 动态大电流压降与控制器保护提前截断，实际可用约88%
    tempFactors: [0.98, 0.85, 0.68, 0.48], // 低温断崖式衰减！0℃仅剩68%，-10℃腰斩至48%
  },
  {
    key: "lead",
    label: "铅酸电池",
    hint: "极笨重(48V30Ah超40kg)、培克特效应显著(大电流容量腰斩)，实际可用仅约70%，冬天极差",
    energyDensity: 35, // Wh/kg
    batteryEff: 0.7, // 实际可用约70%
    tempFactors: [0.95, 0.8, 0.62, 0.42],
  },
];

const TEMPERATURE_OPTIONS = [
  { label: "☀️ 适宜 (25°C+)" },
  { label: "☁️ 凉爽 (10~25°C)" },
  { label: "❄️ 寒冷 (0~10°C)" },
  { label: "🧊 极寒 (-10°C)" },
];

const ROAD_OPTIONS = [
  { label: "🟢 畅通 (匀速巡航/国道)", value: 1.0 },
  { label: "🟡 少量启停 (郊区/少量红绿灯)", value: 0.92 },
  { label: "🟠 频繁启停 (市区拥堵)", value: 0.8 },
  { label: "🔴 高频启停 (外卖派送/暴力驾驶)", value: 0.7 },
];

// 车型定义：
// 1. 新国标轻型电动车：如九号 F2z 110 MAX、Nz/F 系列等，车身窄、坐姿紧凑，迎风面积 CdA≈0.38㎡；
//    法规限定电机标称额定 400W，但原厂 FOC 矢量控制器与电机支持 1000W~1200W 峰值释放。
// 2. 电摩/中型电摩：如九号 E200P、猎户座等，车身体量大、常跑高速，迎风阻力面积 CdA≈0.52㎡，标配 800W~2000W+ 电机。
const VEHICLE_TYPES = [
  {
    key: "compact",
    label: "新国标轻型电动车",
    hint: "新国标紧凑车身(如九号F2z110MAX等)，低滚阻长续航胎，人车迎风面积约0.38㎡",
    dragArea: 0.38,
    defaultRatedPower: 400,
  },
  {
    key: "moped",
    label: "电摩/中型电摩",
    hint: "车身体量大、迎风阻力大(如九号E200P等高速电摩)，迎风阻力面积约0.52㎡",
    dragArea: 0.52,
    defaultRatedPower: 1200,
  },
];

// 物理与动力学常数：
// 1. Crr 滚阻系数：九号 F2z 全系配备 RideyLONG 定制低滚阻复合硅配方轮胎，出厂标准冷态高胎压(2.5~2.8bar)，实测 Crr≈0.013
// 2. 空气密度：标准大气压下 1.2 kg/m³
const AIR_DENSITY = 1.2; // kg/m^3
const ROLLING_RESISTANCE_COEFF = 0.013; // Crr，两轮电动车定制低滚阻胎高胎压实测值
const GRAVITY = 9.8;
const REFERENCE_WEIGHT = 139.6; // 校准场景的整车有效重量(kg)，仅用于"综合能效"展示指标的参考基准

// 车载电气系统与电机基础底噪损耗：
// 1. BASE_IDLE_POWER (25W)：包含液晶仪表盘、行车灯、DC-DC转换器(48V转12V)、BMS与电控待机
// 2. MOTOR_NO_LOAD_LOSS (15W)：轮毂电机在25km/h基准车速下的空载铁损与机械轴承阻力
const BASE_IDLE_POWER = 25;
const MOTOR_NO_LOAD_LOSS = 15;

// 计算维持指定时速所消耗的【真实电池端电功率】(W)
// 包含：
// 1. 轮边净机械推力功 = (滚阻力 + 风阻力) × 速度
// 2. 现代FOC矢量电控与无刷永磁电机的高效转换特性
// 3. 车载电气系统与旋转铁损底噪
function estimateElectricalPower(
  speedKmh,
  effectiveWeight,
  dragArea,
  ratedPower,
) {
  const v = speedKmh / 3.6; // km/h -> m/s
  const rollingForce = ROLLING_RESISTANCE_COEFF * effectiveWeight * GRAVITY;
  const dragForce = 0.5 * AIR_DENSITY * dragArea * v * v;
  const mechanicalPower = (rollingForce + dragForce) * v;

  // 现代两轮电动车电机（如九号定制轮毂电机+FOC矢量控制器）特性：
  // 虽受法规限制标称额定 400W，但电机磁钢（如30H）与定子均按 1000W-1200W 峰值功率设计冗余。
  // 1. 低速轻载(P_mech < 160W): 效率从约 70% 逐步升至 82%；
  // 2. 主流输出区间(200W ~ 1000W): 效率维持在 83% ~ 86% 宽广平原；
  // 3. 极速超频(> 1000W): 效率依然保持在 80% ~ 83%，绝不会出现断崖式虚构热衰退。
  let motorEff;
  if (mechanicalPower < 160) {
    motorEff = 0.7 + 0.12 * (mechanicalPower / 160);
  } else if (mechanicalPower <= 1000) {
    motorEff =
      0.83 + 0.03 * (1 - Math.abs((mechanicalPower - 500) / 500) * 0.5);
  } else {
    motorEff = Math.max(0.8, 0.84 - 0.04 * ((mechanicalPower - 1000) / 500));
  }

  // 车载仪表/车灯底噪与随速度增加的轻微旋转铁损
  const speedFactor = Math.max(0.2, v / (25 / 3.6));
  const idleElectrical = BASE_IDLE_POWER + MOTOR_NO_LOAD_LOSS * speedFactor;

  const electricalPower = mechanicalPower / motorEff + idleElectrical;
  const loadRatio = Math.round(
    (mechanicalPower / Math.max(ratedPower || 400, 100)) * 100,
  );

  return {
    electricalPower: Math.round(electricalPower),
    mechanicalPower: Math.round(mechanicalPower),
    loadRatio: Math.min(999, loadRatio),
    motorEfficiency: Math.round(motorEff * 100),
  };
}

const MAX_VOLTAGE = 200; // V，覆盖到高性能电摩改装(96V/120V)之上
const MAX_AMP_HOURS = 300; // Ah，覆盖到大容量电摩电池包之上
const MAX_RATED_POWER = 20000; // W，覆盖到高性能电摩电机额定功率之上
const MAX_WEIGHT = 400; // kg，人+车架+货的合理上限（不含电池，电池重量单独估算）

function clampInput(raw, max) {
  const parsed = parseFloat(raw);
  let value = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  let display = raw;
  if (value > max) {
    value = max;
    display = String(max);
  }
  return { value, display };
}

// 已知目标电功率和整车重量，反推能维持的时速（二分查找）
function estimateSpeedForPower(
  targetElectricalPower,
  effectiveWeight,
  dragArea,
  ratedPower,
) {
  let lo = 3;
  let hi = 100;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const res = estimateElectricalPower(
      mid,
      effectiveWeight,
      dragArea,
      ratedPower,
    );
    if (res.electricalPower > targetElectricalPower) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return (lo + hi) / 2;
}

const ONBOARDING_STEPS = [
  {
    icon: "🔋",
    title: "第一步：电池核心",
    desc: "选电池类型(三元锂/磷酸铁锂/铅酸)，填电压和容量，电池重量会按能量密度自动帮你估算出来。",
  },
  {
    icon: "⚡",
    title: "第二步：动力与速度",
    desc: "设定电机额定功率(新国标标配400W)。巡航模式拖动速度条计算真实电耗；满油门模式推算极速与极限工况续航。",
  },
  {
    icon: "⚖️",
    title: "第三步：总载重要算上车架",
    desc: "「总载重」= 人 + 车架(不含电池) + 货，电池重量已经自动加过了不用重复填。气温、路况也会实际影响续航，按真实情况选就行。",
  },
  {
    icon: "📊",
    title: "第四步：看结果",
    desc: "顶部数字就是预估续航，下方显示百公里电耗与综合能效。所有数值都根据机电物理模型实时响应。",
  },
];

Page({
  data: {
    showOnboarding: false,
    onboardingStep: 0,
    onboardingSteps: ONBOARDING_STEPS,

    topSafeArea: 0, // 顶部安全距离(px)，避免内容被状态栏/胶囊按钮遮挡，onLoad 里动态计算

    batteryTypes: BATTERY_TYPES,
    batteryTypeIndex: 0,

    vehicleTypes: VEHICLE_TYPES,
    vehicleTypeIndex: 0,

    voltage: 48,
    voltageInput: "48",
    ampHours: 30,
    ampHoursInput: "30",

    motorRatedPower: 400, // 电机额定功率(W)，新国标出厂标称400W
    motorRatedPowerInput: "400",

    wotMode: false,
    speed: 25,
    power: 380, // 巡航模式下的真实耗电功率(W)，含机械阻力、电机损耗与车载底噪
    mechanicalPower: 260, // 轮边克服阻力净机械功(W)
    motorLoadRatio: 65, // 电机当前负载率(%)
    motorEfficiency: 81, // 电机当前效率(%)
    wotSpeedDisplay: "--",

    weight: 130,
    weightInput: "130",

    temperatureOptions: TEMPERATURE_OPTIONS,
    temperatureIndex: 0,
    roadOptions: ROAD_OPTIONS,
    roadIndex: 0,

    // 展示用的派生数据
    batteryWeight: "0.0",
    effectiveWeight: "0.0",
    totalEnergy: "0",
    usableEnergy: "0",
    usableEnergyRatio: 95,
    tempRetention: 100,
    resultKm: "0.0",
    whPerKmDisplay: "15.8",
    totalEfficiencyDisplay: "0",
    efficiencyText: "高效",
    rangeBarWidth: 0,
    rangeBarColor: "#34d399",
    rangeTitle: "预估巡航续航 Estimated Range",
    batteryTagLabel: "三元锂模式",
    isLead: false,
  },

  onLoad() {
    this.setupSafeArea();
    this.setupOnboarding();
    this.calculate();
  },

  onShow() {
    // 同步底部导航选中态（自定义 tabBar 需要页面主动通知）
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
  },

  onShareAppMessage() {
    return {
      title: "电动车续航计算器 - 填电池/电机参数，实时估算续航",
      path: "/pages/index/index",
    };
  },

  onShareTimeline() {
    return {
      title: "电动车续航计算器",
    };
  },

  setupSafeArea() {
    try {
      const menuButton = wx.getMenuButtonBoundingClientRect();
      this.setData({ topSafeArea: menuButton.top });
    } catch (e) {
      this.setData({ topSafeArea: 40 });
    }
  },

  setupOnboarding() {
    let hasSeen = false;
    try {
      hasSeen = wx.getStorageSync("hasSeenOnboarding");
    } catch (e) {
      hasSeen = false;
    }
    if (!hasSeen) {
      this.setData({ showOnboarding: true, onboardingStep: 0 });
    }
  },

  onOnboardingNext() {
    const isLastStep =
      this.data.onboardingStep >= this.data.onboardingSteps.length - 1;
    if (isLastStep) {
      this.finishOnboarding();
    } else {
      this.setData({ onboardingStep: this.data.onboardingStep + 1 });
    }
  },

  onOnboardingSkip() {
    this.finishOnboarding();
  },

  finishOnboarding() {
    this.setData({ showOnboarding: false });
    try {
      wx.setStorageSync("hasSeenOnboarding", true);
    } catch (e) {
      // 存储失败也没关系，最多下次再弹一次引导
    }
  },

  onSelectBatteryType(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ batteryTypeIndex: index });
    this.calculate();
  },

  onSelectVehicleType(e) {
    const index = Number(e.currentTarget.dataset.index);
    const vehicle = this.data.vehicleTypes[index];
    this.setData({
      vehicleTypeIndex: index,
      motorRatedPower: vehicle.defaultRatedPower,
      motorRatedPowerInput: String(vehicle.defaultRatedPower),
    });
    this.calculate();
  },

  onVoltageInput(e) {
    const { value, display } = clampInput(e.detail.value, MAX_VOLTAGE);
    this.setData({ voltageInput: display, voltage: value });
    this.calculate();
  },

  onAmpHoursInput(e) {
    const { value, display } = clampInput(e.detail.value, MAX_AMP_HOURS);
    this.setData({ ampHoursInput: display, ampHours: value });
    this.calculate();
  },

  onMotorRatedPowerInput(e) {
    const { value, display } = clampInput(e.detail.value, MAX_RATED_POWER);
    this.setData({
      motorRatedPowerInput: display,
      motorRatedPower: value,
    });
    this.calculate();
  },

  onWotModeChange(e) {
    this.setData({ wotMode: e.detail.value });
    this.calculate();
  },

  onSpeedChange(e) {
    this.setData({ speed: e.detail.value });
    this.calculate();
  },

  onWeightInput(e) {
    const { value, display } = clampInput(e.detail.value, MAX_WEIGHT);
    this.setData({ weightInput: display, weight: value });
    this.calculate();
  },

  onTemperatureChange(e) {
    this.setData({ temperatureIndex: Number(e.detail.value) });
    this.calculate();
  },

  onRoadChange(e) {
    this.setData({ roadIndex: Number(e.detail.value) });
    this.calculate();
  },

  computeEffectiveWeight() {
    const d = this.data;
    const typeConfig = d.batteryTypes[d.batteryTypeIndex];
    const totalEnergy = d.voltage * d.ampHours;
    const batteryWeight = totalEnergy / typeConfig.energyDensity;
    return d.weight + batteryWeight;
  },

  calculate() {
    const d = this.data;
    const typeConfig = d.batteryTypes[d.batteryTypeIndex];

    // 1. 电池容量与放电效率
    const totalEnergy = d.voltage * d.ampHours;
    const batteryEff = typeConfig.batteryEff;
    const usableEnergy = totalEnergy * batteryEff;

    // 1.5 电池重量估算（按能量密度反推）
    const energyDensity = typeConfig.energyDensity;
    const batteryWeight = totalEnergy / energyDensity;

    // 2. 整车有效重量与车型参数
    const effectiveWeight = this.computeEffectiveWeight();
    const vehicle = d.vehicleTypes[d.vehicleTypeIndex];
    const dragArea = vehicle.dragArea;
    const ratedPower = d.motorRatedPower || vehicle.defaultRatedPower;

    let speed;
    let electricalPower;
    let mechanicalPower;
    let motorLoadRatio;
    let motorEfficiency;
    let wotSpeedDisplay = d.wotSpeedDisplay;

    if (d.wotMode) {
      // 满油门模式：以电机额定功率持续全力输出，反推出平衡极速
      electricalPower = Math.max(ratedPower, 10);
      speed = estimateSpeedForPower(
        electricalPower,
        effectiveWeight,
        dragArea,
        ratedPower,
      );
      wotSpeedDisplay = speed.toFixed(1);
      const res = estimateElectricalPower(
        speed,
        effectiveWeight,
        dragArea,
        ratedPower,
      );
      mechanicalPower = res.mechanicalPower;
      motorLoadRatio = 100;
      motorEfficiency = res.motorEfficiency;
    } else {
      // 巡航模式：输入车速，结合真实风阻、滚阻、电机负载率效率曲线与电气底噪计算实际电耗
      speed = d.speed;
      const res = estimateElectricalPower(
        speed,
        effectiveWeight,
        dragArea,
        ratedPower,
      );
      electricalPower = res.electricalPower;
      mechanicalPower = res.mechanicalPower;
      motorLoadRatio = res.loadRatio;
      motorEfficiency = res.motorEfficiency;
    }
    // 防止除以 0
    electricalPower = Math.max(electricalPower, 10);

    // 3. 真实续航计算 (时间 = 可用能量 / 电池端实际输出电功率)
    // 根据电池化学体系专属计算温度保持率
    const tempFactor = typeConfig.tempFactors[d.temperatureIndex];
    const roadFactor = d.roadOptions[d.roadIndex].value;
    const tempRetention = Math.round(tempFactor * 100);

    const hours = usableEnergy / electricalPower;
    const range = hours * speed * tempFactor * roadFactor;

    // 百公里能耗 (Wh/km)
    const whPerKm = range > 0 ? usableEnergy / range : 0;

    // 系统综合能效参考
    const weightLoadFactor = REFERENCE_WEIGHT / Math.max(effectiveWeight, 1);
    const totalSystemEfficiency =
      batteryEff *
      tempFactor *
      roadFactor *
      weightLoadFactor *
      (motorEfficiency / 100) *
      100;

    let effText = "高效";
    if (totalSystemEfficiency < 45) effText = "极低 (损耗严重)";
    else if (totalSystemEfficiency < 65) effText = "一般";

    const maxRangeDisplay = 150;
    let percentage = (range / maxRangeDisplay) * 100;
    percentage = Math.min(100, Math.max(0, percentage));

    let barColor = "#34d399"; // emerald - 高续航
    if (range < 40)
      barColor = "#f43f5e"; // rose - 续航偏低
    else if (range < 70) barColor = "#fbbf24"; // amber - 一般

    this.setData({
      power: electricalPower,
      mechanicalPower: mechanicalPower,
      motorLoadRatio: motorLoadRatio,
      motorEfficiency: motorEfficiency,
      batteryWeight: batteryWeight.toFixed(1),
      effectiveWeight: effectiveWeight.toFixed(1),
      totalEnergy: totalEnergy.toFixed(0),
      usableEnergy: usableEnergy.toFixed(0),
      usableEnergyRatio: Math.round(batteryEff * 100),
      tempRetention: tempRetention,
      resultKm: range > 0 ? range.toFixed(1) : "0.0",
      whPerKmDisplay: whPerKm > 0 ? whPerKm.toFixed(1) : "0.0",
      totalEfficiencyDisplay: totalSystemEfficiency.toFixed(0),
      efficiencyText: effText,
      rangeBarWidth: percentage,
      rangeBarColor: barColor,
      rangeTitle: d.wotMode
        ? "满油门极限续航 Worst Case"
        : "预估巡航续航 Estimated Range",
      batteryTagLabel: typeConfig.label + "模式",
      isLead: typeConfig.key === "lead",
      wotSpeedDisplay: wotSpeedDisplay,
    });

    // 写入共享 storage，供「回本与租买计算器」带入单公里电耗
    try {
      wx.setStorageSync("rangeCalcSummary", {
        whPerKm: Math.round(whPerKm * 10) / 10,
        speed: speed,
        rangeKm: Math.round(range * 10) / 10,
        updatedAt: Date.now(),
      });
    } catch (e) {
      // 存储失败不影响计算
    }

    // 写入共享 storage，供「续航地图」读取满电续航与电耗
    try {
      wx.setStorageSync("rangeCalc", {
        fullRangeKm: Math.round(range * 10) / 10,
        whPerKm: Math.round(whPerKm * 10) / 10,
        batteryText: `${d.voltage}V ${d.ampHours}Ah ${typeConfig.label}`,
        vehicleText: vehicle.label,
        speed: speed,
        updatedAt: Date.now(),
      });
    } catch (e) {
      // 存储失败不影响计算
    }
  },
});
