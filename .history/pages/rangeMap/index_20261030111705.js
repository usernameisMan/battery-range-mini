// 续航地图：状态机 A（未选目的地）/ B（已选目的地）/ C（规划补电）
// 地图与路线数据来自腾讯位置服务 WebService（wx.request -> apis.map.qq.com）
const config = require("../../config");
const geo = require("../../utils/geo");
const planner = require("../../utils/planner");
const qqmap = require("../../utils/qqmap");
const { maybeShowServiceTip } = require("../../utils/serviceTip");

const DEFAULT_CENTER = { latitude: 39.908823, longitude: 116.39747 };
const RESERVE_OPTIONS = [10, 15, 20, 30];
const PREFERENCES = [
  { key: "swap", label: "换电优先" },
  { key: "charge", label: "充电优先" },
  { key: "time", label: "省时间" },
  { key: "detour", label: "少绕路" },
];

// 续航圈配色：同色系蓝色，由内向外渐淡
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
    fitPoints: [],
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
    showRange: true, // 续航范围（同心圆 + 角标）开关
    // 搜索栏滚动通知：滚过一遍后消失，每次打开页面重新播
    noticeVisible: false,
    noticeText:
      "开发者为个人，目前个人地图接口只能支持很少的调用请见谅🥹🥹（正在想办法）",
    realKm: "0.0",
    theoryKm: "0.0",
    realManual: false, // 可用续航是否被手动改过
    realSourceText: "", // 可用续航来源说明（自动公式 / 手动）
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
    planAccepted: false, // 是否已确认采用这条补电路线
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
    this.setData({ showRange: this.readShowRange() });
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
    if (!this.data.destination) this.playNotice();
    maybeShowServiceTip();
  },

  onUnload() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    if (this._noticeStartTimer) clearTimeout(this._noticeStartTimer);
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
  },

  // 搜索栏滚动通知：滚完自动消失，下次进页面重新播
  playNotice() {
    if (this._noticeStartTimer) clearTimeout(this._noticeStartTimer);
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this.setData({ noticeVisible: false });
    // 先卸载再挂载，保证动画每次从头开始
    this._noticeStartTimer = setTimeout(() => {
      this.setData({ noticeVisible: true });
      // 兜底：万一没收到 animationend
      this._noticeTimer = setTimeout(() => this.setData({ noticeVisible: false }), 15000);
    }, 60);
  },

  onNoticeEnd() {
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this.setData({ noticeVisible: false });
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
    // 只跳过本次授权，不作为永久降级：仍可点「重新定位」再次请求
    this.setData({
      showPrivacy: false,
      errorText: "未授权位置，点「重新定位」可再次授权，或手动选择起点",
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
      // 满电续航变了，手动设过的可用续航就不作数了
      if (this.data.hasRangeCalc && fullRangeKm !== this.data.fullRangeKm) {
        this.clearRealOverride();
      }
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
    this.clearRealOverride();
    this.setData({ fullRangeInput: raw, fullRangeKm: value, hasRangeCalc: false });
    this.refreshDerived();
  },

  // ---------- 定位 ----------
  // 默认起点就是「当前位置」：进入页面自动定位，只有用户手动选过起点才不再覆盖
  ensureLocation(force) {
    if (this._locating) return;
    if (!force && this.data.showPrivacy) return; // 隐私说明未处理，等用户选择
    if (!force && this._manualOrigin) return; // 用户手动选过起点，不再自动覆盖
    if (!force && this.data.stage !== "idle") return; // 已有路线时不抢镜头
    if (!force && this._origin && Date.now() - (this._locatedAt || 0) < 60000) return;
    // 失败后 8 秒内不重复请求，避免反复弹系统授权框；点「重新定位」可立即重试
    if (!force && Date.now() - (this._locationFailedAt || 0) < 8000) return;
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
        this._manualOrigin = false;
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
        this._locationFailedAt = Date.now();
        const msg = String((err && err.errMsg) || "");
        // 小程序后台「用户隐私保护指引」未申报位置信息：接口会直接拒绝，且重试无效
        if (/privacy agreement|not declared/i.test(msg)) {
          this.setData({
            locationDenied: false,
            showLocation: false,
            errorText:
              "位置能力尚未生效：请在小程序后台「用户隐私保护指引」中申报「位置信息」用途，配置完成后再点「重新定位」",
          });
          return;
        }
        const denied = /auth deny|auth denied|authorize|permission|scope/i.test(msg);
        this.setData({
          locationDenied: denied,
          showLocation: false,
          errorText: denied
            ? "未获取到位置授权，点「去授权」开启定位，或手动选择起点"
            : "暂时没定位成功，可点「重新定位」重试，或手动选择起点",
        });
      },
    });
  },

  onRetryLocation() {
    this._locationFailedAt = 0;
    this.setData({ errorText: "" });
    this.ensureLocation(true);
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
        this._manualOrigin = true;
        this._locatedAt = 0;
        this.setData({
          center: this._origin,
          showLocation: false,
          locationDenied: false,
          errorText: "",
        });
        this.refreshDerived();
        wx.showToast({ title: "已设为起点", icon: "none" });
        // 已选目的地时，按新起点重新规划路线
        if (this._route || this.data.destination) this.loadRoute();
      },
      fail: (err) => {
        if (/cancel/.test(String((err && err.errMsg) || ""))) return;
        wx.showToast({ title: "选点失败", icon: "none" });
      },
    });
  },

  // ---------- 续航口径 ----------
  getRealM() {
    // 用户手动设过可用续航就优先用它，否则按「满电续航 × 电量 × (1 − 预留)」算
    if (this._realOverrideKm) return this._realOverrideKm * 1000;
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
    const realKm = this.getRealM() / 1000;
    const theoryKm = (d.fullRangeKm * d.soc) / 100;
    const circles = d.showRange ? this.buildCircles(this._origin, realKm) : [];
    const sourceText = this._realOverrideKm
      ? "已手动设定，改电量或预留会恢复自动计算"
      : d.fullRangeKm > 0
        ? `自动：${d.fullRangeKm} km × ${d.soc}% 电量 × (1 − ${d.reserve}%)`
        : "未设置满电续航，先去计算器算一次或手动填写";
    const numbers = {
      realKm: realKm.toFixed(1),
      theoryKm: theoryKm.toFixed(1),
      circles,
      realSourceText: sourceText,
    };

    if (d.stage === "idle") {
      // 角标挂在定位点上，随地图缩放 / 拖动一起移动
      this.setData(
        Object.assign(numbers, {
          markers: d.showRange ? this.buildOriginMarker(realKm) : [],
        })
      );
      return;
    }
    this.setData(numbers);
    if (this._route) {
      this.renderRoute(false);
      if (this._candidates && this.data.sheetMode === "plan") this.recomputePlan();
    }
  },

  // 「约 xx km 可达」气泡：用 1px 透明 marker + callout，让它跟着定位点走
  buildOriginMarker(realKmValue) {
    const origin = this._origin;
    const realKm =
      realKmValue == null ? parseFloat(this.data.realKm) || 0 : realKmValue;
    if (!origin || !(realKm > 0)) return [];
    return [
      {
        id: 1,
        latitude: origin.latitude,
        longitude: origin.longitude,
        iconPath: "/assets/marker-origin.png",
        width: 1,
        height: 1,
        anchor: { x: 0.5, y: 0.5 },
        callout: {
          content: `约 ${realKm.toFixed(1)} km 可达（保守估计）`,
          color: "#1f2937",
          fontSize: 12,
          borderRadius: 12,
          padding: 8,
          bgColor: "#ffffff",
          display: "ALWAYS",
        },
      },
    ];
  },

  // 9 个同心圆模拟渐变（原生 circle 不支持渐变）
  // 注意：同心圆是叠加的，这里按「叠加后的目标透明度」反推每圈 alpha，避免圆心糊成一块
  buildCircles(origin, realKmValue) {
    if (!origin) return [];
    const realKm = realKmValue == null ? parseFloat(this.data.realKm) || 0 : realKmValue;
    const baseM = realKm * 1000 * (this.data.detourFactor / 100);
    if (baseM <= 0) return [];
    const { count, innerAlpha, outerAlpha, color } = config.CIRCLES;
    const list = [];
    let remaining = 1; // 尚未被已绘制外圈遮挡的比例
    // 从外到内叠加
    for (let i = count; i >= 1; i -= 1) {
      const t = i / count;
      const target = outerAlpha + (innerAlpha - outerAlpha) * (1 - t);
      const alpha = Math.max(0, Math.min(0.35, 1 - (1 - target) / remaining));
      remaining *= 1 - alpha;
      const circle = {
        latitude: origin.latitude,
        longitude: origin.longitude,
        radius: Math.max(30, baseM * t),
        color: "rgba(0,0,0,0)",
        fillColor: rgba(color, alpha),
        strokeWidth: 0,
      };
      if (i === count) {
        // 最外圈细描边，边界更清晰
        circle.color = rgba(color, 0.55);
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
    this.clearRealOverride();
    this.setData({ soc: Number(e.detail.value) });
    this.debounceRefresh();
  },

  onSocChange(e) {
    this.clearRealOverride();
    this.setData({ soc: Number(e.detail.value) });
    this.refreshDerived();
  },

  onSelectReserve(e) {
    this.clearRealOverride();
    this.setData({ reserve: Number(e.currentTarget.dataset.value) });
    this.refreshDerived();
  },

  // 手动设置可用续航：清空输入或输入非法值即回到自动计算
  onRealKmCommit(e) {
    const raw = String((e.detail && e.detail.value) || "").trim();
    const value = parseFloat(raw);
    if (!raw || !isFinite(value) || value <= 0) {
      this._realOverrideKm = 0;
      this.setData({ realManual: false });
      this.refreshDerived();
      return;
    }
    const cap = this.data.fullRangeKm > 0 ? this.data.fullRangeKm : config.RANGE_LIMITS.fullRangeKm[1];
    const km = Math.min(Math.max(value, 1), cap);
    this._realOverrideKm = Math.round(km * 10) / 10;
    this.setData({ realManual: true });
    this.refreshDerived();
    if (km !== value) {
      wx.showToast({ title: `已按上限 ${this._realOverrideKm} km 处理`, icon: "none" });
    }
  },

  // 点「手动」标记可恢复自动计算
  onResetRealKm() {
    if (!this._realOverrideKm) return;
    this.clearRealOverride();
    this.refreshDerived();
    wx.showToast({ title: "已恢复自动计算", icon: "none" });
  },

  // 电量 / 预留 / 满电续航变化后，可用续航重新回到自动计算
  clearRealOverride() {
    if (!this._realOverrideKm) return;
    this._realOverrideKm = 0;
    this.setData({ realManual: false });
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

  readShowRange() {
    try {
      return wx.getStorageSync("rangeMapShowRange") !== 0;
    } catch (e) {
      return true;
    }
  },

  // 续航范围开关：巡航 / 导航状态下都能随时开合
  onToggleRange(e) {
    const showRange = !!e.detail.value;
    this.setData({ showRange });
    try {
      wx.setStorageSync("rangeMapShowRange", showRange ? 1 : 0);
    } catch (err) {
      // 存储失败不影响当前会话
    }
    this.refreshDerived();
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
          polylines: [],
          markers: [],
          sheetVisible: false,
          sheetMode: "",
          planStations: [],
          planMessage: "",
          hintVisible: false,
          errorText: "",
        });
        // 进入导航也保留「续航范围」（受开关控制）
        this.refreshDerived();
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
        this.setData({
          loadingRoute: false,
          fitPoints: [
            { latitude: from.latitude, longitude: from.longitude },
            { latitude: dest.latitude, longitude: dest.longitude },
          ],
        });
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
      fitPoints: [],
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
    // 已经检索过候选站点：直接复用，不再消耗接口额度
    if (this._candidates && this._candidates.length) {
      this.setData({
        sheetVisible: true,
        sheetCollapsed: false,
        sheetMode: "plan",
        hintVisible: false,
      });
      this.recomputePlan();
      return;
    }
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

  // 确认采用这条补电路线
  onAcceptPlan() {
    if (!this.data.planStations.length || !this.data.planFeasible) return;
    this.setData({ planAccepted: true, sheetCollapsed: true });
    wx.showToast({ title: "已使用该补电路线", icon: "success" });
  },

  // 取消补电方案：退回「缺电」的原始路线（实线 + 虚线 + 预计电量用尽点）
  // 已确认使用的方案同样可以取消；已检索到的候选站点会保留，再次点「规划补电」无需重新请求
  onCancelPlan() {
    if (this.data.planning) return;
    this.setData({
      sheetVisible: false,
      sheetMode: "",
      planStations: [],
      planMessage: "",
      planFeasible: false,
      planAccepted: false,
    });
    this.renderRoute(false);
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
