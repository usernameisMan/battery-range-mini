// 骑士性格测试（娱乐向）：引导 → 12 题 → 结果 + 雷达图 + 分享海报
// 题目与评分在 utils/quiz.js，本文件只负责交互、绘图与分享
const quiz = require("../../utils/quiz");
const { maybeShowServiceTip } = require("../../utils/serviceTip");

const MINI_CODE_SRC = "../../assets/miniprogram-code.png";
const POSTER_W = 750;
const POSTER_H = 1360;

// 十六进制色值转 rgba，用于雷达图填充
function hexToRgba(hex, alpha) {
  const value = String(hex || "").replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) || 0;
  const g = parseInt(value.slice(2, 4), 16) || 0;
  const b = parseInt(value.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

// 海报中文换行（逐字测量宽度）
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
  lines.forEach((item, index) => ctx.fillText(item, x, y + index * lineHeight));
  return lines.length;
}

// 六边形雷达图：页面与海报共用
function drawRadar(ctx, opt) {
  const {
    cx,
    cy,
    radius,
    dims,
    gridColor,
    fill,
    stroke,
    labelColor,
    valueColor,
    labelFont,
    valueFont,
    labelGap,
    showValue,
  } = opt;
  const count = dims.length;
  const angleOf = (i) => -Math.PI / 2 + (i * Math.PI * 2) / count;
  const pointAt = (i, ratio) => {
    const angle = angleOf(i);
    return {
      x: cx + Math.cos(angle) * radius * ratio,
      y: cy + Math.sin(angle) * radius * ratio,
    };
  };

  // 背景环
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  for (let ring = 1; ring <= 4; ring += 1) {
    ctx.beginPath();
    for (let i = 0; i < count; i += 1) {
      const p = pointAt(i, ring / 4);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  // 轴线
  for (let i = 0; i < count; i += 1) {
    const p = pointAt(i, 1);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  // 数据多边形
  ctx.beginPath();
  dims.forEach((dim, i) => {
    const p = pointAt(i, Math.max(0.02, dim.percent / 100));
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();

  // 顶点
  dims.forEach((dim, i) => {
    const p = pointAt(i, Math.max(0.02, dim.percent / 100));
    ctx.beginPath();
    ctx.fillStyle = stroke;
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // 轴标签 + 分数
  dims.forEach((dim, i) => {
    const angle = angleOf(i);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const lx = cx + cos * (radius + labelGap);
    const ly = cy + sin * (radius + labelGap);
    ctx.textAlign = Math.abs(cos) < 0.2 ? "center" : cos > 0 ? "left" : "right";
    ctx.textBaseline = Math.abs(sin) < 0.2 ? "middle" : sin > 0 ? "top" : "bottom";

    ctx.fillStyle = labelColor;
    ctx.font = `${labelFont}px sans-serif`;
    ctx.fillText(dim.short, lx, ly);

    if (showValue) {
      const offset = sin > 0 ? labelFont + 2 : -labelFont - 2;
      ctx.fillStyle = valueColor;
      ctx.font = `${valueFont}px sans-serif`;
      ctx.fillText(String(dim.percent), lx, ly + offset);
    }
  });

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

// 加载图片用于 canvas 2d（失败返回 null）
function loadCanvasImage(canvas, src) {
  return new Promise((resolve) => {
    const image = canvas.createImage();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

// 引导页展示的 6 个角色（取「·」后半段作为短名）
function introRoles() {
  return quiz.ROLES.map((role) => ({
    key: role.key,
    emoji: role.emoji,
    label: role.name.indexOf("·") >= 0 ? role.name.split("·")[1].trim() : role.name,
    color: role.color,
  }));
}

Page({
  data: {
    topSafeArea: 40,
    stage: "intro", // intro / quiz / result
    total: quiz.QUESTIONS.length,
    index: 0,
    progress: 0,
    question: null,
    selected: -1,
    roles: introRoles(),
    result: null,
  },

  onLoad() {
    this._answers = quiz.emptyAnswers();
    this.setupSafeArea();
  },

  onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    maybeShowServiceTip();
  },

  onUnload() {
    if (this._advanceTimer) clearTimeout(this._advanceTimer);
  },

  onShareAppMessage() {
    const role = this.data.result && this.data.result.role;
    return {
      title: role
        ? `我是「${role.name}」，你是哪种骑手？`
        : "12 道题，测出你是哪种外卖骑士",
      path: "/pages/quiz/index",
    };
  },

  onShareTimeline() {
    const role = this.data.result && this.data.result.role;
    return {
      title: role ? `我是「${role.name}」，你是哪种骑手？` : "测测你是哪种外卖骑士",
    };
  },

  setupSafeArea() {
    try {
      const menuButton = wx.getMenuButtonBoundingClientRect();
      this.setData({ topSafeArea: menuButton.top || 40 });
    } catch (e) {
      this.setData({ topSafeArea: 40 });
    }
  },

  start() {
    this._answers = quiz.emptyAnswers();
    this.setData({ stage: "quiz", selected: -1, result: null }, () => this.setQuestion(0));
  },

  setQuestion(index) {
    const item = quiz.QUESTIONS[index];
    if (!item) return;
    this.setData({
      index,
      progress: Math.round((index / quiz.QUESTIONS.length) * 100),
      question: {
        text: item.text,
        options: item.options.map((option, i) => ({
          text: option.text,
          letter: "ABC"[i] || "",
        })),
      },
    });
  },

  onPick(e) {
    if (this._locked) return;
    if (this._advanceTimer) clearTimeout(this._advanceTimer);
    const choice = Number(e.currentTarget.dataset.index);
    const current = this.data.index;
    this._answers[current] = choice;
    this._locked = true;
    this.setData({ selected: choice });

    this._advanceTimer = setTimeout(() => {
      this._locked = false;
      if (current + 1 >= quiz.QUESTIONS.length) {
        this.finish();
        return;
      }
      this.setData({ selected: this._answers[current + 1] });
      this.setQuestion(current + 1);
    }, 180);
  },

  onBackTap() {
    if (this.data.index === 0) {
      this.onBackToIntro();
      return;
    }
    this.onBack();
  },

  onBack() {
    if (this.data.stage !== "quiz" || this.data.index === 0) return;
    if (this._advanceTimer) clearTimeout(this._advanceTimer);
    this._locked = false;
    const target = this.data.index - 1;
    this.setData({ selected: this._answers[target] });
    this.setQuestion(target);
  },

  onBackToIntro() {
    if (this._advanceTimer) clearTimeout(this._advanceTimer);
    this._locked = false;
    this._answers = quiz.emptyAnswers();
    this.setData({ stage: "intro", selected: -1, progress: 0 });
  },

  finish() {
    const answers = this._answers.slice();
    const result = quiz.evaluate(answers);
    this._result = result;
    this.setData({ stage: "result", result, progress: 100, selected: -1 }, () => {
      this.initRadar();
    });
  },

  restart() {
    this._result = null;
    this.start();
  },

  // ---------- 结果页雷达图 ----------

  initRadar() {
    const query = wx.createSelectorQuery().in(this);
    query
      .select("#radar")
      .fields({ node: true, size: true })
      .exec((res) => {
        const item = res && res[0];
        if (!item || !item.node) return;
        const canvas = item.node;
        const ctx = canvas.getContext("2d");
        let dpr = 2;
        try {
          const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
          dpr = info.pixelRatio || 2;
        } catch (e) {
          dpr = 2;
        }
        canvas.width = item.width * dpr;
        canvas.height = item.height * dpr;
        ctx.scale(dpr, dpr);
        this._radar = { canvas, ctx, width: item.width, height: item.height };
        this.drawRadarOnPage();
      });
  },

  drawRadarOnPage() {
    const chart = this._radar;
    const result = this._result || this.data.result;
    if (!chart || !result) return;
    const ctx = chart.ctx;
    const width = chart.width;
    const height = chart.height;
    ctx.clearRect(0, 0, width, height);
    drawRadar(ctx, {
      cx: width / 2,
      cy: height / 2 + 2,
      radius: Math.min(width, height) * 0.3,
      dims: result.dims,
      gridColor: "#e2e8f0",
      fill: hexToRgba(result.role.color, 0.18),
      stroke: result.role.color,
      labelColor: "#475569",
      valueColor: "#94a3b8",
      labelFont: 11,
      valueFont: 9,
      labelGap: 21,
      showValue: true,
    });
  },

  // ---------- 分享海报 ----------

  onGeneratePoster() {
    if (!this._result) return;
    if (this._posterBusy) return;
    this._posterBusy = true;

    let canvas = null;
    try {
      canvas = wx.createOffscreenCanvas({ type: "2d", width: POSTER_W, height: POSTER_H });
    } catch (e) {
      canvas = null;
    }
    if (!canvas) {
      this._posterBusy = false;
      wx.showToast({ title: "当前环境不支持生成海报", icon: "none" });
      return;
    }

    const ctx = canvas.getContext("2d");
    wx.showLoading({ title: "生成海报中", mask: true });
    Promise.resolve(this.drawPoster(ctx, canvas))
      .then(
        () =>
          new Promise((resolve, reject) => {
            wx.canvasToTempFilePath({
              canvas,
              x: 0,
              y: 0,
              width: POSTER_W,
              height: POSTER_H,
              destWidth: POSTER_W * 2,
              destHeight: POSTER_H * 2,
              success: resolve,
              fail: reject,
            });
          })
      )
      .then((res) => {
        wx.hideLoading();
        this._posterBusy = false;
        this.savePoster(res.tempFilePath);
      })
      .catch(() => {
        wx.hideLoading();
        this._posterBusy = false;
        wx.showToast({ title: "生成失败，请重试", icon: "none" });
      });
  },

  drawPoster(ctx, canvas) {
    const result = this._result;
    const role = result.role;
    const W = POSTER_W;

    // 背景
    const bg = ctx.createLinearGradient(0, 0, W, POSTER_H);
    bg.addColorStop(0, "#111827");
    bg.addColorStop(0.5, "#1e1b4b");
    bg.addColorStop(1, "#0f172a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, POSTER_H);

    // 角色色光斑
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = role.color;
    ctx.beginPath();
    ctx.arc(650, 130, 190, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    ctx.arc(60, 380, 150, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#a5b4fc";
    ctx.font = "bold 24px sans-serif";
    ctx.fillText("外卖骑手 · 骑士性格测试（娱乐版）", 48, 96);

    ctx.font = "86px sans-serif";
    ctx.fillText(role.emoji, 44, 206);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 54px sans-serif";
    ctx.fillText(role.name, 48, 292);

    ctx.fillStyle = "#c7d2fe";
    ctx.font = "26px sans-serif";
    fillWrappedText(ctx, role.tagline, 48, 346, 650, 38, 2);

    ctx.fillStyle = role.color;
    ctx.font = "bold 24px sans-serif";
    ctx.fillText(`副属性：${result.secondName}`, 48, 448);

    // 雷达图白卡片
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, 48, 480, 654, 470, 28);
    ctx.fill();
    drawRadar(ctx, {
      cx: 375,
      cy: 712,
      radius: 148,
      dims: result.dims,
      gridColor: "#e5e7eb",
      fill: hexToRgba(role.color, 0.16),
      stroke: role.color,
      labelColor: "#334155",
      valueColor: "#94a3b8",
      labelFont: 22,
      valueFont: 18,
      labelGap: 28,
      showValue: true,
    });

    // 前三项得分
    result.top.forEach((dim, index) => {
      const x = 48 + index * 219;
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      roundRect(ctx, x, 966, 207, 62, 18);
      ctx.fill();
      ctx.textAlign = "center";
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "24px sans-serif";
      ctx.fillText(`${dim.short} ${dim.percent}`, x + 103, 1006);
    });

    // 最有炫耀点的一句：最强维度击败了多少人
    const best = result.top[0];
    ctx.textAlign = "center";
    ctx.fillStyle = role.color;
    ctx.font = "bold 26px sans-serif";
    ctx.fillText(`你的「${best.name}」超过 ${best.beat}% 的骑手`, 375, 1074);
    ctx.textAlign = "left";

    // 三个特征
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "24px sans-serif";
    role.traits.forEach((trait, index) => {
      ctx.fillText(`· ${trait}`, 48, 1114 + index * 38);
    });

    // 免责声明
    ctx.fillStyle = "#94a3b8";
    ctx.font = "20px sans-serif";
    ctx.fillText("本测试为娱乐向内容，不构成专业心理测评或任何建议。", 48, 1226);

    // 分隔线 + 小程序码
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(48, 1246);
    ctx.lineTo(702, 1246);
    ctx.stroke();

    const codeBox = { x: 48, y: 1272, w: 84, h: 84 };
    return loadCanvasImage(canvas, MINI_CODE_SRC).then((image) => {
      if (image) {
        ctx.fillStyle = "#ffffff";
        roundRect(ctx, codeBox.x, codeBox.y, codeBox.w, codeBox.h, 12);
        ctx.fill();
        ctx.drawImage(image, codeBox.x + 6, codeBox.y + 6, codeBox.w - 12, codeBox.h - 12);
      } else {
        ctx.save();
        ctx.setLineDash([8, 6]);
        ctx.strokeStyle = "#475569";
        ctx.lineWidth = 2;
        ctx.strokeRect(codeBox.x, codeBox.y, codeBox.w, codeBox.h);
        ctx.restore();
      }

      ctx.textAlign = "left";
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "bold 24px sans-serif";
      ctx.fillText("微信扫码，测测你是哪种骑士", codeBox.x + codeBox.w + 24, codeBox.y + 38);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "20px sans-serif";
      ctx.fillText("长按识别小程序码 · 12 题约 40 秒", codeBox.x + codeBox.w + 24, codeBox.y + 72);
    });
  },

  savePoster(filePath) {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        wx.showToast({ title: "海报已保存到相册", icon: "none" });
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
    wx.previewImage({ urls: [filePath], current: filePath });
  },
});
