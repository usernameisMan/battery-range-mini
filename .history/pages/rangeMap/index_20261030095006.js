// 续航地图：状态机 A（未选目的地）/ B（已选目的地）/ C（规划补电）
// 地图与路线数据来自腾讯位置服务 WebService（wx.request -> apis.map.qq.com）
const config = require("../../config");
const geo = require("../../utils/geo");
const planner = require("../../utils/planner");
const qqmap = require("../../utils/qqmap");

const DEFAULT_CENTER = { latitude: 39.908823, longitude: 116.39747 };
const RESERVE_OPTIONS = [10, 15, 20, 30];
const PREFERENCES = [
  { key: "swap", label: "换电优先" },
  { key: "charge", label: "充电优先" },
  { key: "time", label: "省时间" },
  { key: "detour", label: "少绕路" },
];

// 续航圈配色：内圈绿 -> 中段黄 -> 外沿红
const CIRCLE_STOPS = [
  { t: 0, rgb: [82, 196, 26] }, // #52C41A
  { t: 0.55, rgb: [250, 219, 20] }, // #FADB14
  { t: 1, rgb: [255, 77, 79] }, // #FF4D4F
];

function stopColor(t) {
  const v = Math.max(0, Math.min(1, t));
  for (let i = 1; i < CIRCLE_STOPS.length; i += 1) {
    const a = CIRCLE_STOPS[i - 1];
    const b = CIRCLE_STOPS[i];
    if (v <= b.t) {
      const k = (v - a.t) / (b.t - a.t || 1);
      return [0, 1, 2].map((idx) => Math.round(a.rgb[idx] + (b.rgb[idx] - a.rgb[idx]) * k));
    }
  }
  return CIRCLE_STOPS[CIRCLE_STOPS.length - 1].rgb;
}

function rgba(rgb, alpha) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)})`;
}

// 按里程区间截取路线折线（两端用插值点补齐）
function sliceRoute(points, cum, from, to) {
  const total = cum[cum.length - 1];
  const start = Math.max(0, Math.min(Number(from) || 0, total));
  const end = Math.max(start, Math.min(Number(to) || 0, total));
  const list = [geo.pointAtDistance(points, cum, start)];
  for (let i = 0; i < points.length; i += 1) {
    if (cum[i] > start && cum[i] < end) list.push(points[i]);
  }
  list.push(geo.pointAtDistance(points, cum, end));
  return list;
}

Page({
  data: {
    topSafeArea: 40,
    // 地图
    center: DEFAULT_CENTER,
    scale: 12,
    showLocation: false,
    markers: [],
    polylines: [],
    circles: [],
    // 续航口径
    hasRangeCalc: false,
    fullRangeKm: 0,
    fullRangeInput: "",
    whPerKm: 0,
    batteryText: "",
    soc: config.DEFAULTS.soc,
    reserve: config.DEFAULTS.reserve,
    reserveOptions: RESERVE_OPTIONS,
    detourFactor: config.DEFAULTS.detourFactor,
    roundTrip: config.DEFAULTS.roundTrip,
    showAdvanced: false,
    realKm: "0.0",
    theoryKm: "0.0",
    // 状态机
    stage: "idle", // idle | route
    destination: null,
    routeInfo: null,
    hintVisible: false,
    loadingRoute: false,
    // 底部补电卡片
    sheetVisible: false,
    sheetCollapsed: false,
    sheetMode: "", // suggest | plan
    sheetTitle: "",
    sheetDesc: "",
    planning: false,
    planStations: [],
    planMessage: "",
    planFeasible: false,
    preferences: PREFERENCES,
    preference: "swap",
    // 其他
    showPrivacy: false,
    locationDenied: false,
    errorText: "",
    privacyText:
      "位置仅用于计算续航范围与路线，不上传、不存储轨迹；补电点数据来自地图服务，是否可用以现场为准。",
  },

  onLoad() {
    this.setupSafeArea();
    this.setupPrivacy();
    this.loadRangeCalc();
    this.refreshDerived();
    let acked = false;
    try {
      acked = !!wx.getStorageSync("rangeMapPrivacyAck");
    } catch (e) {
      acked = false;
    }
    if (acked) this.ensureLocation(true);
    else this.setData({ showPrivacy: true });
  },

  onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    // 从计算器返回时同步最新续航参数
    this.loadRangeCalc();
    this.refreshDerived();
    this.ensureLocation(false);
  },

  onUnload() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
  },

  setupSafeArea() {
    try {
      const menuButton = wx.getMenuButtonBoundingClientRect();
      this.setData({ topSafeArea: menuButton.top });
    } catch (e) {
      this.setData({ topSafeArea: 40 });
    }
  },

  // 隐私：首次进入用自绘说明，同意后走微信官方隐私授权
  setupPrivacy() {
    if (typeof wx.onNeedPrivacyAuthorization === "function") {
      wx.onNeedPrivacyAuthorization((resolve) => {
        this._privacyResolve = resolve;
        this.setData({ showPrivacy: true });
      });
    }
  },

  onPrivacyAgree() {
    try {
      wx.setStorageSync("rangeMapPrivacyAck", 1);
    } catch (e) {
      // 存储失败不影响本次使用
    }
    const resolve = this._privacyResolve;
    this._privacyResolve = null;
    this.setData({ showPrivacy: false });
    if (resolve) resolve({ buttonId: "privacy-agree", event: "agree" });
    this.ensureLocation(true);
  },

  onPrivacyReject() {
    const resolve = this._privacyResolve;
    this._privacyResolve = null;
    this.setData({
      showPrivacy: false,
      locationDenied: true,
      errorText: "未授权位置，可手动选择起点",
    });
    if (resolve) resolve({ buttonId: "privacy-reject", event: "disagree" });
  },

  // 读取续航计算结果；兼容旧版 rangeCalcSummary
  loadRangeCalc() {
    let calc = null;
    try {
      calc = wx.getStorageSync("rangeCalc");
    } catch (e) {
      calc = null;
    }
    if (!calc || !calc.fullRangeKm) {
      let summary = null;
      try {
        summary = wx.getStorageSync("rangeCalcSummary");
      } catch (e) {
        summary = null;
      }
      if (summary && summary.rangeKm) {
        calc = {
          fullRangeKm: summary.rangeKm,
          whPerKm: summary.whPerKm || 0,
          batteryText: "来自续航计算器",
          vehicleText: "",
        };
      }
    }
    if (calc && Number(calc.fullRangeKm) > 0) {
      const fullRangeKm = Math.round(Number(calc.fullRangeKm) * 10) / 10;
      this.setData({
        hasRangeCalc: true,
        fullRangeKm,
        fullRangeInput: String(fullRangeKm),
        whPerKm: Number(calc.whPerKm) || 0,
        batteryText: calc.batteryText || "",
      });
    } else if (!this.data.hasRangeCalc && !this._manualFullRange) {
      this.setData({ hasRangeCalc: false, fullRangeKm: 0, fullRangeInput: "" });
    }
  },

  onFullRangeInput(e) {
    const raw = String(e.detail.value || "").replace(/[^\d.]/g, "");
    const value = Math.max(0, Math.min(config.RANGE_LIMITS.fullRangeKm[1], parseFloat(raw) || 0));
    this._manualFullRange = value;
    this.setData({ fullRangeInput: raw, fullRangeKm: value, hasRangeCalc: false });
    this.refreshDerived();
  },

  // ---------- 定位 ----------
  ensureLocation(force) {
    if (this._locating) return;
    if (!force && this.data.locationDenied) return;
    if (!force && this.data.stage !== "idle") return; // 已有路线时不抢镜头
    if (!force && this._origin && Date.now() - (this._locatedAt || 0) < 60000) return;
    this._locating = true;
    wx.getLocation({
      type: "gcj02",
      success: (res) => {
        this._locating = false;
        const next = { latitude: res.latitude, longitude: res.longitude };
        const moved = this._origin ? geo.haversine(this._origin, next) : Infinity;
        this._locatedAt = Date.now();
        // 位置变化小于 200m 且参数未变：不重绘、不重算
        if (!force && this._origin && moved < config.CACHE.minMoveMeters) {
          this.setData({ locationDenied: false, showLocation: true });
          return;
        }
        this._origin = next;
        this.setData({
          center: next,
          showLocation: true,
          locationDenied: false,
          errorText: "",
        });
        this.refreshDerived();
      },
      fail: (err) => {
        this._locating = false;
        const msg = String((err && err.errMsg) || "");
        const denied = /auth deny|auth denied|authorize|permission/i.test(msg);
        this.setData({
          locationDenied: true,
          showLocation: false,
          errorText: denied
            ? "未获取到位置授权，可点「重新授权」或手动选择起点"
            : "定位失败，可手动选择起点",
        });
      },
    });
  },

  onOpenSetting() {
    wx.openSetting({
      success: (res) => {
        if (res.authSetting && res.authSetting["scope.userLocation"]) {
          this.setData({ locationDenied: false });
          this.ensureLocation(true);
        } else {
          wx.showToast({ title: "仍未授权位置", icon: "none" });
        }
      },
    });
  },

  // 降级：手动在地图上选点作为起点
  pickOrigin() {
    wx.chooseLocation({
      success: (res) => {
        if (!res || !res.latitude) return;
        this._origin = { latitude: res.latitude, longitude: res.longitude };
        this._locatedAt = 0;
        this.setData({
          center: this._origin,
          showLocation: false,
          locationDenied: false,
          errorText: "",
        });
        this.refreshDerived();
        wx.showToast({ title: "已设为起点", icon: "none" });
      },
      fail: (err) => {
        if (/cancel/.test(String((err && err.errMsg) || ""))) return;
        wx.showToast({ title: "选点失败", icon: "none" });
      },
    });
  },

  // ---------- 续航口径 ----------
  getRealM() {
    const d = this.data;
    return d.fullRangeKm * (d.soc / 100) * (1 - d.reserve / 100) * 1000;
  },

  getTheoryM() {
    const d = this.data;
    return (d.fullRangeKm * d.soc) / 100 * 1000;
  },

  // 只更新数值与 circles/polyline/markers，避免整体重绘
  refreshDerived() {
    const d = this.data;
    const realKm = (d.fullRangeKm * d.soc * (1 - d.reserve / 100)) / 100;
    const theoryKm = (d.fullRangeKm * d.soc) / 100;
    this.setData({ realKm: realKm.toFixed(1), theoryKm: theoryKm.toFixed(1) });

    if (d.stage === "idle") {
      this.setData({ circles: this.buildCircles(this._origin, realKm) });
      return;
    }
    if (this._route) {
      this.renderRoute(false);
      if (this._candidates && this.data.sheetMode === "plan") this.recomputePlan();
    }
  },

  // 9 个同心圆模拟渐变（原生 circle 不支持渐变）
  buildCircles(origin, realKmValue) {
    if (!origin) return [];
    const realKm = realKmValue == null ? parseFloat(this.data.realKm) || 0 : realKmValue;
    const baseM = realKm * 1000 * (this.data.detourFactor / 100);
    if (baseM <= 0) return [];
    const count = config.CIRCLES.count;
    const list = [];
    // 从外到内叠加
    for (let i = count; i >= 1; i -= 1) {
      const t = i / count;
      const alpha =
        config.CIRCLES.minAlpha + (config.CIRCLES.maxAlpha - config.CIRCLES.minAlpha) * t;
      const circle = {
        latitude: origin.latitude,
        longitude: origin.longitude,
        radius: Math.max(30, baseM * t),
        color: "rgba(0,0,0,0)",
        fillColor: rgba(stopColor(t), alpha),
        strokeWidth: 0,
      };
      if (i === count) {
        // 最外圈 1px 细描边
        circle.color = "#FF4D4F";
        circle.strokeWidth = 1;
      }
      list.push(circle);
    }
    return list;
  },

  debounceRefresh() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.refreshDerived();
    }, 100);
  },

  onSocChanging(e) {
    this.setData({ soc: Number(e.detail.value) });
    this.debounceRefresh();
  },

  onSocChange(e) {
    this.setData({ soc: Number(e.detail.value) });
    this.refreshDerived();
  },

  onSelectReserve(e) {
    this.setData({ reserve: Number(e.currentTarget.dataset.value) });
    this.refreshDerived();
  },

  onDetourChanging(e) {
    this.setData({ detourFactor: Number(e.detail.value) });
    this.debounceRefresh();
  },

  onDetourChange(e) {
    this.setData({ detourFactor: Number(e.detail.value) });
    this.refreshDerived();
  },

  onRoundTripChange(e) {
    this.setData({ roundTrip: e.detail.value });
    this.refreshDerived();
  },

  toggleAdvanced() {
    this.setData({ showAdvanced: !this.data.showAdvanced });
  },

  // ---------- 状态 B：选目的地 + 路线 ----------
  chooseDestination() {
    wx.chooseLocation({
      success: (res) => {
        if (!res || !res.latitude) return;
        this._suggestShownFor = "";
        this._candidates = null;
        this._route = null;
        this.setData({
          destination: {
            latitude: res.latitude,
            longitude: res.longitude,
            name: res.name || res.address || "目的地",
            address: res.address || "",
          },
          stage: "route",
          circles: [],
          polylines: [],
          markers: [],
          sheetVisible: false,
          sheetMode: "",
          planStations: [],
          planMessage: "",
          hintVisible: false,
          errorText: "",
        });
        this.loadRoute();
      },
      fail: (err) => {
        if (/cancel/.test(String((err && err.errMsg) || ""))) return;
        wx.showToast({ title: "选择目的地失败", icon: "none" });
      },
    });
  },

  loadRoute() {
    const dest = this.data.destination;
    if (!dest) return;
    const from = this._origin || this.data.center;
    this.setData({ loadingRoute: true });
    wx.showLoading({ title: "规划路线中", mask: false });
    qqmap
      .directionEbicycling({ from, to: dest })
      .then((route) => {
        wx.hideLoading();
        this._route = route;
        this.setData({ loadingRoute: false });
        this.renderRoute(true);
      })
      .catch((err) => {
        wx.hideLoading();
        this._route = null;
        this.setData({
          loadingRoute: false,
          polylines: [],
          markers: [],
          errorText: (err && err.message) || "路线规划失败",
        });
        wx.showToast({ title: (err && err.message) || "路线规划失败", icon: "none" });
      });
  },

  // 按可用续航把路线切成实线（可达）/虚线（不可达）
  renderRoute(autoSuggest) {
    const d = this.data;
    const route = this._route;
    if (!route || route.points.length < 2 || !d.destination) {
      this.setData({ polylines: [], markers: [] });
      return;
    }
    const totalM = route.cum[route.cum.length - 1] || route.distance || 0;
    if (!totalM) return;
    this._routeTotalM = totalM;
    if (!d.fullRangeKm) {
      this.setData({
        polylines: [],
        markers: [],
        routeInfo: null,
        errorText: "请先设置满电续航（可在续航计算器计算或手动填写）",
      });
      return;
    }

    const realM = this.getRealM();
    const reachM = d.roundTrip ? realM / 2 : realM; // 往返时单程只能走一半
    const needM = d.roundTrip ? totalM * 2 : totalM;
    const split = geo.splitByDistance(route.points, Math.min(reachM, totalM));

    const polylines = [];
    if (split.head.length > 1) {
      polylines.push({
        points: split.head,
        color: "#1677FF",
        width: 8,
        arrowLine: true,
        borderWidth: 1,
        borderColor: "#ffffff",
      });
    }
    if (split.tail.length > 1) {
      polylines.push({
        points: split.tail,
        color: "#FF4D4F",
        width: 8,
        dottedLine: true,
        borderWidth: 1,
        borderColor: "#ffffff",
      });
    }

    const markers = [
      {
        id: 101,
        latitude: d.destination.latitude,
        longitude: d.destination.longitude,
        iconPath: "/assets/marker-dest.png",
        width: 26,
        height: 26,
        callout: {
          content: d.destination.name || "目的地",
          color: "#1f2937",
          fontSize: 12,
          borderRadius: 8,
          padding: 6,
          bgColor: "#ffffff",
          display: "ALWAYS",
        },
      },
    ];
    if (split.tail.length > 1 && split.junction) {
      markers.push({
        id: 102,
        latitude: split.junction.latitude,
        longitude: split.junction.longitude,
        iconPath: "/assets/marker-limit.png",
        width: 22,
        height: 22,
        callout: {
          content: "预计电量用尽点（保守）",
          color: "#FF4D4F",
          fontSize: 11,
          borderRadius: 8,
          padding: 6,
          bgColor: "#ffffff",
          display: "ALWAYS",
        },
      });
    }

    // 三档判定：剩余电量（相对满电 SOC 口径）
    const usedPct = (needM / (d.fullRangeKm * 1000)) * 100;
    const remainPct = d.soc - usedPct;
    const shortfallKm = Math.max(0, totalM - reachM) / 1000;
    const remainUsableKm = Math.max(0, reachM - totalM) / 1000;

    let level = "ok";
    let levelText = "可直达";
    if (remainPct < 0) {
      level = "short";
      levelText = `无法直达，缺 ${shortfallKm.toFixed(1)} km`;
    } else if (remainPct < d.reserve) {
      level = "tight";
      levelText = "可到达但电量很紧，建议补电";
    }

    const routeInfo = {
      distanceText: `${(totalM / 1000).toFixed(1)} km${d.roundTrip ? " × 2" : ""}`,
      durationText: `${Math.max(1, Math.round((route.duration || 0) / 60))} 分钟`,
      usedText: `${Math.round(usedPct)}%`,
      remainText:
        remainPct >= 0
          ? `${Math.round(remainPct)}%（可用里程余 ${remainUsableKm.toFixed(1)} km）`
          : `差 ${shortfallKm.toFixed(1)} km`,
      level,
      levelText,
      roundTrip: d.roundTrip,
    };

    this.setData({ polylines, markers, routeInfo });

    if (!autoSuggest) return;
    if (level === "ok") {
      this.setData({ hintVisible: true, sheetVisible: false, sheetMode: "" });
      return;
    }
    // 不够/勉强：非遮蔽半高卡片，同一目的地只自动弹一次
    if (this._suggestShownFor !== this.destKey()) {
      this._suggestShownFor = this.destKey();
      this.setData({
        hintVisible: false,
        sheetVisible: true,
        sheetCollapsed: false,
        sheetMode: "suggest",
        sheetTitle: level === "short" ? "电量可能不够" : "电量比较紧张",
        sheetDesc: "建议沿途补电。是否规划充电站或换电站？",
      });
    }
  },

  destKey() {
    const dest = this.data.destination;
    if (!dest) return "";
    return `${dest.latitude.toFixed(5)},${dest.longitude.toFixed(5)}`;
  },

  clearDestination() {
    this._route = null;
    this._candidates = null;
    this._suggestShownFor = "";
    this.setData({
      destination: null,
      stage: "idle",
      polylines: [],
      markers: [],
      routeInfo: null,
      hintVisible: false,
      sheetVisible: false,
      sheetMode: "",
      planStations: [],
      planMessage: "",
    });
    this.refreshDerived();
  },

  // ---------- 状态 C：补电规划 ----------
  onPlanCharging() {
    if (!this._route || this.data.planning) return;
    const d = this.data;
    this.setData({
      planning: true,
      sheetVisible: true,
      sheetCollapsed: false,
      sheetMode: "plan",
      hintVisible: false,
      planStations: [],
      planMessage: "正在检索沿途补电点…",
      planFeasible: false,
    });
    wx.showLoading({ title: "检索沿途补电点", mask: false });

    const totalM = this._route.cum[this._route.cum.length - 1];
    const finish = () => {
      wx.hideLoading();
      this.setData({ planning: false });
    };

    if (config.DEMO.useMockStations) {
      // 演示模式：未配置 Key 时也能看交互效果，上线前把 DEMO.useMockStations 改回 false
      this._candidates = this.buildMockCandidates();
      finish();
      this.recomputePlan();
      return;
    }

    qqmap.resetRequestCount();
    planner
      .collectCandidates({
        points: this._route.points,
        cum: this._route.cum,
        total: totalM,
        usableNow: this.getRealM(),
        theoryM: this.getTheoryM(),
        searchNearby: qqmap.searchNearby,
        onProgress: (p) => {
          if (p && p.requests % 6 === 0) {
            this.setData({ planMessage: `已检索 ${p.requests} 次（${Math.round(p.distance / 1000)} km）…` });
          }
        },
      })
      .then((candidates) => {
        finish();
        this._candidates = candidates;
        this.recomputePlan();
      })
      .catch((err) => {
        finish();
        this.setData({
          planStations: [],
          planFeasible: false,
          planMessage: (err && err.message) || "补电点检索失败，请稍后重试",
        });
      });
  },

  // 演示用假站点（真实数据接入后删除本方法即可）
  buildMockCandidates() {
    const route = this._route;
    const total = route.cum[route.cum.length - 1];
    const pois = [0.32, 0.62].map((ratio, index) => {
      const p = geo.pointAtDistance(route.points, route.cum, total * ratio);
      const isSwap = index === 0;
      return {
        id: `mock-${index}`,
        title: isSwap ? "示例换电柜 A（演示数据）" : "示例充电站 B（演示数据）",
        address: "示例地址，仅供演示",
        category: isSwap ? "换电站" : "充电站",
        location: { lat: p.latitude, lng: p.longitude },
      };
    });
    return planner.buildCandidates({
      pois,
      points: route.points,
      cum: route.cum,
      reachM: total,
    });
  },

  recomputePlan() {
    const d = this.data;
    if (!this._route) return;
    const totalM = this._route.cum[this._route.cum.length - 1];
    const result = planner.planCharging({
      total: totalM,
      real: this.getRealM(),
      roundTrip: d.roundTrip,
      fullRangeKm: d.fullRangeKm,
      whPerKm: d.whPerKm || 15,
      soc: d.soc / 100,
      reserve: d.reserve / 100,
      preference: d.preference,
      candidates: this._candidates || [],
      options: config.PLANNER,
    });
    this.renderPlan(result);
  },

  renderPlan(result) {
    const route = this._route;
    const d = this.data;
    if (!route || !d.destination) return;

    const polylines = [];
    (result.segments || []).forEach((seg) => {
      if (!seg || seg.to - seg.from < 1) return;
      const pts = sliceRoute(route.points, route.cum, seg.from, seg.to);
      if (pts.length < 2) return;
      polylines.push(
        seg.ok
          ? {
              points: pts,
              color: "#1677FF",
              width: 8,
              arrowLine: true,
              borderWidth: 1,
              borderColor: "#ffffff",
            }
          : {
              points: pts,
              color: "#FF4D4F",
              width: 8,
              dottedLine: true,
              borderWidth: 1,
              borderColor: "#ffffff",
            }
      );
    });

    const markers = [
      {
        id: 101,
        latitude: d.destination.latitude,
        longitude: d.destination.longitude,
        iconPath: "/assets/marker-dest.png",
        width: 26,
        height: 26,
        callout: {
          content: d.destination.name || "目的地",
          color: "#1f2937",
          fontSize: 12,
          borderRadius: 8,
          padding: 6,
          bgColor: "#ffffff",
          display: "ALWAYS",
        },
      },
    ];

    (result.stations || []).forEach((station, index) => {
      const isSwap = station.type === "swap";
      markers.push({
        id: 200 + index,
        latitude: station.latitude,
        longitude: station.longitude,
        iconPath: isSwap ? "/assets/marker-swap.png" : "/assets/marker-charge.png",
        width: 28,
        height: 28,
        callout: {
          content: `${station.order} ${station.typeLabel}`,
          color: "#ffffff",
          fontSize: 11,
          borderRadius: 10,
          padding: 4,
          bgColor: isSwap ? "#16A34A" : "#2563EB",
          display: "ALWAYS",
        },
      });
    });

    // 不可达时标出最远可达点
    if (!result.feasible && result.limitM != null) {
      const p = geo.pointAtDistance(route.points, route.cum, result.limitM);
      if (p) {
        markers.push({
          id: 300,
          latitude: p.latitude,
          longitude: p.longitude,
          iconPath: "/assets/marker-limit.png",
          width: 22,
          height: 22,
          callout: {
            content: "最远可达点",
            color: "#FF4D4F",
            fontSize: 11,
            borderRadius: 8,
            padding: 6,
            bgColor: "#ffffff",
            display: "ALWAYS",
          },
        });
      }
    }

    this.setData({
      polylines,
      markers,
      sheetVisible: true,
      sheetCollapsed: false,
      sheetMode: "plan",
      planStations: result.stations || [],
      planFeasible: !!result.feasible,
      planMessage: result.message || "",
    });
  },

  onSelectPreference(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.preference) return;
    this.setData({ preference: key });
    if (this._candidates && this._candidates.length) this.recomputePlan();
  },

  onViewStation(e) {
    const ds = e.currentTarget.dataset;
    wx.openLocation({
      latitude: Number(ds.lat),
      longitude: Number(ds.lng),
      name: String(ds.name || "补电点"),
      address: String(ds.address || ""),
      scale: 17,
    });
  },

  // ---------- 底部卡片 ----------
  toggleSheet() {
    this.setData({ sheetCollapsed: !this.data.sheetCollapsed });
  },

  onSheetTouchStart(e) {
    const touch = e.touches && e.touches[0];
    this._sheetTouchY = touch ? touch.clientY : 0;
  },

  onSheetTouchEnd(e) {
    const touch = e.changedTouches && e.changedTouches[0];
    if (!touch) return;
    const delta = touch.clientY - (this._sheetTouchY || 0);
    if (delta > 30 && !this.data.sheetCollapsed) this.setData({ sheetCollapsed: true });
    else if (delta < -30 && this.data.sheetCollapsed) this.setData({ sheetCollapsed: false });
  },

  dismissSheet() {
    this.setData({ sheetVisible: false, sheetMode: "" });
  },

  goCalculator() {
    wx.switchTab({ url: "/pages/index/index" });
  },
});
