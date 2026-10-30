// 续航地图核心算法测试（Node 直接运行：node tests/range.test.js）
// 覆盖：续航口径与分段、P_limit 定位、polyline 解压、补电贪心规划
const assert = require("assert");
const geo = require("../utils/geo");
const planner = require("../utils/planner");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`\x1b[32mPASS\x1b[0m ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`\x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`     ${err.message}`);
  }
}
function near(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label || "值"} 期望 ${expected}±${tolerance}，实际 ${actual}`
  );
}

// 构造一条正北方向的直线路线：折点间距 step 米，累计里程与直线距离严格一致
const BASE = { latitude: 30, longitude: 120 };
function lineRoute(totalM, step) {
  const points = [{ ...BASE }];
  for (let d = step; d < totalM; d += step) points.push(geo.offsetLatitude(BASE, d));
  points.push(geo.offsetLatitude(BASE, totalM));
  return { points, cum: geo.cumulativeDistances(points) };
}
// 路线上距起点 along 米处的站点（贴线，绕路为 0）
function stationAt(along) {
  return geo.offsetLatitude(BASE, along);
}

const FULL_RANGE_KM = 100;
const SOC = 0.8;
const RESERVE = 0.15;
// 手算：real = 100 × 0.8 × (1 − 0.15) = 68 km
const REAL_M = FULL_RANGE_KM * SOC * (1 - RESERVE) * 1000;

// ---------------------------------------------------------------- 用例 1
test("用例1：real=68km，路线 50km → 全程实线，到达剩余 30%（余 18km 可用）", () => {
  near(REAL_M, 68000, 0.001, "可用续航 real");
  const { points, cum } = lineRoute(50000, 500);
  const total = cum[cum.length - 1];
  near(total, 50000, 0.05, "路线总长");

  const split = geo.splitByDistance(points, Math.min(REAL_M, total));
  assert.strictEqual(split.tail.length, 0, "路线在可用续航内，不应有虚线");
  assert.ok(split.head.length > 1, "应有实线段");

  // 手算：耗电 50km / 100km = 50%，SOC 80% − 50% = 30%
  const usedPct = (total / (FULL_RANGE_KM * 1000)) * 100;
  const remainPct = SOC * 100 - usedPct;
  near(usedPct, 50, 0.01, "耗电百分比");
  near(remainPct, 30, 0.01, "到达剩余电量");
  // 题设的"约 20%"，对应的是预留后可用里程的余量：68 − 50 = 18km
  near((REAL_M - total) / 1000, 18, 0.01, "剩余可用里程");
  assert.ok(remainPct >= RESERVE * 100, "剩余应高于预留，判定为可直达");
});

// ---------------------------------------------------------------- 用例 2
test("用例2：路线 90km → P_limit 落在 68km，虚线 22km，判定不够", () => {
  const { points, cum } = lineRoute(90000, 500);
  const total = cum[cum.length - 1];
  near(total, 90000, 0.05, "路线总长");

  const split = geo.splitByDistance(points, REAL_M);
  // 断点：距起点 68km（沿路线直线，因此纬度位移可直接换算）
  const alongJunction = geo.haversine(BASE, split.junction);
  near(alongJunction, 68000, 1, "P_limit 位置");

  const tailLength =
    geo.cumulativeDistances(split.tail)[split.tail.length - 1];
  near(tailLength, 22000, 1, "虚线长度");

  const shortfallKm = (total - REAL_M) / 1000;
  near(shortfallKm, 22, 0.001, "缺口里程");
  const remainPct = SOC * 100 - (total / (FULL_RANGE_KM * 1000)) * 100;
  near(remainPct, -10, 0.01, "到达剩余电量（可为负）");
  assert.ok(remainPct < 0, "剩余为负，判定为无法直达");
});

// ---------------------------------------------------------------- 用例 3
test("用例3：decodePolyline 按 coors[i-2] + coors[i]/1000000 还原绝对坐标", () => {
  // 手算：
  // [0] 39.984154, [1] 116.307490 为绝对坐标
  // [2] +1.000000 → 纬度 40.984154；[3] +2.000000 → 经度 118.307490
  // [4] −0.500000 → 纬度 40.484154；[5] −1.000000 → 经度 117.307490
  const coors = [39.984154, 116.30749, 1000000, 2000000, -500000, -1000000];
  const points = geo.decodePolyline(coors);
  assert.strictEqual(points.length, 3);
  near(points[0].latitude, 39.984154, 1e-9, "第1点纬度");
  near(points[0].longitude, 116.30749, 1e-9, "第1点经度");
  near(points[1].latitude, 40.984154, 1e-9, "第2点纬度");
  near(points[1].longitude, 118.30749, 1e-9, "第2点经度");
  near(points[2].latitude, 40.484154, 1e-9, "第3点纬度");
  near(points[2].longitude, 117.30749, 1e-9, "第3点经度");
  // 异常输入不应抛错
  assert.deepStrictEqual(geo.decodePolyline([]), []);
  assert.deepStrictEqual(geo.decodePolyline(null), []);
});

// ---------------------------------------------------------------- 用例 4
test("用例4：90km 路线、25km/60km 各一个换电站 → 选 60km 那站，换电后全程可达", () => {
  const { points, cum } = lineRoute(90000, 500);
  const total = cum[cum.length - 1];

  const pois = [25, 60].map((km, index) => {
    const p = stationAt(km * 1000);
    return {
      id: `swap-${km}`,
      title: index === 0 ? "换电柜 A" : "换电站 B",
      address: "路线旁",
      category: "换电站",
      location: { lat: p.latitude, lng: p.longitude },
    };
  });

  const candidates = planner.buildCandidates({ pois, points, cum, reachM: total });
  assert.strictEqual(candidates.length, 2);

  // 评分对比：60km 处位置分更高（可达范围的 88%，峰值 90%）
  const scored = planner.scoreCandidates(candidates, {
    from: 0,
    usable: REAL_M,
    preference: "swap",
  });
  near(scored[0].alongRoute, 60000, 1, "最高分站点在 60km 处");
  assert.ok(scored[0].score > scored[1].score, "60km 站得分应高于 25km 站");

  const result = planner.planCharging({
    total,
    real: REAL_M,
    fullRangeKm: FULL_RANGE_KM,
    whPerKm: 15,
    soc: SOC,
    reserve: RESERVE,
    preference: "swap",
    candidates,
  });

  assert.strictEqual(result.feasible, true, "换电后应可全程可达");
  assert.strictEqual(result.stations.length, 1, "只需 1 站");
  assert.strictEqual(result.stations[0].id, "swap-60");
  near(result.stations[0].alongRoute, 60000, 1, "站点投影里程");
  // 手算：到站电量 = 80% − 60km/100km = 20%
  assert.strictEqual(result.stations[0].arriveSoc, 20);
  // 换电固定 3 分钟
  assert.strictEqual(result.stations[0].chargeMinutes, 3);
  // 两段都可达：0~60km（≤68km）、60~90km（换电后可用 85km ≥ 30km）
  assert.strictEqual(result.segments.length, 2);
  near(result.segments[0].to - result.segments[0].from, 60000, 1, "第一段长度");
  near(result.segments[1].to - result.segments[1].from, 30000, 1, "第二段长度");
  assert.ok(result.segments.every((seg) => seg.ok), "两段都应可达");
});

// ---------------------------------------------------------------- 补充：往返与无站点
test("补充：往返开关下可用里程减半；沿途无站点时给出最远可达点", () => {
  const { points, cum } = lineRoute(90000, 500);
  const total = cum[cum.length - 1];

  const empty = planner.planCharging({
    total,
    real: REAL_M,
    fullRangeKm: FULL_RANGE_KM,
    whPerKm: 15,
    soc: SOC,
    reserve: RESERVE,
    candidates: [],
  });
  assert.strictEqual(empty.feasible, false);
  near(empty.limitM, 68000, 1, "最远可达点");

  const noStation = empty.message.indexOf("沿途未检索到补电点") === 0;
  assert.ok(noStation, `无站点提示不符：${empty.message}`);

  const roundTrip = planner.planCharging({
    total: 30000,
    real: REAL_M,
    roundTrip: true,
    fullRangeKm: FULL_RANGE_KM,
    whPerKm: 15,
    soc: SOC,
    reserve: RESERVE,
    candidates: [],
  });
  // 往返 30km：单程只能走 68/2 = 34km > 30km，仍可直达
  assert.strictEqual(roundTrip.feasible, true);
  // 单程 40km 时往返需 80km > 68km，不可达
  const roundTrip2 = planner.planCharging({
    total: 40000,
    real: REAL_M,
    roundTrip: true,
    fullRangeKm: FULL_RANGE_KM,
    whPerKm: 15,
    soc: SOC,
    reserve: RESERVE,
    candidates: [],
  });
  assert.strictEqual(roundTrip2.feasible, false);
  near(roundTrip2.limitM, 34000, 1, "往返最远可达点");
});

console.log(failed ? `\n${failed} 个用例失败` : "\n全部用例通过");
process.exit(failed ? 1 : 0);
