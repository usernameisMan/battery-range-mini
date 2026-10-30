// 回本与租买计算器（占位页，功能待开发）
Page({
  data: {
    topSafeArea: 0,
  },

  onLoad() {
    this.setupSafeArea();
  },

  onShow() {
    this.updateTabBar();
  },

  setupSafeArea() {
    try {
      const menuButton = wx.getMenuButtonBoundingClientRect();
      this.setData({ topSafeArea: menuButton.top });
    } catch (e) {
      this.setData({ topSafeArea: 40 });
    }
  },

  updateTabBar() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
  },

  goCalculator() {
    wx.switchTab({ url: "/pages/index/index" });
  },
});
