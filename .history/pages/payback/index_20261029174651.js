// 外卖骑手「租车 / 买车」回本测算页
// 计算全部在 utils/rentbuy.js 中完成，本文件只负责交互与展示
const { calc, DEFAULTS, PRESET_PERCENTS } = require("../../utils/rentbuy");

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
    swapsPerDay: String(DEFAULTS.swapsPerDay),
    perOrderIncome: "",
    residualPercent: String(DEFAULTS.residualPercent),
  };
}

function defaultSwitches() {
  return {
    rentIncludesSwap: DEFAULTS.rentIncludesSwap,
    kmMode: DEFAULTS.kmMode,
    energyMode: DEFAULTS.energyMode,
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

function num1(value) {
  const num = Number(value);
  return (Number.isFinite(num) ? num : 0).toFixed(1);
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

Page({
  data: {
    topSafeArea: 0,
    presets: PRESETS,
    residualPreset: "normal",
    residualPercentValue: 25,

    form: defaultForm(),
    switches: defaultSwitches(),

    headline: "买车 -- 个月后回本",
    heroSub: "填写下方数据，实时测算",
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
    const res = this._last;
    if (res && res.paybackMonth) {
      return `我买车 ${res.paybackMonth} 个月回本，比租车省 ${money(
        res.savingsAtHold,
      )}，你算过吗？`;
    }
    return "我算了 60 个月，租车更划算，你算过吗？";
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
    if (payback) {
      headline = `买车 ${payback} 个月后回本`;
      heroSub =
        savings >= 0
          ? `按你填的数据测算，跑满 ${hold} 个月，买车比租车省约 ${money(savings)}`
          : `按你填的数据测算，跑满 ${hold} 个月，买车比租车多花约 ${money(-savings)}`;
    } else {
      headline = "60 个月内租车更划算";
      heroSub =
        savings >= 0
          ? `按你填的数据测算，跑满 ${hold} 个月，买车比租车省约 ${money(savings)}`
          : `按你填的数据测算，跑满 ${hold} 个月，租车比买车省约 ${money(-savings)}`;
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
          dailyKm: num1(res.dailyKm),
          monthlyKm: num1(res.monthlyKm),
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
    const chart = this._chart;
    if (!chart) return;
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
        ctx.fillText(`回本 ${payback} 个月`, x + (x > width - 60 ? -6 : 6), y - 6);
      }
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
    this.drawPoster(ctx, W, H);

    wx.showLoading({ title: "生成海报中", mask: true });
    wx.canvasToTempFilePath({
      canvas,
      x: 0,
      y: 0,
      width: W,
      height: H,
      destWidth: W * 2,
      destHeight: H * 2,
      success: (res) => {
        wx.hideLoading();
        this.savePoster(res.tempFilePath);
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: "生成失败，请重试", icon: "none" });
      },
    });
  },

  drawPoster(ctx, W, H) {
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
    ctx.fillText("外卖骑手 · 租车 / 买车 回本测算", 48, 92);

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
        value: res.paybackMonth ? `${res.paybackMonth} 个月` : "60 个月内不回本",
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

    // 曲线图
    ctx.fillStyle = "#334155";
    ctx.font = "bold 26px sans-serif";
    ctx.fillText("累计成本走势（0~36 个月）", 48, 596);

    // 图例
    const legend = [
      { color: "#f59e0b", text: "租车" },
      { color: "#3b82f6", text: "买车" },
    ];
    legend.forEach((item, index) => {
      const x = 470 + index * 100;
      ctx.beginPath();
      ctx.fillStyle = item.color;
      ctx.arc(x, 588, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#64748b";
      ctx.font = "22px sans-serif";
      ctx.fillText(item.text, x + 14, 596);
    });

    const box = { x: 48, y: 626, w: 482, h: 214 };
    ctx.strokeStyle = "#eef2f7";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i += 1) {
      const y = box.y + (box.h / 3) * i;
      ctx.beginPath();
      ctx.moveTo(box.x, y);
      ctx.lineTo(box.x + box.w, y);
      ctx.stroke();
    }

    let maxValue = 0;
    this.data.curve.forEach((point) => {
      maxValue = Math.max(maxValue, point.rent, point.buy);
    });
    maxValue = Math.max(maxValue * 1.05, 1);

    const xOf = (month) => box.x + (month / CHART_MONTHS) * box.w;
    const yOf = (value) => box.y + box.h * (1 - value / maxValue);

    const drawPosterLine = (key, color) => {
      ctx.beginPath();
      this.data.curve.forEach((point, index) => {
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
      const point = this.data.curve[payback];
      if (point) {
        const x = xOf(payback);
        const y = yOf(point.buy);
        ctx.beginPath();
        ctx.fillStyle = "#2563eb";
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1d4ed8";
        ctx.font = "bold 20px sans-serif";
        ctx.textAlign = x > box.x + box.w - 90 ? "right" : "left";
        ctx.fillText(
          `回本 ${payback} 个月`,
          x + (x > box.x + box.w - 90 ? -8 : 8),
          y - 12,
        );
        ctx.textAlign = "left";
      }
    }

    // 小程序码占位
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 2;
    ctx.strokeRect(566, 626, 132, 132);
    ctx.restore();
    ctx.fillStyle = "#94a3b8";
    ctx.font = "20px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("小程序码", 632, 790);
    ctx.textAlign = "left";

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
  },

  savePoster(filePath) {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        wx.showToast({ title: "海报已保存到相册", icon: "none" });
      },
      fail: (err) => {
        const message = (err && err.errMsg) || "";
        if (/auth|deny|cancel/i.test(message)) {
          wx.showModal({
            title: "需要相册权限",
            content: "保存海报需要访问相册，可在设置中开启。",
            confirmText: "去设置",
            success: (result) => {
              if (result.confirm) wx.openSetting();
            },
          });
        } else {
          wx.showToast({ title: "保存失败，请重试", icon: "none" });
        }
      },
    });
  },
});
