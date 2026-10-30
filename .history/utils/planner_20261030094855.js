// 智能补电推荐：候选采集、过滤、评分、多段贪心规划
// 除 collectCandidates（需要注入搜索函数）外，其余都是可单测的纯函数

const config = require("../config");
const geo = require("./geo");

const SWAP_RE = /换电/;
const FAST_RE = /快充|超充|直流/;
const CAR_ONLY_RE = /汽车充电|汽车快充|汽车慢充/;
const BIKE_RE = /电动自行车|电瓶车|电动车/;
const BRAND_RE = /特斯拉|蔚来|小鹏|理想|极氪|比亚迪|问界|埃安/;

const TYPE_LABEL = { swap: "换电", fast: "快充", charge: "充电" };

function round1(n) {
  return Math.round(n * 10) / 10;
}

// 归一化腾讯 POI 字段（兼容 location:{lat,lng} 与扁平结构）
function normalizePoi(raw) {
  if (!raw) return null;
  const loc = raw.location || {};
  const latitude = Number(raw.latitude != null ? raw.latitude : loc.lat);
  const longitude = Number(raw.longitude != null ? raw.longitude : loc.lng);
  if (!isFinite(latitude) || !isFinite(longitude)) return null;
  let id = raw.id || raw.poi_id || `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  return {
    id: String(id),
    name: String(raw.title || raw.name || "未命名站点"),
    address: String(raw.address || ""),
    category: String(raw.category || ""),
    latitude,
    longitude,
  };
}

// 站点类型：换电 / 快充 / 充电 / 其他
function classifyStation(poi) {
  const text = `${poi.name} ${poi.category}`;
  if (SWAP_RE.test(text)) return "swap";
  if (FAST_RE.test(text)) return "fast";
  if (/充电/.test(text)) return "charge";
  return "other";
}

// 候选过滤：垂距、可达范围、汽车专用站、去重
function buildCandidates(input) {
  const points = input.points || [];
  const cum = input.cum || geo.cumulativeDistances(points);
  const maxDetour = input.maxDetour || config.PLANNER.maxDetour;
  const reach = input.reachM == null ? Infinity : input.reachM;
  const seen = new Set();
  const result = [];

  (input.pois || []).forEach((raw) => {
    const poi = normalizePoi(raw);
    if (!poi || seen.has(poi.id)) return;
    seen.add(poi.id);

    const type = classifyStation(poi);
    if (type === "other") return;
    // 明显只服务汽车的站点直接排除（明确写了电动自行车的保留）
    if (CAR_ONLY_RE.test(poi.category) && !BIKE_RE.test(poi.category)) return;

    const proj = geo.pointToPolylineDistance(
      { latitude: poi.latitude, longitude: poi.longitude },
      points,
      cum
    );
    if (!isFinite(proj.distance)) return;
    if (proj.distance > maxDetour) return;
    if (proj.alongRoute > reach) return;

    result.push({
      ...poi,
      type,
      typeLabel: TYPE_LABEL[type],
      detour: proj.distance * 2, // 往返绕路
      alongRoute: proj.alongRoute,
      brandOnly: BRAND_RE.test(poi.name),
    });
  });

  return result;
}

// 各偏好下的类型分（换电 > 快充 > 普通充电）
function typeScore(type, preference) {
  const table = {
    swap: { swap: 1, fast: 0.7, charge: 0.4 },
    charge: { swap: 0.4, fast: 0.75, charge: 1 },
    time: { swap: 1, fast: 0.75, charge: 0.35 },
    detour: { swap: 0.85, fast: 0.7, charge: 0.7 },
  };
  const row = table[preference] || table.swap;
  return row[type] == null ? 0.3 : row[type];
}

function pickWeights(preference, options) {
  const weights = (options && options.weights) || config.PLANNER.weights;
  return weights[preference] || weights.swap;
}

// 单站评分：位置 0.4 / 绕路 0.25 / 类型 0.2 / 可靠性 0.15（按偏好微调）
function scoreCandidate(candidate, ctx) {
  const options = ctx.options || config.PLANNER;
  const weights = pickWeights(ctx.preference, options);
  const usable = Math.max(1, ctx.usable);
  const peak = options.positionPeak || 0.9;

  // 位置分：越接近"可达极限的 peak（默认 90%）"越高，避免走太满
  const ratio = (candidate.alongRoute - ctx.from) / usable;
  const position = Math.max(0, 1 - Math.abs(ratio - peak) / peak);

  // 绕路分：绕路越短越高
  const detourLimit = (options.maxDetour || 800) * 2;
  const detour = Math.max(0, 1 - Math.min(candidate.detour || 0, detourLimit) / detourLimit);

  const type = typeScore(candidate.type, ctx.preference);

  const reliability = (candidate.name && candidate.address ? 0.6 : 0.3) + (candidate.cluster ? 0.4 : 0);

  const score =
    position * weights.position +
    detour * weights.detour +
    type * weights.type +
    reliability * weights.reliability;

  return {
    ...candidate,
    score: candidate.brandOnly ? score * 0.7 : score, // 品牌专营站降权
    parts: { position, detour, type, reliability },
  };
}

function scoreCandidates(candidates, ctx) {
  const list = (candidates || []).map((item) => ({ ...item }));
  // 聚集点：300m 内还有其他候选站，说明该区域补电资源稳定
  list.forEach((item) => {
    item.cluster = list.some(
      (other) =>
        other.id !== item.id &&
        geo.haversine(
          { latitude: item.latitude, longitude: item.longitude },
          { latitude: other.latitude, longitude: other.longitude }
        ) <= 300
    );
  });
  return list
    .map((item) => scoreCandidate(item, ctx))
    .sort((a, b) => b.score - a.score);
}

// 补电耗时：换电固定 3 分钟；充电按 (目标 SOC - 到站 SOC) × 电池 Wh ÷ 功率
function estimateChargeMinutes(input) {
  const options = input.options || config.PLANNER;
  const arriveSoc = Math.max(0, Math.min(1, Number(input.arriveSoc) || 0));
  const targetSoc = Math.max(arriveSoc, Math.min(1, Number(input.targetSoc) || 0));
  if (input.type === "swap") return options.swapMinutes || 3;

  const batteryWh = Math.max(1, Number(input.batteryWh) || 1);
  const powerW = Math.max(50, Number(input.chargePowerW) || options.chargePowerW || 250);
  const needWh = (targetSoc - arriveSoc) * batteryWh;
  return Math.max(1, Math.round((needWh / powerW) * 60));
}

// 多段贪心规划
function planCharging(input) {
  const options = Object.assign({}, config.PLANNER, input.options || {});
  const total = Math.max(0, Number(input.total) || 0);
  const real = Math.max(0, Number(input.real) || 0);
  const fullRangeM = Math.max(1, (Number(input.fullRangeKm) || 0) * 1000);
  const reserve = Math.max(0, Math.min(0.9, Number(input.reserve) || 0));
  const preference = input.preference || "swap";
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const batteryWh = fullRangeM * Math.max(1, Number(input.whPerKm) || 11);
  const roundTrip = !!input.roundTrip;

  let soc = Math.max(0, Math.min(1, Number(input.soc) || 0));
  let prevAlong = 0;
  // 往返时单程只能用到一半可用续航
  let usable = roundTrip ? real / 2 : real;
  let feasible = true;
  let limitM = Math.min(real, total);
  const stations = [];
  const segments = [];

  for (let step = 0; step <= options.maxStations; step += 1) {
    const remain = total - prevAlong;
    if (remain <= 0) break;

    if (usable >= remain) {
      segments.push({ from: prevAlong, to: total, ok: true, usable });
      limitM = total;
      break;
    }

    const reach = prevAlong + usable;
    const pool = candidates.filter(
      (item) => item.alongRoute > prevAlong + options.minGap && item.alongRoute <= reach
    );

    if (!pool.length || step === options.maxStations) {
      // 要么沿途没有站点，要么已经用满 3 站仍不可达
      feasible = false;
      segments.push({ from: prevAlong, to: Math.min(reach, total), ok: true, usable });
      if (reach < total) segments.push({ from: reach, to: total, ok: false, usable: 0 });
      limitM = Math.min(reach, total);
      break;
    }

    const best = scoreCandidates(pool, {
      from: prevAlong,
      usable,
      preference,
      options,
    })[0];

    const legDistance = best.alongRoute - prevAlong;
    const arriveSoc = Math.max(0, soc - legDistance / fullRangeM);
    const targetSoc = best.type === "swap" ? options.swapTargetSoc : options.chargeTargetSoc;
    const chargeMinutes = estimateChargeMinutes({
      type: best.type,
      arriveSoc,
      targetSoc,
      batteryWh,
      options,
    });

    stations.push({
      order: stations.length + 1,
      id: best.id,
      name: best.name,
      address: best.address,
      type: best.type,
      typeLabel: best.typeLabel,
      latitude: best.latitude,
      longitude: best.longitude,
      alongRoute: best.alongRoute,
      distanceKm: round1(legDistance),
      detourKm: round1((best.detour || 0) / 1000),
      arriveSoc: Math.round(arriveSoc * 100),
      chargeMinutes,
      score: Math.round(best.score * 100) / 100,
    });

    segments.push({ from: prevAlong, to: best.alongRoute, ok: true, usable });

    prevAlong = best.alongRoute;
    soc = targetSoc;
    usable = (fullRangeM * soc * (1 - reserve)) / (roundTrip ? 2 : 1);
    limitM = Math.min(total, prevAlong + usable);
  }

  // 自检：所有"可达"段都不能超过该段起点的可用续航
  const distanceOk = segments.every((seg) => {
    if (!seg.ok) return true;
    return seg.to - seg.from <= seg.usable + 1;
  });

  let message = "";
  if (!feasible) {
    message = stations.length >= options.maxStations
      ? "路线较长，建议分多次出行；或先到列表中最近的补电点补满再出发。"
      : "沿途未检索到补电点，建议在电量用尽点之前自备充电方案。";
  } else if (!stations.length) {
    message = "当前电量足够直达，无需补电。";
  } else {
    message = `建议补电 ${stations.length} 站，按顺序补满即可到达。`;
  }

  return {
    stations,
    segments,
    feasible: feasible && distanceOk,
    limitM,
    message,
  };
}

// 候选采集：沿路线每 interval 米采样，每个采样点搜两类关键词
// searchNearby({ latitude, longitude, radius, keyword }) => Promise<poi[]>
async function collectCandidates(input) {
  const options = Object.assign({}, config.PLANNER, input.options || {});
  const points = input.points || [];
  const cum = input.cum || geo.cumulativeDistances(points);
  const total = input.total == null ? (cum.length ? cum[cum.length - 1] : 0) : input.total;
  const real = Math.max(1000, Number(input.usableNow) || 1000);
  const theory = Math.max(real, Number(input.theoryM) || real);
  const searchNearby = input.searchNearby;
  if (typeof searchNearby !== "function" || points.length < 2) return [];

  const sampleEnd = Math.min(total, theory * 1.1);
  const keywordGroups = ["换电 换电柜 换电站", "充电站 充电桩"];
  const maxRequests = options.maxRequestsPerPlan;

  let interval = Math.max(500, Math.min(options.sampleInterval, real * options.sampleMaxRatio));
  // 采样点过多时自动放大间隔，保证请求数不超过上限（限流）
  const allowedSamples = Math.max(1, Math.floor(maxRequests / keywordGroups.length));
  if (sampleEnd / interval > allowedSamples) interval = sampleEnd / allowedSamples;

  const pois = new Map();
  let requests = 0;

  for (let d = 0; d <= sampleEnd + 1; d += interval) {
    if (requests + keywordGroups.length > maxRequests) break;
    const sample = geo.pointAtDistance(points, cum, d);
    if (!sample) break;
    for (let k = 0; k < keywordGroups.length; k += 1) {
      requests += 1;
      try {
        const list = await searchNearby({
          latitude: sample.latitude,
          longitude: sample.longitude,
          radius: options.searchRadius,
          keyword: keywordGroups[k],
        });
        (list || []).forEach((raw) => {
          const poi = normalizePoi(raw);
          if (poi && !pois.has(poi.id)) pois.set(poi.id, poi);
        });
      } catch (e) {
        // 单个采样点失败不影响整体规划
      }
    }
    if (typeof input.onProgress === "function") {
      input.onProgress({ requests, distance: d, sampleEnd });
    }
  }

  return buildCandidates({
    pois: Array.from(pois.values()),
    points,
    cum,
    maxDetour: options.maxDetour,
    reachM: total,
  });
}

module.exports = {
  normalizePoi,
  classifyStation,
  buildCandidates,
  scoreCandidate,
  scoreCandidates,
  estimateChargeMinutes,
  planCharging,
  collectCandidates,
  TYPE_LABEL,
};
