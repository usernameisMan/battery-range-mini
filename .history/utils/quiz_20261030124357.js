// 骑士性格测试：题库、评分与角色映射（纯逻辑，可在 Node 中直接 require 测试）
// 声明：娱乐向内容，题目与结论均为主观设定，不构成任何专业测评或建议。

// 六个维度：key 用于计分，short 用于雷达图轴标签
const DIMENSIONS = [
  { key: "route", name: "路线规划", short: "路线", color: "#3b82f6" },
  { key: "reflex", name: "紧急反应", short: "反应", color: "#f59e0b" },
  { key: "gear", name: "配置需求", short: "装备", color: "#8b5cf6" },
  { key: "rage", name: "愤怒指数", short: "脾气", color: "#ef4444" },
  { key: "anxiety", name: "续航焦虑", short: "续航", color: "#10b981" },
  { key: "multi", name: "多单能力", short: "并单", color: "#ec4899" },
];

// 12 道情景题，每个选项给 1~2 个维度加分
const QUESTIONS = [
  {
    id: 1,
    text: "早高峰第一单，商家说出餐还要等 10 分钟，你会",
    options: [
      { text: "顺手把后面几单的路线重排一遍", scores: { route: 2, multi: 2 } },
      { text: "盯着出餐口，顺便把门口车位占好", scores: { reflex: 2, rage: 1 } },
      { text: "把车挪到边上，先充会儿电", scores: { gear: 1, anxiety: 2 } },
    ],
  },
  {
    id: 2,
    text: "你手机支架上一般挂几个 App",
    options: [
      { text: "一个，导航 + 接单够了", scores: { route: 2 } },
      { text: "两三个，比价、抢单、导航分开", scores: { multi: 3 } },
      { text: "支架快撑不住了，还有备用机", scores: { gear: 2, multi: 1 } },
    ],
  },
  {
    id: 3,
    text: "第一次进的城中村，路口四通八达",
    options: [
      { text: "先看地图有没有能穿过去的小路", scores: { route: 3 } },
      { text: "直接骑进去，凭方向感找出口", scores: { reflex: 3 } },
      { text: "先想想这片区还能不能再接一单", scores: { multi: 2, route: 1 } },
    ],
  },
  {
    id: 4,
    text: "电量剩 30%，离目的地还有 8 公里",
    options: [
      { text: "马上搜最近的换电柜", scores: { anxiety: 3 } },
      { text: "关灯、匀速、少刹车，赌一把", scores: { anxiety: 2, reflex: 1 } },
      { text: "先算这单值不值得冲", scores: { route: 2, multi: 1 } },
    ],
  },
  {
    id: 5,
    text: "顾客电话打不通，门禁也进不去",
    options: [
      { text: "按流程上报，拍照留证", scores: { route: 2 } },
      { text: "直接上楼挨层找，比打电话快", scores: { reflex: 3 } },
      { text: "心里已经把对方骂了三遍", scores: { rage: 3 } },
    ],
  },
  {
    id: 6,
    text: "看到同行车灯特别亮、后视镜特别帅",
    options: [
      { text: "无所谓，能跑就行", scores: { route: 1 } },
      { text: "截图存下来，晚上就下单", scores: { gear: 3 } },
      { text: "先问一句在哪买的、多少钱", scores: { gear: 1, multi: 1 } },
    ],
  },
  {
    id: 7,
    text: "高峰期一下派来 3 单，方向还都不一样",
    options: [
      { text: "全接，脑子里自动排序", scores: { multi: 3 } },
      { text: "只挑最顺的一单，其他放掉", scores: { route: 2 } },
      { text: "全接，结果手忙脚乱一路小跑", scores: { multi: 2, reflex: 1 } },
    ],
  },
  {
    id: 8,
    text: "一辆车突然变道别到你前面",
    options: [
      { text: "深呼吸，记住车型，继续跑", scores: { route: 1 } },
      { text: "一嗓子吼出去，追上去理论", scores: { rage: 3 } },
      { text: "立刻绕开，当没发生过", scores: { reflex: 3 } },
    ],
  },
  {
    id: 9,
    text: "平台弹出「今日跑满 40 单有奖励」",
    options: [
      { text: "提前按片区规划，一片一片扫", scores: { route: 2, multi: 1 } },
      { text: "能跑多少算多少，到点就收", scores: { route: 1 } },
      { text: "差 3 单就冲，跑到半夜也要凑满", scores: { multi: 3, rage: 1 } },
    ],
  },
  {
    id: 10,
    text: "你车上最不能少的东西",
    options: [
      { text: "充电宝 / 备用电池", scores: { anxiety: 3 } },
      { text: "工具包 / 备用灯泡", scores: { gear: 3 } },
      { text: "两台手机 + 蓝牙耳机", scores: { multi: 2, reflex: 1 } },
    ],
  },
  {
    id: 11,
    text: "下雨天出门前",
    options: [
      { text: "先看雷达图，避开积水路段", scores: { route: 2, anxiety: 1 } },
      { text: "雨衣一穿，照跑不误", scores: { reflex: 2 } },
      { text: "一想到要淋雨，心情先崩了", scores: { rage: 3 } },
    ],
  },
  {
    id: 12,
    text: "收工回家的路上",
    options: [
      { text: "复盘今天哪条路线最亏", scores: { route: 3 } },
      { text: "看到充电桩就去看看价格", scores: { anxiety: 3 } },
      { text: "打开购物车看改装配件", scores: { gear: 3 } },
    ],
  },
];

// 六个角色，key 与主维度一一对应
const ROLES = [
  {
    key: "route",
    name: "人形导航 · 活地图",
    emoji: "🧭",
    color: "#3b82f6",
    tagline: "别人靠导航，你靠脑子里那张路网",
    desc: "接单前先看方向，一眼就知道哪条巷子能穿、哪个路口会堵。别人多跑两公里，你少等两个红灯。",
    traits: ["路线走一遍就忘不掉", "喜欢把订单按片区串起来", "宁可多绕 200 米也不堵主干道"],
    bestFor: "午晚高峰、写字楼密集区",
    watchOut: "抄近路也要走非机动车道，别逆行、别钻机动车道。",
  },
  {
    key: "reflex",
    name: "闪电骑士",
    emoji: "⚡",
    color: "#f59e0b",
    tagline: "别人还在解锁，你已经到楼下了",
    desc: "反应总比别人快半拍，突然窜出的电动车、突然打开的车门，你都能提前躲开。",
    traits: ["看到单就出发", "避让、变道都很果断", "临时改地址也能立刻换路线"],
    bestFor: "急单多、商圈短途",
    watchOut: "快可以，但别抢秒闯灯，省一分钟可能赔一整天。",
  },
  {
    key: "gear",
    name: "装备党 · 改装大师",
    emoji: "🔧",
    color: "#8b5cf6",
    tagline: "车不是骑坏的，是改好的",
    desc: "车灯、支架、坐垫、储物箱都有自己的讲究，工具箱永远在车上，路上小毛病自己就能修。",
    traits: ["愿意为省力花钱", "对配件价格门儿清", "看到改装贴就手痒"],
    bestFor: "长距离、夜班、雨天",
    watchOut: "别动电路和刹车，改装影响安全时保险可能不赔。",
  },
  {
    key: "rage",
    name: "红温战士",
    emoji: "🌋",
    color: "#ef4444",
    tagline: "一按喇叭，血压就上来了",
    desc: "你对不守规矩的人零容忍，被别一次车能记一整天。嘴上不饶人，但真遇到同行有难还是会搭把手。",
    traits: ["最烦逆行和突然变道", "情绪来得快、去得也快", "对顾客反而很有耐心"],
    bestFor: "熟悉片区、路况稳定的时段",
    watchOut: "别把脾气带上车，路怒最容易出事。",
  },
  {
    key: "anxiety",
    name: "电量守财奴",
    emoji: "🔋",
    color: "#10b981",
    tagline: "电量低于 50%，你就开始找充电桩",
    desc: "出门前必看电量，方圆三公里每个换电柜的位置都在你脑子里。宁可多背一块电池，也不冒险。",
    traits: ["从不把电用到 20% 以下", "清楚每个换电柜的价格", "包里常备充电宝"],
    bestFor: "远单、跨区单",
    watchOut: "别为了省电关大灯，晚上看不清比没电更危险。",
  },
  {
    key: "multi",
    name: "八爪鱼 · 并单王",
    emoji: "🐙",
    color: "#ec4899",
    tagline: "手上没有三单，你都不算上班",
    desc: "能同时盯三个 App，脑子里自带订单排序，再乱的顺路也能一条条送到。",
    traits: ["多单同时推进不慌", "记得住每单的取送顺序", "高峰期效率是别人的两倍"],
    bestFor: "高峰期、订单密集商圈",
    watchOut: "并单别贪多，超时罚款比多跑一单更亏。",
  },
];

const ROLE_BY_KEY = {};
ROLES.forEach((role) => {
  ROLE_BY_KEY[role.key] = role;
});

// 雷达图下限：避免某一维为 0 导致图形塌陷
const FLOOR = 18;

// 每个维度在整份问卷里的最高可能得分（每题取该维度最大权重求和）
function maxScoreByDim() {
  const max = {};
  DIMENSIONS.forEach((d) => {
    max[d.key] = 0;
  });
  QUESTIONS.forEach((q) => {
    const local = {};
    q.options.forEach((opt) => {
      Object.keys(opt.scores).forEach((key) => {
        local[key] = Math.max(local[key] || 0, opt.scores[key]);
      });
    });
    Object.keys(local).forEach((key) => {
      max[key] = (max[key] || 0) + local[key];
    });
  });
  return max;
}

const MAX_BY_DIM = maxScoreByDim();

// 全部作答组合（每题 3 个选项，共 3^12 = 531441 种）在每个维度上的得分分布。
// 用来计算「超过 xx% 的骑手」，属于本测试自身的作答分布，不是真实用户数据。
const DIM_COUNTS = {
  route: [1536, 4608, 11136, 21504, 33024, 47424, 56736, 64704, 64608, 60336, 51720, 40224, 29664, 19452, 12102, 6732, 3408, 1587, 624, 228, 66, 15, 3],
  reflex: [20736, 31104, 36288, 64800, 67392, 64800, 69984, 55080, 42768, 33696, 20412, 12312, 7128, 3078, 1296, 486, 81],
  gear: [34992, 52488, 34992, 96228, 78732, 52488, 78732, 39366, 26244, 24057, 6561, 4374, 2187],
  rage: [69984, 69984, 17496, 104976, 104976, 26244, 52488, 52488, 13122, 8748, 8748, 2187],
  anxiety: [34992, 17496, 52488, 96228, 52488, 78732, 78732, 39366, 39366, 24057, 8748, 6561, 2187],
  multi: [2592, 7776, 14904, 31104, 45684, 58968, 73386, 71604, 68769, 57024, 41148, 28431, 16119, 8343, 3807, 1296, 405, 81],
};

// 预先算好每个原始分对应的百分位，取值 1~99，避免出现「超过 0% / 100%」
const PCT_BY_DIM = {};
DIMENSIONS.forEach((dim) => {
  const counts = DIM_COUNTS[dim.key] || [];
  const total = counts.reduce((sum, item) => sum + item, 0) || 1;
  let cumulative = 0;
  PCT_BY_DIM[dim.key] = counts.map((count) => {
    cumulative += count;
    return Math.min(99, Math.max(1, Math.round((cumulative / total) * 100)));
  });
});

function emptyAnswers() {
  return QUESTIONS.map(() => -1);
}

// answers: 与 QUESTIONS 等长的选项下标数组
function evaluate(answers) {
  const raw = {};
  DIMENSIONS.forEach((d) => {
    raw[d.key] = 0;
  });
  QUESTIONS.forEach((q, index) => {
    const option = q.options[answers[index]];
    if (!option) return;
    Object.keys(option.scores).forEach((key) => {
      raw[key] = (raw[key] || 0) + option.scores[key];
    });
  });

  const dims = DIMENSIONS.map((d) => {
    const max = MAX_BY_DIM[d.key] || 1;
    const ratio = Math.min(1, raw[d.key] / max);
    const table = PCT_BY_DIM[d.key] || [];
    const beat = table[Math.min(table.length - 1, raw[d.key])] || 1;
    return {
      key: d.key,
      name: d.name,
      short: d.short,
      color: d.color,
      percent: Math.round(FLOOR + ratio * (100 - FLOOR)),
      beat,
      beatText: `超过 ${beat}% 的骑手`,
    };
  });

  const sorted = dims.slice().sort((a, b) => b.percent - a.percent);
  const role = ROLE_BY_KEY[sorted[0].key] || ROLES[0];
  const second = sorted[1] || sorted[0];

  return {
    raw,
    dims,
    role,
    secondName: second.name,
    top: sorted.slice(0, 3),
    answered: answers.filter((v) => v >= 0).length,
  };
}

module.exports = {
  DIMENSIONS,
  QUESTIONS,
  ROLES,
  FLOOR,
  MAX_BY_DIM,
  emptyAnswers,
  evaluate,
};
