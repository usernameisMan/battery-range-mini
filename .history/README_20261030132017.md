# battery-range-mini

电动车续航工具小程序（原生小程序，无需框架）。

- **计算器**：按电池 / 电机 / 载重 / 气温 / 路况估算真实续航与百公里电耗
- **续航地图**：在地图上看"当前电量能跑多远"，选目的地判断"能不能到、到哪里为止"，不够时推荐沿途补电点
- **计算租买回本**：按跑单净收入算"多久挣回买车钱"，同时给出租车 / 买车总花费对比与成本曲线
- **骑士性格**：12 道情景题测 6 个维度，出六维雷达图与角色海报（娱乐向）

## 目录结构

```
config.js                  腾讯位置服务 Key、续航圈与补电算法参数、缓存 TTL
app.json                   页面注册、自定义 tabBar、位置权限与隐私声明
utils/geo.js               haversine / decodePolyline / cumulativeDistances / splitByDistance / pointToPolylineDistance
utils/planner.js           补电推荐：候选采集、过滤、评分、多段贪心规划（纯函数）
utils/qqmap.js             腾讯位置服务 WebService 封装：并发 3、失败重试 1 次、TTL 缓存、sig 签名、错误码翻译
utils/md5.js               纯 JS MD5，用于计算 WebService 的 sig
utils/rentbuy.js           回本计算
utils/quiz.js              骑士性格测试：维度、题库、评分与角色映射（纯函数）
utils/serviceTip.js        客服联系提示（每个版本首次进入弹一次）
pages/index/               续航计算器
pages/rangeMap/            续航地图（wxml / wxss / js / json）
pages/payback/             回本与租买计算器
pages/quiz/                骑士性格测试（引导 / 答题 / 结果 + 雷达图海报）
assets/                    地图 marker 图标
assets/miniprogram-code.png 海报右下角的小程序码（需自行下载放置，缺失时画虚线占位）
tests/range.test.js        续航地图核心算法测试（Node 运行）
```

## 续航地图：上线前必须配置的四件事

### 1. 申请腾讯位置服务 Key

1. 打开 <https://lbs.qq.com/dev/console/key/manage>，用微信扫码登录
2. 「应用管理 → 创建应用」→ 在应用下「添加 Key」
3. 勾选 **WebService API** 用途，建议同时：
   - 绑定小程序 AppID（或开启签名校验），避免 Key 被滥用
   - 设置每日调用量上限与告警（个人开发者额度有限）
4. 把 Key 填到 [config.js](config.js) 的 `QQ_MAP_KEY`
5. 若开启了 **SN 校验**，把控制台生成的 Secret Key 填到 `QQ_MAP_SK`，[utils/qqmap.js](utils/qqmap.js) 会自动计算并附带 `sig`

常见报错对照：

| status | 含义 | 处理 |
| --- | --- | --- |
| 199 | 此 Key 未开启 WebServiceAPI 功能 | 回到 Key 设置，在「启用产品」中勾选 WebServiceAPI |
| 111 | 签名校验失败 | 检查 `QQ_MAP_SK` 是否与该 Key 的 SK 一致 |
| 110 / 112 | 来源 / IP 未被授权 | 在 Key 设置中配置授权域名、授权 IP，或留空不限制 |
| 113 | 该接口未被授权 | 在控制台「配额申请」中申请对应接口 |

> 小程序端无法真正保密 Key（SK 也会被打包进代码），务必在腾讯后台做来源限制（AppID / 域名 / 签名），线上更推荐用自己的服务端中转。

### 2. 配置 request 合法域名

小程序后台 → 开发 → 开发管理 → 开发设置 → 服务器域名 → **request 合法域名**，添加：

```
https://apis.map.qq.com
```

未配置时真机上报 `request:fail url not in domain list`，`qqmap.js` 会返回「请求来源未被授权」类提示。

### 3. 位置权限与隐私声明

已在 [app.json](app.json) 配置：

```json
"permission": { "scope.userLocation": { "desc": "用于计算你的续航可达范围与到目的地的路线" } },
"requiredPrivateInfos": ["getLocation", "chooseLocation"]
```

还需要在小程序后台「设置 → 服务内容声明 → 用户隐私保护指引」中申报 **位置信息** 的使用目的，否则 `wx.getLocation` / `wx.chooseLocation` 会直接失败。

页面内的隐私流程：

- 首次进入弹出说明（`rangeMapPrivacyAck` 记录已读）
- 同意 → `wx.requirePrivacyAuthorize` + `wx.getLocation({ type: 'gcj02' })`
- 拒绝 / 定位失败 → 提示「重新授权」（`wx.openSetting`）与「手动选起点」（`wx.chooseLocation`）两条降级路径

### 4. 基础库版本

| 能力 | 最低基础库 |
| --- | --- |
| `map` 同层渲染（普通 view 覆盖地图，不使用 cover-view） | 2.9.0 |
| `requiredPrivateInfos` 生效 | 2.21.3 |
| `wx.requirePrivacyAuthorize` / `onNeedPrivacyAuthorization` | 2.32.3 |

项目 `project.config.json` 的 `libVersion` 为 `3.0.0`。**低于 2.9.0 时地图上的搜索框、结果条、底部卡片会被原生地图盖住**；低于 2.32.3 时隐私授权接口不存在（代码里做了存在性判断，会退化为直接请求定位）。

## 续航地图的数据来源

从 `wx.getStorageSync('rangeCalc')` 读取续航计算器结果：

```js
{ fullRangeKm, whPerKm, batteryText, vehicleText, speed, updatedAt }
```

由 [pages/index/index.js](pages/index/index.js) 在每次计算后写入；同时兼容旧版 `rangeCalcSummary`（`rangeKm` → `fullRangeKm`）。都读不到时页面顶部提示「请先去续航计算器计算」，并提供手动填写满电续航的输入框。

页面内可调：

- 当前电量 SOC：5% ~ 100%，默认 80%
- 安全预留：10 / 15 / 20 / 30%，默认 15%
- 往返开关：开启后目标距离按单程 × 2 判断
- 绕路系数（更多设置）：60% ~ 90%，默认 70%，决定续航圈半径 = `real × 系数`

```
real   = fullRangeKm × SOC × (1 − 预留)
theory = fullRangeKm × SOC
```

## 补电点数据说明

- 默认调用腾讯位置服务 `/ws/place/v1/search`（`boundary=nearby(lat,lng,1000)`）检索真实 POI
- 沿途搜不到时提示「沿途未检索到补电点，建议在电量用尽点之前自备充电方案」，并标出「最远可达点」
- 想在没有 Key 的环境下看交互效果：把 `config.js` 的 `DEMO.useMockStations` 改为 `true`，会用沿路的**示例假站点**（明确标注"演示数据"）。上线前必须改回 `false`
- 站点仅作位置展示，点击只调用 `wx.openLocation`，不做自研导航、不预约、不支付

固定免责文案（页面常驻）：
> 续航为估算值，未考虑坡度、风向、载重变化，补电点数据来自地图服务，是否可用以现场为准。

## 运行测试

```bash
node tests/range.test.js
```

用例与手算验证：

1. `fullRange=100km, SOC=80%, 预留=15%` → `real=68km`；路线 50km 全程实线；到达剩余 `80% − 50/100 = 30%`，预留后可用里程余 `68 − 50 = 18km`
2. 路线 90km → 断点 `P_limit` 落在 68km，虚线 22km，判定「无法直达，缺 22km」
3. `decodePolyline` 按 `coors[i] = coors[i−2] + coors[i]/1000000` 还原绝对坐标
4. 90km 路线、25km / 60km 各一个换电站 → 选 60km 处（位置分更高），换电到 100% 后全程可达，补电耗时 3 分钟
5. 补充：往返开关下可用里程减半；无站点时给出「最远可达点」

## 缓存与限流

- 位置变化 < 200m 且参数未变：不重绘、不重新请求
- 路线结果按「起点网格 + 终点」缓存 10 分钟；POI 结果按采样点缓存 30 分钟（`wx.setStorageSync`）
- 单次规划请求上限 15 次（`PLANNER.maxRequestsPerPlan`），超出时自动放大采样间隔
- 接口报错（额度用尽 / 网络失败 / Key 无效）给出中文提示，页面保持可用
