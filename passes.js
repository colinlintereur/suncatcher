(function () {
  "use strict";

  const BUNDLED_TLE1 = "1 A0902U 26227V   26308.25345046  .00002583  00000-0  13318-3 0  9995";
  const BUNDLED_TLE2 = "2 A0902  97.4408  17.1704 0001552  63.2381 296.9012 15.17240648  5081";

  const STEP_MS = 15000;
  const LOOKBACK_MS = 25 * 60 * 1000;
  const TLE_REFRESH_MS = 6 * 3600 * 1000;
  const PASS_REFRESH_MS = 60 * 1000;

  function parseBoundedNumber(raw, min, max, fallback) {
    if (raw === null || raw === undefined) return fallback;
    const trimmed = String(raw).trim();
    if (trimmed === "") return fallback;
    const val = Number(trimmed);
    if (!Number.isFinite(val) || val < min || val > max) return fallback;
    return val;
  }

  function parseTimeZone(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    const trimmed = String(raw).trim();
    if (trimmed === "") return fallback;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
      return trimmed;
    } catch (_) {
      return fallback;
    }
  }

  function parseConfig(searchStr) {
    const params = new URLSearchParams(searchStr !== undefined ? searchStr : window.location.search);
    return {
      lat: parseBoundedNumber(params.get("lat"), -90, 90, 35.95),
      lng: parseBoundedNumber(params.get("lng"), -180, 180, -78.89),
      alt: parseBoundedNumber(params.get("alt"), -500, 100000, 0),
      days: parseBoundedNumber(params.get("days"), 1, 30, 7),
      tz: parseTimeZone(params.get("tz"), "America/New_York")
    };
  }

  function isValidTlePair(line1, line2) {
    if (typeof line1 !== "string" || typeof line2 !== "string") return false;
    const l1 = line1.trim();
    const l2 = line2.trim();
    if (l1.length < 68 || l2.length < 68) return false;
    if (!l1.startsWith("1 ") || !l2.startsWith("2 ")) return false;
    if (!/^1\s+(?:A0902U|100902U?)\s+/.test(l1)) return false;
    if (!/^2\s+(?:A0902|100902)\s+/.test(l2)) return false;
    if (typeof window.satellite === "undefined") return false;
    try {
      const rec = window.satellite.twoline2satrec(l1, l2);
      return Boolean(rec && !rec.error);
    } catch (_) {
      return false;
    }
  }

  function formatTleEpochLabel(line1) {
    try {
      const epochStr = line1.substring(18, 32).trim();
      const yy = parseInt(epochStr.substring(0, 2), 10);
      const dayOfYear = parseFloat(epochStr.substring(2));
      if (!Number.isFinite(yy) || !Number.isFinite(dayOfYear)) return "Unknown";
      const year = yy < 57 ? 2000 + yy : 1900 + yy;
      const jan1Ms = Date.UTC(year, 0, 1, 0, 0, 0);
      const d = new Date(jan1Ms + (dayOfYear - 1) * 86400000);
      return d.toISOString().substring(0, 16).replace("T", " ") + " UTC";
    } catch (_) {
      return "Unknown";
    }
  }

  const CONFIG = parseConfig();
  let activeTle1 = BUNDLED_TLE1;
  let activeTle2 = BUNDLED_TLE2;
  let activeSatrec = null;
  let tleSource = "bundled";
  let tleListeners = [];

  function ensureSatrec() {
    if (typeof window.satellite === "undefined") return null;
    if (!activeSatrec) {
      activeSatrec = window.satellite.twoline2satrec(activeTle1, activeTle2);
    }
    return activeSatrec;
  }

  function updateTlePair(line1, line2, sourceLabel) {
    const l1 = line1.trim();
    const l2 = line2.trim();
    if (!isValidTlePair(l1, l2)) return false;
    activeTle1 = l1;
    activeTle2 = l2;
    activeSatrec = window.satellite.twoline2satrec(activeTle1, activeTle2);
    tleSource = sourceLabel || "live";
    tleListeners.forEach(fn => {
      try { fn(activeSatrec, activeTle1, activeTle2); } catch (_) {}
    });
    return true;
  }

  async function fetchFromSatelliteMapApi() {
    const keyCtrl = new AbortController();
    const keyTimer = setTimeout(() => keyCtrl.abort(), 5000);
    const keyResp = await fetch("https://api.satellitemap.space/api/keys/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metadata: { source: "astro-page" } }),
      signal: keyCtrl.signal
    });
    clearTimeout(keyTimer);
    let token = null;
    if (keyResp.ok) {
      const keyJson = await keyResp.json();
      token = (keyJson.data && keyJson.data.key) || keyJson.key || null;
    }
    const satCtrl = new AbortController();
    const satTimer = setTimeout(() => satCtrl.abort(), 5000);
    const headers = token ? { Authorization: "Bearer " + token } : {};
    const satResp = await fetch("https://api.satellitemap.space/astro/satellite/100902", {
      headers: headers,
      signal: satCtrl.signal
    });
    clearTimeout(satTimer);
    if (!satResp.ok) return false;
    const satJson = await satResp.json();
    const tle = satJson && satJson.data && satJson.data.tle;
    if (tle && tle.line1 && tle.line2 && updateTlePair(tle.line1, tle.line2, "live")) {
      return true;
    }
    return false;
  }

  async function fetchFromCelestrak() {
    const urls = [
      "https://celestrak.org/NORAD/elements/gp.php?CATNR=100902&FORMAT=TLE",
      "https://satellitemap.space/sat/100902"
    ];
    for (let i = 0; i < urls.length; i++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const resp = await fetch(urls[i], { signal: ctrl.signal });
        clearTimeout(timer);
        if (!resp.ok) continue;
        const text = await resp.text();
        const m1 = text.match(/1\s+(?:A0902U|100902U?)\s+[0-9A-Z.\-+ ]{50,60}/);
        const m2 = text.match(/2\s+(?:A0902|100902)\s+[0-9.\-+ ]{50,60}/);
        if (m1 && m2 && updateTlePair(m1[0], m2[0], "live")) {
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  async function refreshTle() {
    try {
      if (await fetchFromSatelliteMapApi()) {
        renderPasses();
        return true;
      }
    } catch (_) {}
    try {
      if (await fetchFromCelestrak()) {
        renderPasses();
        return true;
      }
    } catch (_) {}
    renderPasses();
    return false;
  }

  function ordinalSuffix(day) {
    if (day > 3 && day < 21) return "th";
    switch (day % 10) {
      case 1: return "st";
      case 2: return "nd";
      case 3: return "rd";
      default: return "th";
    }
  }

  function normalizeAzimuthDeg(deg) {
    return ((Math.round(deg) % 360) + 360) % 360;
  }

  function compassDir(deg) {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const norm = ((deg % 360) + 360) % 360;
    return dirs[Math.round(norm / 45) % 8];
  }

  function evalLook(satrec, obsGd, timeMs) {
    const d = new Date(timeMs);
    const pv = window.satellite.propagate(satrec, d);
    if (!pv || !pv.position || pv.error) return null;
    const gmst = window.satellite.gstime(d);
    const ecf = window.satellite.eciToEcf(pv.position, gmst);
    const look = window.satellite.ecfToLookAngles(obsGd, ecf);
    return {
      timeMs: timeMs,
      el: window.satellite.radiansToDegrees(look.elevation),
      az: window.satellite.radiansToDegrees(look.azimuth)
    };
  }

  function bisectHorizon(satrec, obsGd, tLowMs, tHighMs, rising) {
    let a = tLowMs;
    let b = tHighMs;
    let midLook = null;
    while (b - a > 1000) {
      const mid = Math.floor((a + b) / 2);
      const look = evalLook(satrec, obsGd, mid);
      if (!look) break;
      midLook = look;
      if (rising) {
        if (look.el <= 0) a = mid;
        else b = mid;
      } else {
        if (look.el > 0) a = mid;
        else b = mid;
      }
    }
    return midLook || evalLook(satrec, obsGd, rising ? b : a);
  }

  function refinePeak(satrec, obsGd, centerMs, windowMs) {
    let best = evalLook(satrec, obsGd, centerMs);
    const start = centerMs - windowMs;
    const end = centerMs + windowMs;
    for (let t = start; t <= end; t += 1000) {
      const look = evalLook(satrec, obsGd, t);
      if (look && (!best || look.el > best.el)) {
        best = look;
      }
    }
    return best;
  }

  function computeTransits(satrec, observer, nowDate, durationDays) {
    if (!satrec || typeof window.satellite === "undefined") return [];
    const obsGd = {
      longitude: window.satellite.degreesToRadians(observer.lng),
      latitude: window.satellite.degreesToRadians(observer.lat),
      height: (observer.alt || 0) / 1000
    };
    const nowMs = nowDate.getTime();
    const scanStartMs = nowMs - LOOKBACK_MS;
    const horizonEndMs = nowMs + durationDays * 86400000;
    const scanEndMs = horizonEndMs + LOOKBACK_MS;

    let prev = null;
    let inPass = false;
    let passStart = null;
    let coarsePeak = null;
    const transits = [];

    for (let curMs = scanStartMs; curMs <= scanEndMs; curMs += STEP_MS) {
      const look = evalLook(satrec, obsGd, curMs);
      if (!look) continue;

      if (!inPass && look.el > 0 && prev !== null && prev.el <= 0) {
        inPass = true;
        passStart = bisectHorizon(satrec, obsGd, prev.timeMs, curMs, true) || look;
        coarsePeak = look;
      }
      if (inPass && (!coarsePeak || look.el > coarsePeak.el)) {
        coarsePeak = look;
      }
      if (inPass && look.el <= 0 && prev !== null && prev.el > 0) {
        inPass = false;
        const passEnd = bisectHorizon(satrec, obsGd, prev.timeMs, curMs, false) || look;
        const refinedPeak = refinePeak(satrec, obsGd, coarsePeak.timeMs, STEP_MS) || coarsePeak;

        if (
          refinedPeak.el >= 1.0 &&
          passEnd.timeMs > nowMs &&
          passStart.timeMs <= horizonEndMs
        ) {
          transits.push({
            startTime: new Date(passStart.timeMs),
            startElevation: passStart.el,
            startAzimuth: passStart.az,
            peakTime: new Date(refinedPeak.timeMs),
            peakElevation: refinedPeak.el,
            peakAzimuth: refinedPeak.az,
            endTime: new Date(passEnd.timeMs),
            endElevation: passEnd.el,
            endAzimuth: passEnd.az
          });
        }
        passStart = null;
        coarsePeak = null;
      }
      prev = look;
    }
    return transits;
  }

  function getTimeZoneShortLabel(date, tz) {
    if (tz.toUpperCase() === "UTC" || tz.toUpperCase() === "ETC/UTC") return "UTC";
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "short"
      }).formatToParts(date);
      const tzPart = parts.find(p => p.type === "timeZoneName");
      return tzPart ? tzPart.value : tz;
    } catch (_) {
      return "UTC";
    }
  }

  function formatTime24(date, tz) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const hh = (parts.find(p => p.type === "hour") || { value: "00" }).value;
    const mm = (parts.find(p => p.type === "minute") || { value: "00" }).value;
    return `${hh}:${mm}`;
  }

  function renderPasses() {
    const tbody = document.getElementById("passes-tbody");
    const footer = document.getElementById("passes-footer");
    const dtHeader = document.getElementById("col-datetime-header");
    if (!tbody || !footer) return;

    if (typeof window.satellite === "undefined") {
      tbody.innerHTML = "";
      footer.textContent = "Error: satellite.js failed to load";
      return;
    }

    const satrec = ensureSatrec();
    if (!satrec || satrec.error) {
      tbody.innerHTML = "";
      footer.textContent = "Error: invalid TLE orbital elements";
      return;
    }

    const now = new Date();
    if (dtHeader) {
      dtHeader.textContent = "Date & Time " + getTimeZoneShortLabel(now, CONFIG.tz);
    }

    const transits = computeTransits(satrec, CONFIG, now, CONFIG.days);
    const top10 = transits.slice(0, 10);

    tbody.innerHTML = top10.map(t => {
      const start = t.startTime;
      const end = t.endTime;
      const day = Number(start.toLocaleDateString("en-US", { day: "numeric", timeZone: CONFIG.tz }));
      const mon = start.toLocaleDateString("en-US", { month: "short", timeZone: CONFIG.tz });
      const dateStr = day + ordinalSuffix(day) + " " + mon;
      const timeStr = formatTime24(start, CONFIG.tz);

      const totalSec = Math.max(1, Math.round((end.getTime() - start.getTime()) / 1000));
      const durMins = Math.floor(totalSec / 60);
      const durSecs = totalSec % 60;
      const durStr = durMins + "m " + durSecs + "s";

      const peakEl = Math.round(t.peakElevation);
      let tierClass = "";
      if (t.peakElevation >= 70) tierClass = "tier-emerald";
      else if (t.peakElevation >= 40) tierClass = "tier-yellow";
      else if (t.peakElevation >= 20) tierClass = "tier-orange";

      const riseDeg = normalizeAzimuthDeg(t.startAzimuth);
      const setDeg = normalizeAzimuthDeg(t.endAzimuth);
      const riseStr = compassDir(t.startAzimuth) + " " + riseDeg + "&deg;";
      const setStr = compassDir(t.endAzimuth) + " " + setDeg + "&deg;";

      return `<tr class="${tierClass}">
        <td><span class="date-text">${dateStr}</span><span class="time-text">${timeStr}</span></td>
        <td><span class="az-text">${riseStr}</span></td>
        <td class="alt-cell">${peakEl}&deg;</td>
        <td><span class="az-text">${setStr}</span></td>
        <td class="dur-cell"><span class="dur-badge">${durStr}</span></td>
      </tr>`;
    }).join("");

    const epochLabel = formatTleEpochLabel(activeTle1);
    const sourceSuffix = tleSource === "live" ? `TLE ${epochLabel}` : `Bundled TLE ${epochLabel}`;
    footer.textContent = `Showing ${top10.length} of ${transits.length} passes • ${sourceSuffix}`;
  }

  window.SuncatcherPasses = {
    getConfig: () => CONFIG,
    getSatrec: ensureSatrec,
    getTleLines: () => [activeTle1, activeTle2],
    parseConfig: parseConfig,
    computeTransits: computeTransits,
    renderPasses: renderPasses,
    refreshTle: refreshTle,
    onTleUpdate: fn => { if (typeof fn === "function") tleListeners.push(fn); }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      renderPasses();
      refreshTle();
    });
  } else {
    renderPasses();
    refreshTle();
  }

  setInterval(renderPasses, PASS_REFRESH_MS);
  setInterval(refreshTle, TLE_REFRESH_MS);
})();
