/**
 * 客服联系提示
 * 每个版本、每个用户只弹一次（首次进入小程序或版本更新后）。
 * 开发版 / 体验版拿不到线上版本号，退化为「环境 + 手动版本」，改文案时把 TIP_VERSION +1 即可重新提示。
 */
const TIP_STORAGE_KEY = "serviceTipVersion";
const TIP_VERSION = "1";

let shownThisSession = false;

function currentVersionKey() {
  let version = "";
  let envVersion = "";
  try {
    const info = wx.getAccountInfoSync();
    const program = (info && info.miniProgram) || {};
    version = program.version || "";
    envVersion = program.envVersion || "";
  } catch (e) {
    // 基础库过低时不支持该接口，走兜底
  }
  return version || `${envVersion || "unknown"}:${TIP_VERSION}`;
}

function maybeShowServiceTip() {
  if (shownThisSession) return;
  const key = currentVersionKey();
  let seen = "";
  try {
    seen = wx.getStorageSync(TIP_STORAGE_KEY) || "";
  } catch (e) {
    // 存储不可用时直接展示，不阻塞使用
  }
  if (seen === key) return;
  shownThisSession = true;
  try {
    wx.setStorageSync(TIP_STORAGE_KEY, key);
  } catch (e) {
    // 忽略写入失败
  }
  // 等首页首帧渲染完再弹，避免真机上偶发弹不出来
  setTimeout(() => {
    wx.showModal({
      title: "使用提示",
      content:
        "有疑问、遇到问题或有功能需求，可以点右上角「···」→ 点小程序名称进入主页，联系在线客服。",
      showCancel: false,
      confirmText: "知道了",
      confirmColor: "#1677FF",
    });
  }, 400);
}

module.exports = { maybeShowServiceTip };
