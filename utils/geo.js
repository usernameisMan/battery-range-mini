// 地理计算工具：球面距离、腾讯坐标串解压、折线累计里程、按里程拆分、点到折线投影
// 所有坐标统一使用 { latitude, longitude }（gcj02）

const EARTH_RADIUS = 6378137; // 米
const METER_PER_DEG_LAT = (Math.PI / 180) * EARTH_RADIUS; // 1 度纬度约 111319.5 米

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

// 两点球面距离（米）
function haversine(a, b) {
  if (!a || !b) return 0;
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLat = lat2 - lat1;
  const dLng = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 解压腾讯位置服务返回的 polyline 坐标串
// 规则：前两个值为绝对坐标（经纬度），从第 3 个值起为相对偏移量，
// coors[i] = coors[i - 2] + coors[i] / 1000000
function decodePolyline(coors) {
  if (!Array.isArray(coors) || coors.length < 2) return [];
  const points = [];
  let lat = Number(coors[0]);
  let lng = Number(coors[1]);
  if (!isFinite(lat) || !isFinite(lng)) return [];
  points.push({ latitude: lat, longitude: lng });
  for (let i = 2; i + 1 < coors.length; i += 2) {
    lat += Number(coors[i]) / 1000000;
    lng += Number(coors[i + 1]) / 1000000;
    if (!isFinite(lat) || !isFinite(lng)) break;
    points.push({ latitude: lat, longitude: lng });
  }
  return points;
}

// 每个折点的累计里程（米），长度与 points 相同
function cumulativeDistances(points) {
  const list = Array.isArray(points) ? points : [];
  const cum = [];
  let sum = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (i > 0) sum += haversine(list[i - 1], list[i]);
    cum.push(sum);
  }
  return cum;
}

// 在折线上按累计里程取点（线性插值，越界时取端点）
function pointAtDistance(points, cum, distance) {
  if (!points || !points.length) return null;
  if (distance <= 0) return { ...points[0] };
  const total = cum[cum.length - 1];
  if (distance >= total) return { ...points[points.length - 1] };
  for (let i = 1; i < points.length; i += 1) {
    if (cum[i] >= distance) {
      const segLen = cum[i] - cum[i - 1];
      const ratio = segLen > 0 ? (distance - cum[i - 1]) / segLen : 0;
      return {
        latitude: points[i - 1].latitude + (points[i].latitude - points[i - 1].latitude) * ratio,
        longitude: points[i - 1].longitude + (points[i].longitude - points[i - 1].longitude) * ratio,
      };
    }
  }
  return { ...points[points.length - 1] };
}

// 按里程把折线拆成前后两段（junction 为插值得到的精确断点）
// limit <= 0 时整条为 tail；limit >= 总长时整条为 head
function splitByDistance(points, limit) {
  const list = Array.isArray(points) ? points : [];
  const cum = cumulativeDistances(list);
  const total = cum.length ? cum[cum.length - 1] : 0;
  const safeLimit = Math.max(0, Math.min(Number(limit) || 0, total));

  if (list.length < 2 || safeLimit <= 0) {
    return { head: list.length > 1 ? [] : list.slice(), tail: list.slice(), junction: list[0] || null, total };
  }
  if (safeLimit >= total) {
    return { head: list.slice(), tail: [], junction: list[list.length - 1], total };
  }

  let index = 1;
  while (index < list.length - 1 && cum[index] < safeLimit) index += 1;
  const junction = pointAtDistance(list, cum, safeLimit);
  const head = list.slice(0, index).concat([junction]);
  const tail = [junction].concat(list.slice(index));
  return { head, tail, junction, total };
}

// 点到折线的垂距与投影里程
// 用等距投影把经纬度换算成以 point 为原点的米制平面，再求线段投影
function pointToPolylineDistance(point, points, cum) {
  const empty = { distance: Infinity, alongRoute: 0, projection: null };
  if (!point || !Array.isArray(points) || points.length < 2) return empty;

  const latScale = METER_PER_DEG_LAT;
  const lngScale = METER_PER_DEG_LAT * Math.cos(toRadians(point.latitude));
  const toXY = (p) => ({
    x: (p.longitude - point.longitude) * lngScale,
    y: (p.latitude - point.latitude) * latScale,
  });

  const distances = cum || cumulativeDistances(points);
  let best = { distance: Infinity, alongRoute: 0, ratio: 0, segIndex: 0 };

  for (let i = 1; i < points.length; i += 1) {
    const a = toXY(points[i - 1]);
    const b = toXY(points[i]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? -(a.x * dx + a.y * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const dist = Math.sqrt(px * px + py * py);
    if (dist < best.distance) {
      const segLen = distances[i] - distances[i - 1];
      best = {
        distance: dist,
        alongRoute: distances[i - 1] + segLen * t,
        ratio: t,
        segIndex: i - 1,
      };
    }
  }

  if (!isFinite(best.distance)) return empty;
  const projection = {
    latitude: points[best.segIndex].latitude +
      (points[best.segIndex + 1].latitude - points[best.segIndex].latitude) * best.ratio,
    longitude: points[best.segIndex].longitude +
      (points[best.segIndex + 1].longitude - points[best.segIndex].longitude) * best.ratio,
  };
  return { distance: best.distance, alongRoute: best.alongRoute, projection };
}

// 纬度方向偏移指定米数（用于把角标放到圈内）
function offsetLatitude(center, meters) {
  return {
    latitude: center.latitude + meters / METER_PER_DEG_LAT,
    longitude: center.longitude,
  };
}

module.exports = {
  haversine,
  decodePolyline,
  cumulativeDistances,
  pointAtDistance,
  splitByDistance,
  pointToPolylineDistance,
  offsetLatitude,
  METER_PER_DEG_LAT,
};
