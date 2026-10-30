// 自定义底部导航：自定义样式才能和现有界面保持一致
Component({
  data: {
    selected: 0,
    list: [
      { pagePath: "/pages/index/index", icon: "🔋", text: "计算器" },
      { pagePath: "/pages/rangeMap/index", icon: "🗺️", text: "续航地图" },
      { pagePath: "/pages/payback/index", icon: "💰", text: "租买回本" },
      { pagePath: "/pages/quiz/index", icon: "🏍️", text: "骑士性格" },
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
