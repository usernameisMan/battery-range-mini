// 腾讯位置服务 WebService 封装：并发限制 3、失败重试 1 次、结果缓存、签名（sig）、错误码翻译
const config = require("../config");
const geo = require("./geo");
const md5 = require("./md5");

const MAX_CONCURRENT = 3;
const queue = [];
let running = 0;
let requestTotal = 0;

const ERROR_TEXT = {
  110: "请求来源未被授权，请在腾讯位置服务后台为该 Key 配置授权域名或授权 IP",
  111: "签名校验失败，请检查 config.js 中的 QQ_MAP_SK 是否与控制台一致",
  112: "IP 未被授权，请在腾讯位置服务后台配置 IP 白名单",
  113: "该接口未被授权，请在腾讯位置服务后台申请对应接口权限",
  120: "接口调用量已超出当日配额，请稍后再试或提升额度",
  121: "接口并发超出限制，请稍后重试",
  122: "接口调用量已达上限，请明天再试",
  190: "Key 无效，请检查 config.js 中的 QQ_MAP_KEY",
  199: "此 Key 未开启 WebServiceAPI 功能，请在腾讯位置服务后台「Key 设置」的启用产品中勾选 WebServiceAPI",
  300: "请求参数错误",
  311: "Key 格式错误",
  347: "无结果（检索范围为空）",
};

function buildError(status, message) {
  const text = ERROR_TEXT[status] || message || `地图服务返回错误（${status}）`;
  const err = new Error(text);
  err.status = status;
  err.retryable = status === 121 || status === 122;
  return err;
}

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drain();
  });
}

function drain() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running += 1;
    job
      .task()
      .then(job.resolve, job.reject)
      .then(() => {
        running -= 1;
        drain();
      });
  }
}

function hasSecretKey() {
  const sk = String(config.QQ_MAP_SK || "");
  return sk.length > 0 && sk.indexOf("请替换") !== 0;
}

// 签名：md5(请求路径 + "?" + 参数按参数名升序拼接 + SK)，参数必须用未经编码的原始值
function sign(path, params) {
  const query = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join("&");
  return md5(`${path}?${query}${config.QQ_MAP_SK}`);
}

function once(path, data) {
  return new Promise((resolve, reject) => {
    if (!config.QQ_MAP_KEY || config.QQ_MAP_KEY.indexOf("请替换") === 0) {
      reject(new Error("未配置腾讯位置服务 Key，请在 config.js 中填写 QQ_MAP_KEY"));
      return;
    }
    const params = Object.assign({ key: config.QQ_MAP_KEY, output: "json" }, data);
    // 控制台开启 SN 校验后必须带 sig，否则会返回 111
    if (hasSecretKey()) params.sig = sign(path, params);
    requestTotal += 1;
    wx.request({
      url: config.QQ_MAP_HOST + path,
      method: "GET",
      timeout: 8000,
      data: params,
      success(res) {
        const body = res.data || {};
        const status = Number(body.status);
        if (status === 0) {
          resolve(body);
          return;
        }
        reject(buildError(status, body.message));
      },
      fail() {
        const err = new Error("网络请求失败，请检查网络后重试");
        err.retryable = true;
        reject(err);
      },
    });
  });
}

function request(path, data) {
  return enqueue(() =>
    once(path, data).catch((err) => {
      if (err && err.retryable) return once(path, data);
      throw err;
    })
  );
}

// ---------- 缓存 ----------
function hash(text) {
  let h = 5381;
  const str = String(text || "");
  for (let i = 0; i < str.length; i += 1) {
    h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function grid(lat, lng) {
  const size = config.CACHE.gridSize;
  return `${(Math.round(lat / size) * size).toFixed(2)}_${(Math.round(lng / size) * size).toFixed(2)}`;
}

function readCache(key, ttl) {
  try {
    const cache = wx.getStorageSync(key);
    if (cache && cache.t && Date.now() - cache.t < ttl) return cache.v;
  } catch (e) {
    // 读缓存失败按未命中处理
  }
  return null;
}

function writeCache(key, value) {
  try {
    wx.setStorageSync(key, { t: Date.now(), v: value });
  } catch (e) {
    // 写缓存失败不影响主流程
  }
}

// ---------- 业务接口 ----------

// 电单车路线规划：返回 { distance（米）, duration（秒）, points, cum }
async function directionEbicycling(input) {
  const from = input.from;
  const to = input.to;
  const key = `qqmap_route_${grid(from.latitude, from.longitude)}_${grid(to.latitude, to.longitude)}`;
  const cached = readCache(key, config.CACHE.routeTtlMs);
  if (cached && cached.polyline && cached.polyline.length >= 2) {
    const points = geo.decodePolyline(cached.polyline);
    return {
      distance: cached.distance,
      duration: cached.duration,
      points,
      cum: geo.cumulativeDistances(points),
      cached: true,
    };
  }

  const body = await request("/ws/direction/v1/ebicycling/", {
    from: `${from.latitude},${from.longitude}`,
    to: `${to.latitude},${to.longitude}`,
  });

  const routes = body.result && body.result.routes;
  const route = routes && routes[0];
  if (!route || !route.polyline || route.polyline.length < 2) {
    throw new Error("未获取到可用路线，请换个目的地试试");
  }

  const payload = {
    distance: Number(route.distance) || 0,
    duration: Number(route.duration) || 0,
    polyline: route.polyline,
  };
  writeCache(key, payload);

  const points = geo.decodePolyline(payload.polyline);
  const cum = geo.cumulativeDistances(points);
  return {
    distance: payload.distance || cum[cum.length - 1],
    duration: payload.duration,
    points,
    cum,
    cached: false,
  };
}

// 周边站点检索：返回 [{ id, title, address, category, location: { lat, lng } }]
async function searchNearby(input) {
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const radius = Math.min(1000, Math.max(100, Number(input.radius) || 1000));
  const keyword = input.keyword || "充电站";
  const key = `qqmap_poi_${latitude.toFixed(3)}_${longitude.toFixed(3)}_${radius}_${hash(keyword)}`;

  const cached = readCache(key, config.CACHE.poiTtlMs);
  if (cached) return cached;

  let body;
  try {
    body = await request("/ws/place/v1/search", {
      keyword,
      boundary: `nearby(${latitude},${longitude},${radius})`,
      page_size: 20,
      page_index: 1,
      orderby: "_distance",
    });
  } catch (err) {
    // 无结果（347）不是错误，按空列表处理
    if (err && Number(err.status) === 347) {
      writeCache(key, []);
      return [];
    }
    throw err;
  }

  const list = (body.data || [])
    .map((item) => {
      const loc = item.location || {};
      return {
        id: String(item.id || `${loc.lat},${loc.lng}`),
        title: item.title || "",
        address: item.address || "",
        category: item.category || "",
        location: { lat: Number(loc.lat), lng: Number(loc.lng) },
      };
    })
    .filter((item) => isFinite(item.location.lat) && isFinite(item.location.lng));

  writeCache(key, list);
  return list;
}

function getRequestCount() {
  return requestTotal;
}

function resetRequestCount() {
  requestTotal = 0;
}

module.exports = {
  directionEbicycling,
  searchNearby,
  getRequestCount,
  resetRequestCount,
};
