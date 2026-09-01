// ─────────────────────────────────────────────
// WARDEN — RF / TERRAIN MATH MODULE
// Pure computation, no DOM access — Haversine distance, Fresnel-zone
// radius, and USGS 3DEP elevation lookups. Used by both the RF
// Deconflicter Tool and the Schedule module's Simplex Reuse Risk
// Engine, which is why this lives in its own file rather than inside
// either feature: it's genuinely shared, not duplicated.
//
// Must be loaded via a plain <script src="rf-terrain-math.js"> BEFORE
// the main inline <script> in index.html — these functions become
// ordinary globals, exactly as if they were still defined inline, as
// long as this file loads first (which a <script src> placed earlier
// in <head>/<body> guarantees, since script tags execute in document
// order by default).
// ─────────────────────────────────────────────

// Haversine distance between two lat/lon points, in miles.
function haversineMiles(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Effective frequency (MHz) for Fresnel/propagation math — mid-band representative
function bandFreqMHz(band) {
  return { VHF: 155, UHF: 460, '700': 769, '800': 851 }[band] || 460;
}

const BAND_THRESHOLDS = {
  VHF:  { safe: 20, caution: 8  },
  UHF:  { safe: 12, caution: 4  },
  '700':{ safe: 8,  caution: 3  },
  '800':{ safe: 8,  caution: 3  },
};

// ── USGS 3DEP EPQS — single point elevation (feet) ──
async function fetchElevationUSGS(lat, lon) {
  try {
    const url = `https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&units=Feet&includeDate=false`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const d = await r.json();
    // EPQS returns { value: "1234.56" } or { value: -1000000 } for ocean/error
    const v = parseFloat(d.value);
    return (isFinite(v) && v > -9000) ? Math.round(v) : null;
  } catch(e) { return null; }
}

// ── USGS 3DEP EPQS — elevation profile along a path ──
// Returns array of { lat, lon, elevFt, distMiles } sampled evenly between A and B
async function fetchElevationProfile(lat1, lon1, lat2, lon2, nSamples = 12) {
  const points = [];
  const totalDist = haversineMiles(lat1, lon1, lat2, lon2);
  for (let i = 0; i <= nSamples; i++) {
    const t   = i / nSamples;
    const lat = lat1 + t * (lat2 - lat1);
    const lon = lon1 + t * (lon2 - lon1);
    points.push({ lat, lon, t, distMiles: t * totalDist });
  }

  // Fetch all points in parallel (EPQS has no batch endpoint — parallel point queries)
  const results = await Promise.all(
    points.map(async p => {
      const elev = await fetchElevationUSGS(p.lat, p.lon);
      return { ...p, elevFt: elev ?? null };
    })
  );

  return results;
}

// ── Fresnel zone first-radius at a point along a path ──
// d1 = distance from point to site A (miles), d2 = distance to site B (miles)
// freqMHz = operating frequency, returns radius in feet
function fresnelRadius1(d1Miles, d2Miles, freqMHz) {
  // r1 = sqrt(λ * d1 * d2 / D)  where all in same units
  // λ = c / f;  using miles for distance then convert to feet
  const d1 = d1Miles * 5280; // feet
  const d2 = d2Miles * 5280;
  const D  = d1 + d2;
  const lambda = 984_000_000 / (freqMHz * 1e6); // feet  (c = 984,000,000 ft/s)
  return Math.sqrt(lambda * d1 * d2 / D);        // feet
}

// ── Earth curvature bulge at a point along a path ──
// Standard engineering approximation: bulge_ft ≈ (0.667 × d1 × d2) / K,
// with d1/d2 in miles and K the effective-Earth-radius factor (4/3 for
// the standard atmosphere — this is the same K used throughout FCC/ham
// VHF-UHF path engineering references). This bulge is added to terrain
// elevation (not subtracted from the LOS line) since it represents how
// much higher the ground effectively appears due to the Earth curving
// away beneath a straight sightline.
function earthCurvatureFt(d1Miles, d2Miles, k = 4/3) {
  return (0.667 * d1Miles * d2Miles) / k;
}

// ── Terrain + Fresnel path analysis ──
// Returns { losStatus, fresnelStatus, blockedAt, fresnelDetail, profile }
// losStatus: 'clear' | 'blocked' | 'marginal'
// fresnelStatus: 'clear' | 'partial' | 'obstructed'
// antennaFtA/antennaFtB are independent per-endpoint heights — real
// paths aren't symmetric (e.g. a portable at 5-6ft AGL working a
// repeater on an 80ft tower), so this no longer assumes one shared height.
async function analyzeTerrainPath(lat1, lon1, elev1Ft, lat2, lon2, elev2Ft, freqMHz, antennaFtA = 10, antennaFtB = 10) {
  const hA = elev1Ft + antennaFtA;
  const hB = elev2Ft + antennaFtB;
  const D  = haversineMiles(lat1, lon1, lat2, lon2);

  if (D < 0.1) {
    return { losStatus:'clear', fresnelStatus:'clear', blockedAt:null,
             fresnelDetail:'Same location', profile:[], D };
  }

  // Sample density scales with path length instead of a fixed count —
  // a fixed 12 samples over a 20-mile VHF path (this tool's own "safe"
  // distance threshold) leaves samples ~1.7 miles apart, easily coarse
  // enough to step over a ridge or a cluster of buildings. One sample
  // per ~0.5 mile, floor of 12 for short paths, capped at 80 so a very
  // long path doesn't fire off an excessive number of parallel USGS
  // EPQS point lookups.
  const nSamples = Math.min(80, Math.max(12, Math.ceil(D / 0.5)));
  const profile = await fetchElevationProfile(lat1, lon1, lat2, lon2, nSamples);

  // Fill in nulls with linear interpolation between known points
  for (let i = 0; i < profile.length; i++) {
    if (profile[i].elevFt === null) {
      // find nearest known neighbors
      let prev = i - 1, next = i + 1;
      while (prev >= 0 && profile[prev].elevFt === null) prev--;
      while (next < profile.length && profile[next].elevFt === null) next++;
      if (prev >= 0 && next < profile.length) {
        const span = next - prev;
        profile[i].elevFt = profile[prev].elevFt +
          ((profile[next].elevFt - profile[prev].elevFt) / span) * (i - prev);
      } else if (prev >= 0) profile[i].elevFt = profile[prev].elevFt;
      else if (next < profile.length) profile[i].elevFt = profile[next].elevFt;
      else profile[i].elevFt = (elev1Ft + elev2Ft) / 2;
    }
  }

  let losBlocked = false, fresnelViolations = 0, blockedAt = null;
  const FRESNEL_CLEARANCE = 0.6; // 60% first Fresnel zone clearance required

  for (const p of profile) {
    if (p.t === 0 || p.t === 1) continue; // skip endpoints
    const d1 = p.t * D;
    const d2 = (1 - p.t) * D;

    // LOS height at this point on the straight line between A and B antennas
    const losHeight = hA + (hB - hA) * p.t;

    // Effective terrain height including the Earth-curvature bulge —
    // the ground effectively sits higher relative to a straight sightline
    // the farther out along the path you are from both endpoints.
    const effectiveElevFt = p.elevFt + earthCurvatureFt(d1, d2);

    // Check direct LOS
    if (effectiveElevFt > losHeight) {
      losBlocked = true;
      if (!blockedAt) blockedAt = p;
    }

    // Check Fresnel clearance
    const r1  = fresnelRadius1(d1, d2, freqMHz);             // ft
    const clr = FRESNEL_CLEARANCE * r1;                       // required clearance ft
    const headroom = losHeight - effectiveElevFt;              // terrain below LOS line
    if (headroom < clr) fresnelViolations++;
  }

  const interiorCount = profile.length - 2;
  const fresnelRatio  = fresnelViolations / Math.max(interiorCount, 1);

  const losStatus     = losBlocked ? 'blocked' : 'clear';
  let fresnelStatus;
  if (fresnelRatio === 0)       fresnelStatus = 'clear';
  else if (fresnelRatio < 0.4)  fresnelStatus = 'partial';
  else                          fresnelStatus = 'obstructed';

  return { losStatus, fresnelStatus, blockedAt, fresnelViolations, interiorCount, profile, D, freqMHz };
}
  
