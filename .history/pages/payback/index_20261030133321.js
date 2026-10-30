// 骑士「租车 / 买车」回本测算页
// 计算全部在 utils/rentbuy.js 中完成，本文件只负责交互与展示
const { calc, DEFAULTS, PRESET_PERCENTS } = require("../../utils/rentbuy");
const { maybeShowServiceTip } = require("../../utils/serviceTip");

const STORAGE_KEY = "paybackFormState";
const RANGE_STORAGE_KEY = "rangeCalcSummary";

const PRESETS = [
  { key: "conservative", label: "保守", percent: 15 },
  { key: "normal", label: "一般", percent: 25 },
  { key: "optimistic", label: "乐观", percent: 40 },
];

const CHART_MONTHS = 36;

function defaultForm() {
  return {
    rentMonthly: String(DEFAULTS.rentMonthly),
    deposit: String(DEFAULTS.deposit),
    rentMonths: String(DEFAULTS.rentMonths),
    rentSwapFee: String(DEFAULTS.rentSwapFee),
    rentMaintenance: String(DEFAULTS.rentMaintenance),
    vehiclePrice: String(DEFAULTS.vehiclePrice),
    batteryPrice: String(DEFAULTS.batteryPrice),
    oneTimeFee: String(DEFAULTS.oneTimeFee),
    buyMaintenance: String(DEFAULTS.buyMaintenance),
    batteryLife: String(DEFAULTS.batteryLife),
    holdMonths: String(DEFAULTS.holdMonths),
    dailyKm: String(DEFAULTS.dailyKm),
    dailyOrders: String(DEFAULTS.dailyOrders),
    avgOrderKm: String(DEFAULTS.avgOrderKm),
    workDays: String(DEFAULTS.workDays),
    electricityPrice: String(DEFAULTS.electricityPrice),
    whPerKm: String(DEFAULTS.whPerKm),
    swapPrice: String(DEFAULTS.swapPrice),
    swapMonthly: String(DEFAULTS.swapMonthly),
    swapsPerDay: String(DEFAULTS.swapsPerDay),
    perOrderIncome: String(DEFAULTS.perOrderIncome),
    residualPercent: String(DEFAULTS.residualPercent),
  };
}

function defaultSwitches() {
  return {
    rentIncludesSwap: DEFAULTS.rentIncludesSwap,
    kmMode: DEFAULTS.kmMode,
    energyMode: DEFAULTS.energyMode,
    swapMode: DEFAULTS.swapMode,
  };
}

// 金额：¥1,234（四舍五入到元）
function money(value) {
  const num = Number(value);
  const rounded = Math.round(Number.isFinite(num) ? Math.abs(num) : 0);
  const text = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return "¥" + text;
}

function money2(value) {
  const num = Number(value);
  return "¥" + (Number.isFinite(num) ? num : 0).toFixed(2);
}

// 整数就不带小数点：30 而不是 30.0
function numText(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return Number.isInteger(num) ? String(num) : String(Math.round(num * 10) / 10);
}

// 收入口径回本：不到 1 个月显示天数，1~24 个月显示月，更久显示年
function incomePaybackText(inc) {
  if (!inc || inc.paybackMonths === null || inc.paybackMonths <= 0) return "";
  const months = inc.paybackMonths;
  if (months < 1) return `约 ${Math.max(1, Math.ceil(inc.paybackDays))} 天`;
  if (months < 24) return `约 ${Math.round(months)} 个月`;
  return `约 ${(months / 12).toFixed(1)} 年`;
}

function formatAxis(value) {
  if (value >= 10000) {
    const n = value / 10000;
    return (Number.isInteger(n) ? n : n.toFixed(1)) + "万";
  }
  if (value >= 1000) {
    const n = value / 1000;
    return (Number.isInteger(n) ? n : n.toFixed(1)) + "k";
  }
  return String(Math.round(value));
}

function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const normalized = raw / base;
  let multiplier = 1;
  if (normalized > 5) multiplier = 10;
  else if (normalized > 2) multiplier = 5;
  else if (normalized > 1) multiplier = 2;
  return multiplier * base;
}

// 海报上的中文换行（按字符宽度逐字排）
function fillWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const content = String(text || "");
  const lines = [];
  let line = "";
  for (let i = 0; i < content.length; i += 1) {
    const test = line + content[i];
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = content[i];
      if (lines.length >= maxLines) break;
    } else {
      line = test;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillText(lines[i], x, y + i * lineHeight);
  }
  return lines.length;
}

// 海报上的小程序码：从「小程序后台 → 推广 → 小程序码」下载后放到 assets 目录即可自动绘制
const MINI_CODE_SRC = "../../assets/miniprogram-code.png";

// 加载图片用于 canvas 2d（失败返回 null，由调用方画占位）
function loadCanvasImage(canvas, src) {
  return new Promise((resolve) => {
    let image = null;
    try {
      image = canvas.createImage();
    } catch (e) {
      resolve(null);
      return;
    }
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

Page({
  data: {
    topSafeArea: 0,
    presets: PRESETS,
    residualPreset: "normal",
    residualPercentValue: 25,
    planTab: "rent",

    form: defaultForm(),
    switches: defaultSwitches(),

    headline: "买车 -- 个月后回本",
    heroSub: "填写下方数据，实时测算",
    heroAlt: "",
    paybackText: "--",
    chartMode: "income",
    compareRows: [],
    curve: [],
    paybackMonth: null,
    warnings: {
      deposit: "¥0",
      rentMonths: 0,
      batteryCount: 0,
      batteryCost: "¥0",
      oneTimeFee: "¥0",
    },
    breakeven: null,
    summary: {
      dailyKm: "0",
      monthlyKm: "0",
      energyMonthly: "¥0",
      rentMonthly: "¥0",
      buyMonthly: "¥0",
      residualAmount: "¥0",
      holdMonths: 0,
    },
    hasRangeData: false,
  },

  onLoad() {
    this.setupSafeArea();
    this.restoreState();
    this.checkRangeData();
    this.refresh();
  },

  onReady() {
    this.initChart();
  },

  onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    this.checkRangeData();
    maybeShowServiceTip();
  },

  onShareAppMessage() {
    return {
      title: this.buildShareTitle(),
      path: "/pages/payback/index",
    };
  },

  onShareTimeline() {
    return {
      title: this.buildShareTitle(),
    };
  },

  buildShareTitle() {
    const text = this.data.paybackText;
    if (text && text !== "--") {
      return `我买车${text}就回本，你算过吗？`;
    }
    return "算了 60 个月，租车更划算，你算过吗？";
  },

  setupSafeArea() {
    try {
      const menuButton = wx.getMenuButtonBoundingClientRect();
      this.setData({ topSafeArea: menuButton.top });
    } catch (e) {
      this.setData({ topSafeArea: 40 });
    }
  },

  checkRangeData() {
    let summary = null;
    try {
      summary = wx.getStorageSync(RANGE_STORAGE_KEY);
    } catch (e) {
      summary = null;
    }
    this.setData({ hasRangeData: !!(summary && summary.whPerKm) });
  },

  // ---------- 输入处理 ----------

  buildParams() {
    const f = this.data.form;
    const s = this.data.switches;
    return {
      rentMonthly: f.rentMonthly,
      deposit: f.deposit,
      rentMonths: f.rentMonths,
      rentIncludesSwap: s.rentIncludesSwap,
      rentSwapFee: f.rentSwapFee,
      rentMaintenance: f.rentMaintenance,

      vehiclePrice: f.vehiclePrice,
      batteryPrice: f.batteryPrice,
      oneTimeFee: f.oneTimeFee,
      buyMaintenance: f.buyMaintenance,
      batteryLife: f.batteryLife,
      holdMonths: f.holdMonths,

      kmMode: s.kmMode,
      dailyKm: f.dailyKm,
      dailyOrders: f.dailyOrders,
      avgOrderKm: f.avgOrderKm,
      workDays: f.workDays,
      electricityPrice: f.electricityPrice,
      whPerKm: f.whPerKm,
      energyMode: s.energyMode,
      swapMode: s.swapMode,
      swapMonthly: f.swapMonthly,
      swapPrice: f.swapPrice,
      swapsPerDay: f.swapsPerDay,
      perOrderIncome: f.perOrderIncome,

      residualPreset: this.data.residualPreset,
      residualPercent: f.residualPercent,
    };
  },

  onNumberInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ ["form." + field]: e.detail.value }, () => this.refresh());
  },

  onResidualInput(e) {
    this.setData(
      {
        "form.residualPercent": e.detail.value,
        residualPreset: "custom",
      },
      () => this.refresh(),
    );
  },

  onToggle(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ ["switches." + field]: e.detail.value }, () => this.refresh());
  },

  onSelectMode(e) {
    const { field, value } = e.currentTarget.dataset;
    if (!field || !value) return;
    this.setData({ ["switches." + field]: value }, () => this.refresh());
  },

  // 走势图切换：收入口径 / 成本对比
  onSelectChartMode(e) {
    const value = e.currentTarget.dataset.value;
    if (!value || value === this.data.chartMode) return;
    this.setData({ chartMode: value }, () => this.drawChart());
  },

  // 租车 / 买车方案切换
  onSelectPlan(e) {
    const value = e.currentTarget.dataset.value;
    if (!value || value === this.data.planTab) return;
    this.setData({ planTab: value });
  },

  onSelectPreset(e) {
    const { key } = e.currentTarget.dataset;
    if (!PRESET_PERCENTS[key]) return;
    this.setData(
      {
        residualPreset: key,
        "form.residualPercent": String(PRESET_PERCENTS[key]),
      },
      () => this.refresh(),
    );
  },

  // 从续航计算器读取共享 storage 里的单公里电耗
  onImportFromRange() {
    let summary = null;
    try {
      summary = wx.getStorageSync(RANGE_STORAGE_KEY);
    } catch (e) {
      summary = null;
    }
    if (!summary || !summary.whPerKm) {
      wx.showToast({ title: "请先到续航计算器算一次", icon: "none" });
      return;
    }
    this.setData(
      { "form.whPerKm": String(summary.whPerKm) },
      () => {
        this.refresh();
        wx.showToast({
          title: `已带入 ${summary.whPerKm} Wh/km`,
          icon: "none",
        });
      },
    );
  },

  onReset() {
    wx.showModal({
      title: "恢复默认值",
      content: "将清空当前所有填写内容，恢复为默认参数。",
      confirmText: "重置",
      success: (res) => {
        if (!res.confirm) return;
        this.setData(
          {
            form: defaultForm(),
            switches: defaultSwitches(),
            residualPreset: DEFAULTS.residualPreset,
            planTab: "rent",
          },
          () => {
            this.refresh();
            wx.showToast({ title: "已恢复默认值", icon: "none" });
          },
        );
      },
    });
  },

  // ---------- 计算与展示 ----------

  refresh() {
    const res = calc(this.buildParams());
    this._last = res;

    const params = res.params;
    const hold = params.holdMonths;
    const savings = res.savingsAtHold;
    const payback = res.paybackMonth;

    let headline;
    let heroSub;
    let heroAlt;
    const inc = res.income;
    const incomeText = incomePaybackText(inc);

    if (incomeText) {
      // 主结论：多久能把买车的钱挣回来
      // 单量模式直接说单量；公里模式把「里程 ÷ 单距」的折算过程写出来，避免黑箱
      const orderSource =
        params.kmMode === "km"
          ? `每天 ${numText(res.dailyKm)} km ÷ ${numText(
              params.avgOrderKm,
            )} km/单 ≈ ${numText(inc.ordersPerDay)} 单`
          : `每天 ${numText(inc.ordersPerDay)} 单`;
      headline = `买车${incomeText}回本`;
      heroSub = `${orderSource} × 每单 ${numText(
        params.perOrderIncome,
      )} 元 × ${params.workDays} 天，月净赚 ${money(inc.monthlyNetIncome)}`;
      heroAlt = payback
        ? `另一种算法：买车第 ${payback} 个月起，累计花费低于租车`
        : "另一种算法：60 个月内租车累计花费更低";
    } else {
      headline = payback
        ? `买车 ${payback} 个月后比租车划算`
        : "60 个月内租车更划算";
      heroSub = "填一下「每单到手收入」，就能算出多久挣回买车的钱";
      heroAlt = `跑满 ${hold} 个月，买车比租车${
        savings >= 0 ? "省" : "多花"
      }约 ${money(Math.abs(savings))}`;
    }

    const compareRows = [
      {
        label: "月总成本",
        rent: money(res.compare.monthly.rent),
        buy: money(res.compare.monthly.buy),
        better: res.compare.monthly.better,
      },
      {
        label: "每公里成本",
        rent: money2(res.compare.perKm.rent),
        buy: money2(res.compare.perKm.buy),
        better: res.compare.perKm.better,
      },
      {
        label: "12 个月累计",
        rent: money(res.compare.t12.rent),
        buy: money(res.compare.t12.buy),
        better: res.compare.t12.better,
      },
      {
        label: "24 个月累计",
        rent: money(res.compare.t24.rent),
        buy: money(res.compare.t24.buy),
        better: res.compare.t24.better,
      },
    ];

    this.setData(
      {
        headline,
        heroSub,
        heroAlt,
        paybackText: incomeText || "--",
        residualPercentValue: params.residualPercent,
        compareRows,
        curve: res.curve,
        paybackMonth: payback,
        warnings: {
          deposit: money(res.depositLocked),
          rentMonths: params.rentMonths,
          batteryCount: res.buy.replacementCountAtHold,
          batteryCost: money(res.buy.replacementCostAtHold),
          oneTimeFee: money(params.oneTimeFee),
        },
        breakeven: res.breakeven,
        summary: {
          dailyKm: numText(res.dailyKm),
          monthlyKm: numText(res.monthlyKm),
          energyMonthly: money(res.energyMonthly),
          rentMonthly: money(res.rent.monthly),
          buyMonthly: money(res.buy.monthly),
          residualAmount: money(res.buy.residualAtHold),
          holdMonths: hold,
        },
      },
      () => this.drawChart(),
    );

    this.persistState();
  },

  persistState() {
    try {
      wx.setStorageSync(STORAGE_KEY, {
        form: this.data.form,
        switches: this.data.switches,
        residualPreset: this.data.residualPreset,
      });
    } catch (e) {
      // 存储失败不影响使用
    }
  },

  restoreState() {
    let saved = null;
    try {
      saved = wx.getStorageSync(STORAGE_KEY);
    } catch (e) {
      saved = null;
    }
    if (!saved || !saved.form) return;

    const form = Object.assign(defaultForm(), saved.form);
    const switches = Object.assign(defaultSwitches(), saved.switches);
    let residualPreset = saved.residualPreset || DEFAULTS.residualPreset;
    if (!PRESET_PERCENTS[residualPreset]) residualPreset = "custom";
    if (PRESET_PERCENTS[residualPreset]) {
      form.residualPercent = String(PRESET_PERCENTS[residualPreset]);
    }
    this.setData({ form, switches, residualPreset });
  },

  // ---------- 折线图（Canvas 2D） ----------

  initChart() {
    const query = wx.createSelectorQuery().in(this);
    query
      .select("#lineChart")
      .fields({ node: true, size: true })
      .exec((res) => {
        const item = res && res[0];
        if (!item || !item.node) return;
        const canvas = item.node;
        const ctx = canvas.getContext("2d");
        let dpr = 2;
        try {
          const info = wx.getWindowInfo
            ? wx.getWindowInfo()
            : wx.getSystemInfoSync();
          dpr = info.pixelRatio || 2;
        } catch (e) {
          dpr = 2;
        }
        canvas.width = item.width * dpr;
        canvas.height = item.height * dpr;
        ctx.scale(dpr, dpr);
        this._chart = { canvas, ctx, width: item.width, height: item.height };
        this.drawChart();
      });
  },

  drawChart() {
    if (!this._chart) return;
    if (this.data.chartMode === "income") this.drawIncomeChart();
    else this.drawCostChart();
  },

  drawCostChart() {
    const chart = this._chart;
    const ctx = chart.ctx;
    const width = chart.width;
    const height = chart.height;
    const curve = this.data.curve || [];

    ctx.clearRect(0, 0, width, height);
    if (curve.length < 2) return;

    const padL = 46;
    const padR = 14;
    const padT = 18;
    const padB = 26;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const maxMonth = CHART_MONTHS;

    let maxValue = 0;
    curve.forEach((point) => {
      maxValue = Math.max(maxValue, point.rent, point.buy);
    });
    if (maxValue <= 0) maxValue = 100;
    const step = niceStep(maxValue / 4);
    const yMax = Math.ceil(maxValue / step) * step;

    const xOf = (month) => padL + (month / maxMonth) * plotW;
    const yOf = (value) => padT + plotH * (1 - value / yMax);

    // 横向网格 + 纵轴刻度
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let v = 0; v <= yMax + 0.001; v += step) {
      const y = yOf(v);
      ctx.strokeStyle = "#eef2f7";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = "#9ca3af";
      ctx.fillText(formatAxis(v), padL - 6, y);
    }

    // 横轴刻度
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#9ca3af";
    for (let m = 0; m <= maxMonth; m += 6) {
      ctx.fillText(String(m), xOf(m), padT + plotH + 8);
    }

    const drawLine = (key, color) => {
      ctx.beginPath();
      curve.forEach((point, index) => {
        const x = xOf(point.month);
        const y = yOf(point[key]);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    };

    drawLine("rent", "#f59e0b");
    drawLine("buy", "#3b82f6");

    // 回本点标记
    const payback = this.data.paybackMonth;
    if (payback && payback <= maxMonth) {
      const point = curve[payback];
      if (point) {
        const x = xOf(payback);
        const y = yOf(point.buy);
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = "#2563eb";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();
        ctx.restore();

        ctx.beginPath();
        ctx.fillStyle = "#2563eb";
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#1d4ed8";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = x > width - 60 ? "right" : "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(`第 ${payback} 个月起更省`, x + (x > width - 60 ? -6 : 6), y - 6);
      }
    }
  },

  // 收入口径：累计净赚爬到「买车投入」线的那一点就是回本
  drawIncomeChart() {
    const chart = this._chart;
    const res = this._last;
    if (!chart || !res) return;
    const ctx = chart.ctx;
    const width = chart.width;
    const height = chart.height;

    ctx.clearRect(0, 0, width, height);

    const monthlyNet = res.income ? res.income.monthlyNetIncome : 0;
    if (!(monthlyNet > 0)) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("填「每单到手收入」后显示回本走势", width / 2, height / 2);
      return;
    }

    const target = res.buy.initial;
    const payback = res.income.paybackMonths;
    const padL = 46;
    const padR = 14;
    const padT = 18;
    const padB = 26;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    // 横轴只画到回本点的 1.6 倍左右，否则回本点会挤在左下角
    const maxMonth = Math.min(
      CHART_MONTHS,
      Math.max(6, Math.ceil((payback || 6) * 1.6)),
    );
    const tickStep = maxMonth <= 6 ? 1 : maxMonth <= 15 ? 3 : 6;

    let maxValue = Math.max(monthlyNet * maxMonth, target);
    if (maxValue <= 0) maxValue = 100;
    const step = niceStep(maxValue / 4);
    const yMax = Math.ceil(maxValue / step) * step;

    const xOf = (month) => padL + (month / maxMonth) * plotW;
    const yOf = (value) => padT + plotH * (1 - value / yMax);

    // 横向网格 + 纵轴刻度
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let v = 0; v <= yMax + 0.001; v += step) {
      const y = yOf(v);
      ctx.strokeStyle = "#eef2f7";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = "#9ca3af";
      ctx.fillText(formatAxis(v), padL - 6, y);
    }

    // 横轴刻度
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#9ca3af";
    for (let m = 0; m <= maxMonth; m += tickStep) {
      ctx.fillText(String(m), xOf(m), padT + plotH + 8);
    }

    // 买车投入线
    const targetY = yOf(target);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padL, targetY);
    ctx.lineTo(padL + plotW, targetY);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "#d97706";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(`买车投入 ${money(target)}`, padL + plotW, targetY - 3);

    // 累计净赚
    ctx.beginPath();
    for (let m = 0; m <= maxMonth; m += 1) {
      const x = xOf(m);
      const y = yOf(monthlyNet * m);
      if (m === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // 回本点
    if (payback !== null && payback <= maxMonth) {
      const x = xOf(payback);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, targetY);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.fillStyle = "#2563eb";
      ctx.arc(x, targetY, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#1d4ed8";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(`${this.data.paybackText}回本`, x + 6, targetY + 6);
    }
  },

  // ---------- 分享海报 ----------

  generatePoster() {
    if (!this._last) return;
    const W = 750;
    const H = 1000;
    let canvas = null;
    try {
      canvas = wx.createOffscreenCanvas({ type: "2d", width: W, height: H });
    } catch (e) {
      canvas = null;
    }
    if (!canvas) {
      wx.showToast({ title: "当前环境不支持生成海报", icon: "none" });
      return;
    }

    const ctx = canvas.getContext("2d");
    wx.showLoading({ title: "生成海报中", mask: true });
    Promise.resolve(this.drawPoster(ctx, canvas, W, H))
      .then(
        () =>
          new Promise((resolve, reject) => {
            wx.canvasToTempFilePath({
              canvas,
              x: 0,
              y: 0,
              width: W,
              height: H,
              destWidth: W * 2,
              destHeight: H * 2,
              success: resolve,
              fail: reject,
            });
          })
      )
      .then((res) => {
        wx.hideLoading();
        this.savePoster(res.tempFilePath);
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: "生成失败，请重试", icon: "none" });
      });
  },

  // 返回 Promise：小程序码图片是异步加载的，加载完再导出
  drawPoster(ctx, canvas, W, H) {
    const res = this._last;
    const headline = this.data.headline;
    const heroSub = this.data.heroSub;

    // 背景
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);

    // 顶部深色区
    const gradient = ctx.createLinearGradient(0, 0, W, 520);
    gradient.addColorStop(0, "#1e293b");
    gradient.addColorStop(1, "#0f172a");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, 520);

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#93c5fd";
    ctx.font = "bold 24px sans-serif";
    ctx.fillText("骑士 · 租车 / 买车 回本测算", 48, 92);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 56px sans-serif";
    ctx.fillText(headline, 48, 186);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "26px sans-serif";
    fillWrappedText(ctx, heroSub, 48, 238, 654, 40, 2);

    // 三项关键指标
    const stats = [
      { label: "租车月成本", value: money(res.rent.monthly) },
      { label: "买车月成本", value: money(res.buy.monthly) },
      {
        label: "回本时间",
        value: this.data.paybackText !== "--" ? this.data.paybackText : "未填收入",
      },
    ];
    stats.forEach((stat, index) => {
      const x = 48 + index * 228;
      ctx.fillStyle = "#94a3b8";
      ctx.font = "22px sans-serif";
      ctx.fillText(stat.label, x, 418);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 34px sans-serif";
      ctx.fillText(stat.value, x, 466);
    });

    // 曲线图：有收入数据时画「累计净赚 vs 买车投入」，否则画租买成本对比
    const income = res.income;
    const useIncome = !!(
      income &&
      income.paybackMonths !== null &&
      income.monthlyNetIncome > 0
    );

    ctx.fillStyle = "#334155";
    ctx.font = "bold 26px sans-serif";
    ctx.fillText(
      useIncome
        ? "多久挣回买车钱（累计净赚）"
        : "租车 / 买车累计成本（对比口径）",
      48,
      596,
    );

    // 图例
    const legend = useIncome
      ? [
          { color: "#2563eb", text: "累计净赚" },
          { color: "#f59e0b", text: "买车投入" },
        ]
      : [
          { color: "#f59e0b", text: "租车" },
          { color: "#3b82f6", text: "买车" },
        ];
    const legendX = useIncome ? [404, 560] : [452, 552];
    legend.forEach((item, index) => {
      const x = legendX[index];
      ctx.beginPath();
      ctx.fillStyle = item.color;
      ctx.arc(x, 588, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#64748b";
      ctx.font = "22px sans-serif";
      ctx.fillText(item.text, x + 14, 596);
    });

    // 绘图区：左侧留纵轴刻度，底部留横轴刻度
    const plot = { x: 122, y: 632, w: 400, h: 162 };
    const plotBottom = plot.y + plot.h;

    const curve = this.data.curve || [];
    const target = res.buy.initial;
    // 收入口径时横轴只画到回本点的 1.6 倍左右，回本点才不会挤在左下角
    const axisMonths = useIncome
      ? Math.min(
          CHART_MONTHS,
          Math.max(6, Math.ceil((income.paybackMonths || 6) * 1.6)),
        )
      : CHART_MONTHS;
    const axisStep = axisMonths <= 6 ? 1 : axisMonths <= 15 ? 3 : 6;

    let maxValue;
    if (useIncome) {
      maxValue = Math.max(income.monthlyNetIncome * axisMonths, target);
    } else {
      maxValue = 0;
      curve.forEach((point) => {
        maxValue = Math.max(maxValue, point.rent, point.buy);
      });
    }
    if (maxValue <= 0) maxValue = 100;
    const yStep = niceStep(maxValue / 4);
    const yMax = Math.ceil(maxValue / yStep) * yStep;

    const xOf = (month) => plot.x + (month / axisMonths) * plot.w;
    const yOf = (value) => plotBottom - (value / yMax) * plot.h;

    // 横向网格 + 纵轴刻度
    ctx.font = "18px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let v = 0; v <= yMax + 0.001; v += yStep) {
      const y = yOf(v);
      ctx.strokeStyle = "#eef2f7";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(formatAxis(v), plot.x - 10, y);
    }
    // 纵轴单位
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("元", plot.x - 10, plot.y - 14);

    // 坐标轴
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.y - 8);
    ctx.lineTo(plot.x, plotBottom);
    ctx.lineTo(plot.x + plot.w, plotBottom);
    ctx.stroke();

    // 横轴刻度与刻度线
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let m = 0; m <= axisMonths; m += axisStep) {
      const x = xOf(m);
      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, plotBottom);
      ctx.lineTo(x, plotBottom + 6);
      ctx.stroke();
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(String(m), x, plotBottom + 12);
    }

    if (useIncome) {
      // 买车投入线
      const targetY = yOf(target);
      ctx.save();
      ctx.setLineDash([10, 6]);
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(plot.x, targetY);
      ctx.lineTo(plot.x + plot.w, targetY);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "#d97706";
      ctx.font = "18px sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(`买车投入 ${money(target)}`, plot.x + plot.w, targetY - 6);

      // 累计净赚
      ctx.beginPath();
      for (let m = 0; m <= axisMonths; m += 1) {
        const x = xOf(m);
        const y = yOf(income.monthlyNetIncome * m);
        if (m === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.stroke();

      // 回本点
      const pb = income.paybackMonths;
      if (pb <= CHART_MONTHS) {
        const x = xOf(pb);
        ctx.save();
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = "#2563eb";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, targetY);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
        ctx.restore();

        ctx.beginPath();
        ctx.fillStyle = "#2563eb";
        ctx.arc(x, targetY, 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#1d4ed8";
        ctx.font = "bold 20px sans-serif";
        ctx.textAlign = pb > 30 ? "right" : "left";
        ctx.textBaseline = "top";
        ctx.fillText(
          `${this.data.paybackText}回本`,
          x + (pb > 30 ? -10 : 10),
          targetY + 10,
        );
        ctx.textAlign = "left";
      }
    } else {
      const drawPosterLine = (key, color) => {
        ctx.beginPath();
        curve.forEach((point, index) => {
          const x = xOf(point.month);
          const y = yOf(point[key]);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        ctx.stroke();
      };
      drawPosterLine("rent", "#f59e0b");
      drawPosterLine("buy", "#3b82f6");

      const payback = this.data.paybackMonth;
      if (payback && payback <= CHART_MONTHS) {
        const point = curve[payback];
        if (point) {
          const x = xOf(payback);
          const y = yOf(point.buy);
          ctx.beginPath();
          ctx.fillStyle = "#2563eb";
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#1d4ed8";
          ctx.font = "bold 20px sans-serif";
          ctx.textAlign = x > plot.x + plot.w - 90 ? "right" : "left";
          ctx.textBaseline = "alphabetic";
          ctx.fillText(
            `第 ${payback} 个月起更省`,
            x + (x > plot.x + plot.w - 90 ? -8 : 8),
            y - 12,
          );
          ctx.textAlign = "left";
        }
      }
    }

    // 分隔线 + 页脚
    ctx.strokeStyle = "#eef2f7";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(48, 884);
    ctx.lineTo(702, 884);
    ctx.stroke();

    ctx.fillStyle = "#94a3b8";
    ctx.font = "20px sans-serif";
    fillWrappedText(
      ctx,
      "以上为按你填写数据的测算结果，仅供参考，以实际合同为准。",
      48,
      926,
      654,
      30,
      2,
    );

    // 小程序码
    const codeBox = { x: 566, y: 626, w: 132, h: 132 };
    return loadCanvasImage(canvas, MINI_CODE_SRC).then((image) => {
      if (image) {
        // 白底 + 居中，避免下载的码带透明边
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(codeBox.x, codeBox.y, codeBox.w, codeBox.h);
        ctx.drawImage(image, codeBox.x, codeBox.y, codeBox.w, codeBox.h);
      } else {
        this.drawCodePlaceholder(ctx, codeBox);
      }
      ctx.fillStyle = "#64748b";
      ctx.font = "18px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText("微信扫码", codeBox.x + codeBox.w / 2, codeBox.y + codeBox.h + 26);
      ctx.fillText("测算你的回本周期", codeBox.x + codeBox.w / 2, codeBox.y + codeBox.h + 52);
      ctx.textAlign = "left";
    });
  },

  // 没有小程序码图片时的虚线占位
  drawCodePlaceholder(ctx, box) {
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.restore();
    ctx.fillStyle = "#94a3b8";
    ctx.font = "18px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("小程序码", box.x + box.w / 2, box.y + box.h / 2);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  },

  savePoster(filePath) {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        wx.showToast({ title: "海报已保存到相册", icon: "none" });
        // 保存后自动弹出分享面板
        setTimeout(() => this.sharePoster(filePath), 600);
      },
      fail: (err) => {
        const message = (err && err.errMsg) || "";
        if (/auth|deny/i.test(message)) {
          wx.showModal({
            title: "未获得相册权限",
            content: "保存失败，可直接把海报分享给好友。",
            confirmText: "去分享",
            cancelText: "去设置",
            success: (result) => {
              if (result.confirm) this.sharePoster(filePath);
              else wx.openSetting();
            },
          });
        } else if (/cancel/i.test(message)) {
          // 用户取消保存，不打扰
        } else {
          wx.showToast({ title: "保存失败，可直接分享海报", icon: "none" });
          this.sharePoster(filePath);
        }
      },
    });
  },

  // 弹出微信的分享面板（基础库 2.14.3+）；低版本降级为预览长按转发
  sharePoster(filePath) {
    if (typeof wx.showShareImageMenu === "function") {
      wx.showShareImageMenu({
        path: filePath,
        fail: () => {
          // 用户取消或环境不支持，静默处理
        },
      });
      return;
    }
    wx.previewImage({
      urls: [filePath],
      current: filePath,
    });
  },
});
