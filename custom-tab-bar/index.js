// 自定义底部导航：自定义样式才能和现有界面保持一致
Component({
  data: {
    selected: 0,
    list: [
      { pagePath: "/pages/index/index", icon: "🔋", text: "计算器" },
      { pagePath: "/pages/range-map/index", icon: "🗺️", text: "续航规划" },
      { pagePath: "/pages/payback/index", icon: "💰", text: "计算租买回本" },
    ],
  },

  methods: {
    onSwitchTab(e) {
      const index = Number(e.currentTarget.dataset.index);
      const path = e.currentTarget.dataset.path;
      if (index === this.data.selected) return;
      this.setData({ selected: index });
      wx.switchTab({ url: path });
    },
  },
});
