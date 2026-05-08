// =============================================================================
// SATELLITE IMAGERY — space.js
// Cloudflare Worker proxy → Mapbox Static Images + Globe.gl 3D interaction
// =============================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROXY_BASE = 'https://satellite-imagery-proxy.esvela02.workers.dev';

const DEFAULT_LAT = 59.349800;
const DEFAULT_LON = 18.070700;
const DEFAULT_RADIUS = 100;

// Country borders + lakes + populated-place labels come from Natural Earth
// via jsdelivr's GitHub mirror.
const NE_BASE = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson';
const COUNTRIES_GEOJSON_URL = `${NE_BASE}/ne_50m_admin_0_countries.geojson`;
const LAKES_GEOJSON_URL     = `${NE_BASE}/ne_10m_lakes.geojson`;
const POP_PLACES_URL        = `${NE_BASE}/ne_50m_populated_places.geojson`;
const VECTOR_LOAD_ALTITUDE  = 0.7;
// SCALERANK 0–4 covers ~1,100 cities, 5+ adds smaller towns. Keep up through
// 7 for richer regional context at close zoom.
const POP_PLACES_MAX_SCALERANK = 7;

// Globe surface texture. Iconic 2K Blue Marble at orbital distance.
// As the user zooms in, globe.gl's built-in slippy-tile engine drapes
// real Mapbox satellite tiles on top of this base texture (configured
// in initGlobe via .globeTileEngineUrl).
const GLOBE_TEXTURE = '//unpkg.com/three-globe/example/img/earth-blue-marble.jpg';

// Mapbox tile endpoint on our Cloudflare Worker. Each tile request is
// /tile/{z}/{x}/{y}; the Worker proxies Mapbox, enforces our quotas, and
// stamps 1-year immutable Cache-Control so the CF edge cache absorbs
// most of the load.
const TILE_PROXY_BASE = `${PROXY_BASE}/tile`;

// Tiles for the most-clicked cities are pre-built into the repo under
// /tiles/{z}/{x}/{y}.jpg by tiles/build-cache.mjs. The manifest is a JSON
// array of "z/x/y" keys that exist locally; we resolve it once at startup
// and the tile-engine URL builder consults it before falling through to
// the Worker. This keeps the most common viewing patterns
// (city-click → close-zoom) entirely off the Mapbox/KV path.
const TILE_LOCAL_BASE = '/tiles';
const TILE_MANIFEST_URL = `${TILE_LOCAL_BASE}/manifest.json`;
let LOCAL_TILES = null; // populated after manifest fetch — see initGlobe.
async function loadTileManifest() {
  try {
    const res = await fetch(TILE_MANIFEST_URL, { cache: 'force-cache' });
    if (!res.ok) return new Set();
    const arr = await res.json();
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

// City prominence tiers. Top tier always visible; mid tier appears when the
// camera drops below the regional altitude threshold; the rest only show on
// close zoom. This keeps the globe legible from afar instead of solid text.
const TIER1_CITIES = new Set([
  // Megacities + globally recognised capitals
  'New York', 'Los Angeles', 'Chicago', 'San Francisco', 'Honolulu',
  'Mexico City', 'Toronto',
  'Rio de Janeiro', 'São Paulo', 'Buenos Aires',
  'London', 'Paris', 'Berlin', 'Madrid', 'Rome', 'Moscow', 'Stockholm',
  'Istanbul', 'Reykjavík',
  'Tokyo', 'Beijing', 'Shanghai', 'Hong Kong', 'Seoul', 'Singapore',
  'Bangkok', 'Mumbai', 'New Delhi', 'Jakarta', 'Dubai', 'Jerusalem',
  'Cairo', 'Lagos', 'Cape Town', 'Johannesburg',
  'Sydney', 'Melbourne', 'Auckland',
]);

const TIER2_CITIES = new Set([
  // Europe
  'Helsinki', 'Oslo', 'Copenhagen', 'Hamburg', 'Munich', 'Frankfurt',
  'Amsterdam', 'Brussels', 'Zurich', 'Vienna', 'Prague', 'Warsaw',
  'Kraków', 'Kyiv', 'St. Petersburg', 'Ankara', 'Athens', 'Lisbon',
  'Barcelona', 'Manchester', 'Edinburgh', 'Dublin', 'Milan', 'Naples',
  // North America
  'Houston', 'Phoenix', 'Denver', 'Las Vegas', 'Seattle', 'Portland',
  'Washington', 'Boston', 'Philadelphia', 'Miami', 'Atlanta', 'Dallas',
  'Detroit', 'Minneapolis', 'Anchorage',
  'Montreal', 'Vancouver', 'Calgary',
  'Havana', 'Panama City', 'San Juan', 'Guatemala City',
  // South America
  'Bogotá', 'Lima', 'La Paz', 'Santiago', 'Brasília', 'Caracas',
  'Montevideo', 'Quito',
  // Asia
  'Osaka', 'Kyoto', 'Taipei', 'Manila', 'Ho Chi Minh City', 'Hanoi',
  'Kuala Lumpur', 'Guangzhou', 'Shenzhen', 'Bangalore', 'Chennai',
  'Kolkata', 'Hyderabad', 'Karachi', 'Lahore', 'Islamabad', 'Tehran',
  'Riyadh', 'Tel Aviv', 'Damascus', 'Beirut', 'Baghdad', 'Kabul',
  'Tashkent', 'Almaty',
  // Africa
  'Casablanca', 'Algiers', 'Tunis', 'Dakar', 'Accra', 'Abuja', 'Nairobi',
  'Addis Ababa', 'Kinshasa', 'Khartoum', 'Pretoria', 'Luanda',
  // Oceania
  'Brisbane', 'Perth', 'Adelaide', 'Wellington',
]);

function cityTier(name) {
  if (TIER1_CITIES.has(name)) return 1;
  if (TIER2_CITIES.has(name)) return 2;
  return 3;
}

// Strip diacritics and lower-case so name comparisons treat 'Bogotá' and
// 'Bogota', 'São Paulo' and 'Sao Paulo', etc. as the same city.
function normalizeCityName(name) {
  return name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

// Altitude thresholds: above 1.5 only tier-1; 0.5–1.5 tier-1+2; below 0.5 all.
// Tier slices are computed once on first use — refreshLabels() runs on every
// camera change, and the lists are immutable, so re-filtering 220 entries each
// frame is pure waste.
let _tier1Cities = null;
let _tier12Cities = null;
function citiesForAltitude(altitude) {
  if (altitude > 1.5) {
    if (!_tier1Cities) _tier1Cities = CITY_LABELS.filter((c) => cityTier(c.name) === 1);
    return _tier1Cities;
  }
  if (altitude > 0.5) {
    if (!_tier12Cities) _tier12Cities = CITY_LABELS.filter((c) => cityTier(c.name) <= 2);
    return _tier12Cities;
  }
  return CITY_LABELS;
}

// Cities rendered as clickable HTML labels on the globe. Used for both the
// label overlay and the random-preset roulette. ~220 entries, multiple
// cities per major country, geographically distributed.
const CITY_LABELS = [
  // Europe
  { lat: 59.3293, lng: 18.0686,  name: 'Stockholm' },
  { lat: 57.7089, lng: 11.9746,  name: 'Gothenburg' },
  { lat: 55.6050, lng: 13.0038,  name: 'Malmö' },
  { lat: 60.1699, lng: 24.9384,  name: 'Helsinki' },
  { lat: 59.9139, lng: 10.7522,  name: 'Oslo' },
  { lat: 60.3913, lng: 5.3221,   name: 'Bergen' },
  { lat: 55.6761, lng: 12.5683,  name: 'Copenhagen' },
  { lat: 53.5511, lng: 9.9937,   name: 'Hamburg' },
  { lat: 52.5200, lng: 13.4050,  name: 'Berlin' },
  { lat: 48.1351, lng: 11.5820,  name: 'Munich' },
  { lat: 50.9375, lng: 6.9603,   name: 'Cologne' },
  { lat: 50.1109, lng: 8.6821,   name: 'Frankfurt' },
  { lat: 48.8566, lng: 2.3522,   name: 'Paris' },
  { lat: 45.7640, lng: 4.8357,   name: 'Lyon' },
  { lat: 43.2965, lng: 5.3698,   name: 'Marseille' },
  { lat: 51.5074, lng: -0.1278,  name: 'London' },
  { lat: 53.4808, lng: -2.2426,  name: 'Manchester' },
  { lat: 55.9533, lng: -3.1883,  name: 'Edinburgh' },
  { lat: 53.3498, lng: -6.2603,  name: 'Dublin' },
  { lat: 52.3676, lng: 4.9041,   name: 'Amsterdam' },
  { lat: 50.8503, lng: 4.3517,   name: 'Brussels' },
  { lat: 49.6116, lng: 6.1319,   name: 'Luxembourg' },
  { lat: 47.3769, lng: 8.5417,   name: 'Zurich' },
  { lat: 46.2044, lng: 6.1432,   name: 'Geneva' },
  { lat: 48.2082, lng: 16.3738,  name: 'Vienna' },
  { lat: 50.0755, lng: 14.4378,  name: 'Prague' },
  { lat: 47.4979, lng: 19.0402,  name: 'Budapest' },
  { lat: 52.2297, lng: 21.0122,  name: 'Warsaw' },
  { lat: 50.0647, lng: 19.9450,  name: 'Kraków' },
  { lat: 55.7558, lng: 37.6173,  name: 'Moscow' },
  { lat: 59.9311, lng: 30.3609,  name: 'St. Petersburg' },
  { lat: 50.4501, lng: 30.5234,  name: 'Kyiv' },
  { lat: 41.0082, lng: 28.9784,  name: 'Istanbul' },
  { lat: 39.9334, lng: 32.8597,  name: 'Ankara' },
  { lat: 37.9838, lng: 23.7275,  name: 'Athens' },
  { lat: 41.9028, lng: 12.4964,  name: 'Rome' },
  { lat: 45.4642, lng: 9.1900,   name: 'Milan' },
  { lat: 40.8518, lng: 14.2681,  name: 'Naples' },
  { lat: 45.4408, lng: 12.3155,  name: 'Venice' },
  { lat: 43.7696, lng: 11.2558,  name: 'Florence' },
  { lat: 41.3851, lng: 2.1734,   name: 'Barcelona' },
  { lat: 40.4168, lng: -3.7038,  name: 'Madrid' },
  { lat: 37.3886, lng: -5.9823,  name: 'Seville' },
  { lat: 38.7223, lng: -9.1393,  name: 'Lisbon' },
  { lat: 41.1496, lng: -8.6109,  name: 'Porto' },
  { lat: 64.1466, lng: -21.9426, name: 'Reykjavík' },

  // North America
  { lat: 40.7128, lng: -74.0060, name: 'New York' },
  { lat: 34.0522, lng: -118.2437, name: 'Los Angeles' },
  { lat: 41.8781, lng: -87.6298, name: 'Chicago' },
  { lat: 29.7604, lng: -95.3698, name: 'Houston' },
  { lat: 33.4484, lng: -112.0740, name: 'Phoenix' },
  { lat: 39.7392, lng: -104.9903, name: 'Denver' },
  { lat: 36.1699, lng: -115.1398, name: 'Las Vegas' },
  { lat: 32.7157, lng: -117.1611, name: 'San Diego' },
  { lat: 37.7749, lng: -122.4194, name: 'San Francisco' },
  { lat: 47.6062, lng: -122.3321, name: 'Seattle' },
  { lat: 45.5152, lng: -122.6784, name: 'Portland' },
  { lat: 38.9072, lng: -77.0369, name: 'Washington' },
  { lat: 42.3601, lng: -71.0589, name: 'Boston' },
  { lat: 39.9526, lng: -75.1652, name: 'Philadelphia' },
  { lat: 25.7617, lng: -80.1918, name: 'Miami' },
  { lat: 28.5383, lng: -81.3792, name: 'Orlando' },
  { lat: 33.7490, lng: -84.3880, name: 'Atlanta' },
  { lat: 30.2672, lng: -97.7431, name: 'Austin' },
  { lat: 32.7767, lng: -96.7970, name: 'Dallas' },
  { lat: 29.4241, lng: -98.4936, name: 'San Antonio' },
  { lat: 36.1627, lng: -86.7816, name: 'Nashville' },
  { lat: 42.3314, lng: -83.0458, name: 'Detroit' },
  { lat: 44.9778, lng: -93.2650, name: 'Minneapolis' },
  { lat: 40.7608, lng: -111.8910, name: 'Salt Lake City' },
  { lat: 21.3099, lng: -157.8581, name: 'Honolulu' },
  { lat: 61.2181, lng: -149.9003, name: 'Anchorage' },
  { lat: 64.8401, lng: -147.7200, name: 'Fairbanks' },
  { lat: 43.6532, lng: -79.3832, name: 'Toronto' },
  { lat: 45.5017, lng: -73.5673, name: 'Montreal' },
  { lat: 49.2827, lng: -123.1207, name: 'Vancouver' },
  { lat: 51.0447, lng: -114.0719, name: 'Calgary' },
  { lat: 53.5461, lng: -113.4938, name: 'Edmonton' },
  { lat: 45.4215, lng: -75.6972, name: 'Ottawa' },
  { lat: 46.8139, lng: -71.2080, name: 'Québec City' },
  { lat: 19.4326, lng: -99.1332, name: 'Mexico City' },
  { lat: 20.6597, lng: -103.3496, name: 'Guadalajara' },
  { lat: 25.6866, lng: -100.3161, name: 'Monterrey' },
  { lat: 21.1619, lng: -86.8515, name: 'Cancún' },
  { lat: 23.1136, lng: -82.3666, name: 'Havana' },
  { lat: 18.4861, lng: -69.9312, name: 'Santo Domingo' },
  { lat: 18.4655, lng: -66.1057, name: 'San Juan' },
  { lat: 14.6349, lng: -90.5069, name: 'Guatemala City' },
  { lat: 9.9281,  lng: -84.0907, name: 'San José' },
  { lat: 8.9824,  lng: -79.5199, name: 'Panama City' },

  // South America
  { lat: 4.7110,  lng: -74.0721, name: 'Bogotá' },
  { lat: 6.2476,  lng: -75.5658, name: 'Medellín' },
  { lat: 10.9685, lng: -74.7813, name: 'Barranquilla' },
  { lat: -12.0464, lng: -77.0428, name: 'Lima' },
  { lat: -13.5319, lng: -71.9675, name: 'Cuzco' },
  { lat: -16.5000, lng: -68.1500, name: 'La Paz' },
  { lat: -33.4489, lng: -70.6693, name: 'Santiago' },
  { lat: -34.6037, lng: -58.3816, name: 'Buenos Aires' },
  { lat: -31.4201, lng: -64.1888, name: 'Córdoba' },
  { lat: -34.9011, lng: -56.1645, name: 'Montevideo' },
  { lat: -25.2637, lng: -57.5759, name: 'Asunción' },
  { lat: -22.9068, lng: -43.1729, name: 'Rio de Janeiro' },
  { lat: -23.5505, lng: -46.6333, name: 'São Paulo' },
  { lat: -15.7942, lng: -47.8822, name: 'Brasília' },
  { lat: -3.7172,  lng: -38.5434, name: 'Fortaleza' },
  { lat: -8.0476,  lng: -34.8770, name: 'Recife' },
  { lat: -12.9777, lng: -38.5016, name: 'Salvador' },
  { lat: -3.1190,  lng: -60.0217, name: 'Manaus' },
  { lat: -25.4284, lng: -49.2733, name: 'Curitiba' },
  { lat: -30.0346, lng: -51.2177, name: 'Porto Alegre' },
  { lat: 0.1807,   lng: -78.4678, name: 'Quito' },
  { lat: -2.1894,  lng: -79.8891, name: 'Guayaquil' },
  { lat: 10.4806,  lng: -66.9036, name: 'Caracas' },
  { lat: -54.8019, lng: -68.3030, name: 'Ushuaia' },

  // Asia
  { lat: 35.6762, lng: 139.6503, name: 'Tokyo' },
  { lat: 34.6937, lng: 135.5023, name: 'Osaka' },
  { lat: 35.0116, lng: 135.7681, name: 'Kyoto' },
  { lat: 43.0618, lng: 141.3545, name: 'Sapporo' },
  { lat: 33.5904, lng: 130.4017, name: 'Fukuoka' },
  { lat: 37.5665, lng: 126.9780, name: 'Seoul' },
  { lat: 35.1796, lng: 129.0756, name: 'Busan' },
  { lat: 39.0392, lng: 125.7625, name: 'Pyongyang' },
  { lat: 39.9042, lng: 116.4074, name: 'Beijing' },
  { lat: 31.2304, lng: 121.4737, name: 'Shanghai' },
  { lat: 23.1291, lng: 113.2644, name: 'Guangzhou' },
  { lat: 22.5431, lng: 114.0579, name: 'Shenzhen' },
  { lat: 22.3193, lng: 114.1694, name: 'Hong Kong' },
  { lat: 30.5728, lng: 104.0668, name: 'Chengdu' },
  { lat: 29.5630, lng: 106.5516, name: 'Chongqing' },
  { lat: 32.0603, lng: 118.7969, name: 'Nanjing' },
  { lat: 34.3416, lng: 108.9398, name: "Xi'an" },
  { lat: 25.0330, lng: 121.5654, name: 'Taipei' },
  { lat: 1.3521,  lng: 103.8198, name: 'Singapore' },
  { lat: 3.1390,  lng: 101.6869, name: 'Kuala Lumpur' },
  { lat: 13.7563, lng: 100.5018, name: 'Bangkok' },
  { lat: 18.7883, lng: 98.9853,  name: 'Chiang Mai' },
  { lat: 21.0285, lng: 105.8542, name: 'Hanoi' },
  { lat: 10.7626, lng: 106.6602, name: 'Ho Chi Minh City' },
  { lat: 11.5564, lng: 104.9282, name: 'Phnom Penh' },
  { lat: 14.5995, lng: 120.9842, name: 'Manila' },
  { lat: 10.3157, lng: 123.8854, name: 'Cebu' },
  { lat: -6.2088, lng: 106.8456, name: 'Jakarta' },
  { lat: -8.6500, lng: 115.2167, name: 'Denpasar' },
  { lat: 16.8409, lng: 96.1735,  name: 'Yangon' },
  { lat: 23.8103, lng: 90.4125,  name: 'Dhaka' },
  { lat: 27.7172, lng: 85.3240,  name: 'Kathmandu' },
  { lat: 28.6139, lng: 77.2090,  name: 'New Delhi' },
  { lat: 19.0760, lng: 72.8777,  name: 'Mumbai' },
  { lat: 12.9716, lng: 77.5946,  name: 'Bangalore' },
  { lat: 13.0827, lng: 80.2707,  name: 'Chennai' },
  { lat: 22.5726, lng: 88.3639,  name: 'Kolkata' },
  { lat: 17.3850, lng: 78.4867,  name: 'Hyderabad' },
  { lat: 26.9124, lng: 75.7873,  name: 'Jaipur' },
  { lat: 27.1751, lng: 78.0421,  name: 'Agra' },
  { lat: 6.9271,  lng: 79.8612,  name: 'Colombo' },
  { lat: 24.8607, lng: 67.0011,  name: 'Karachi' },
  { lat: 31.5497, lng: 74.3436,  name: 'Lahore' },
  { lat: 33.6844, lng: 73.0479,  name: 'Islamabad' },
  { lat: 34.5553, lng: 69.2075,  name: 'Kabul' },
  { lat: 35.6892, lng: 51.3890,  name: 'Tehran' },
  { lat: 41.3111, lng: 69.2401,  name: 'Tashkent' },
  { lat: 51.1605, lng: 71.4704,  name: 'Astana' },
  { lat: 43.2389, lng: 76.8897,  name: 'Almaty' },
  { lat: 25.2048, lng: 55.2708,  name: 'Dubai' },
  { lat: 24.4539, lng: 54.3773,  name: 'Abu Dhabi' },
  { lat: 24.7136, lng: 46.6753,  name: 'Riyadh' },
  { lat: 21.4858, lng: 39.1925,  name: 'Jeddah' },
  { lat: 21.4225, lng: 39.8262,  name: 'Mecca' },
  { lat: 33.3152, lng: 44.3661,  name: 'Baghdad' },
  { lat: 33.5138, lng: 36.2765,  name: 'Damascus' },
  { lat: 33.8938, lng: 35.5018,  name: 'Beirut' },
  { lat: 31.7683, lng: 35.2137,  name: 'Jerusalem' },
  { lat: 32.0853, lng: 34.7818,  name: 'Tel Aviv' },
  { lat: 31.9454, lng: 35.9284,  name: 'Amman' },

  // Africa
  { lat: 30.0444, lng: 31.2357,  name: 'Cairo' },
  { lat: 31.2001, lng: 29.9187,  name: 'Alexandria' },
  { lat: 36.7538, lng: 3.0588,   name: 'Algiers' },
  { lat: 36.8065, lng: 10.1815,  name: 'Tunis' },
  { lat: 33.5731, lng: -7.5898,  name: 'Casablanca' },
  { lat: 34.0209, lng: -6.8417,  name: 'Rabat' },
  { lat: 31.6295, lng: -7.9811,  name: 'Marrakesh' },
  { lat: 14.7167, lng: -17.4677, name: 'Dakar' },
  { lat: 12.6392, lng: -8.0029,  name: 'Bamako' },
  { lat: 5.5600,  lng: -0.1969,  name: 'Accra' },
  { lat: 6.5244,  lng: 3.3792,   name: 'Lagos' },
  { lat: 9.0765,  lng: 7.3986,   name: 'Abuja' },
  { lat: 3.8480,  lng: 11.5021,  name: 'Yaoundé' },
  { lat: -4.4419, lng: 15.2663,  name: 'Kinshasa' },
  { lat: 0.3476,  lng: 32.5825,  name: 'Kampala' },
  { lat: -1.2921, lng: 36.8219,  name: 'Nairobi' },
  { lat: -6.7924, lng: 39.2083,  name: 'Dar es Salaam' },
  { lat: -1.9706, lng: 30.1044,  name: 'Kigali' },
  { lat: 9.0145,  lng: 38.7613,  name: 'Addis Ababa' },
  { lat: 15.5527, lng: 32.5599,  name: 'Khartoum' },
  { lat: -8.8390, lng: 13.2894,  name: 'Luanda' },
  { lat: -17.8252, lng: 31.0335, name: 'Harare' },
  { lat: -15.4067, lng: 28.2871, name: 'Lusaka' },
  { lat: -25.7479, lng: 28.2293, name: 'Pretoria' },
  { lat: -26.2041, lng: 28.0473, name: 'Johannesburg' },
  { lat: -29.8587, lng: 31.0218, name: 'Durban' },
  { lat: -33.9249, lng: 18.4241, name: 'Cape Town' },
  { lat: -22.5597, lng: 17.0832, name: 'Windhoek' },
  { lat: -18.8792, lng: 47.5079, name: 'Antananarivo' },

  // Oceania
  { lat: -33.8688, lng: 151.2093, name: 'Sydney' },
  { lat: -37.8136, lng: 144.9631, name: 'Melbourne' },
  { lat: -27.4705, lng: 153.0260, name: 'Brisbane' },
  { lat: -31.9505, lng: 115.8605, name: 'Perth' },
  { lat: -34.9285, lng: 138.6007, name: 'Adelaide' },
  { lat: -35.2809, lng: 149.1300, name: 'Canberra' },
  { lat: -36.8485, lng: 174.7633, name: 'Auckland' },
  { lat: -41.2865, lng: 174.7762, name: 'Wellington' },
  { lat: -43.5321, lng: 172.6362, name: 'Christchurch' },
  { lat: -17.7333, lng: 168.3273, name: 'Port Vila' },
  { lat: -18.1416, lng: 178.4419, name: 'Suva' },

  // Polar / extreme
  { lat: 78.2232, lng: 15.6267,  name: 'Longyearbyen' },
  { lat: 69.6492, lng: 18.9553,  name: 'Tromsø' },
];

// ---------------------------------------------------------------------------
// URL builder (preserved verbatim)
// ---------------------------------------------------------------------------
function estimateZoomForRadiusKm(km) {
  if (km <= 1)    return 17;
  if (km <= 2)    return 16;
  if (km <= 5)    return 15;
  if (km <= 10)   return 14;
  if (km <= 20)   return 13;
  if (km <= 40)   return 12;
  if (km <= 80)   return 11;
  if (km <= 160)  return 10;
  if (km <= 320)  return 9;
  if (km <= 640)  return 8;
  if (km <= 1200) return 7;
  return 6;
}

function clampZoom(z) { return Math.min(20, Math.max(4, Math.round(z))); }

function buildUrl(lat, lon, radiusKm) {
  const zoom = clampZoom(estimateZoomForRadiusKm(Math.max(radiusKm, 0.5)));
  const params = new URLSearchParams({
    lat: lat.toFixed(6),
    lon: lon.toFixed(6),
    zoom: String(zoom),
  });
  return `${PROXY_BASE}/?${params}`;
}

// ---------------------------------------------------------------------------
// Metadata math
// ---------------------------------------------------------------------------
function metersPerPixel(lat, zoom) {
  const C = 156543.03392; // earth circumference in m / 256 px at zoom 0
  return C * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
}

function formatLength(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  if (km >= 100) return `${Math.round(km)} km`;
  return `${km.toFixed(1)} km`;
}

function formatArea(m2) {
  if (m2 < 1e6) return `${Math.round(m2).toLocaleString()} m²`;
  const km2 = m2 / 1e6;
  if (km2 >= 100) return `${Math.round(km2).toLocaleString()} km²`;
  return `${km2.toFixed(2)} km²`;
}

function formatResolution(mpp) {
  if (mpp < 10) return `${mpp.toFixed(1)} m / px`;
  return `${Math.round(mpp)} m / px`;
}

function formatLatLng(lat, lng) {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(6)}° ${latDir}, ${Math.abs(lng).toFixed(6)}° ${lonDir}`;
}

// 1° of latitude = ~111.32 km. We use this to convert the captured image's
// half-side (in km) into degrees on the sphere for the ring radius.
const KM_PER_DEG = 111.32;

// Central angle (great-circle distance, in degrees) between two lat/lng points.
// We use this for every "is feature within radiusDeg of the camera target"
// check. The cheaper cos-corrected Euclidean works near the equator but
// degrades near the poles and across the antimeridian — at high latitudes
// it can cull features that are actually nearby, or keep ones that aren't.
// Haversine is correct everywhere and the per-frame cost is negligible since
// the spatial filters only run on debounced camera-settle, not every frame.
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
function centralAngleDeg(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const sLat = Math.sin(dLat / 2);
  const sLng = Math.sin(dLng / 2);
  const a = sLat * sLat +
            Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
            sLng * sLng;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) * RAD_TO_DEG;
}

// prefers-reduced-motion users get instant camera transitions instead of
// 800 ms tweens; idle globe rotation also stays off. Match-media is checked
// once at load — close enough for our purposes (no live OS-toggle handling).
const PREFERS_REDUCED_MOTION =
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function flightMs(ms) { return PREFERS_REDUCED_MOTION ? 0 : ms; }

// What does the captured image actually cover, in degrees? At zoom Z and
// latitude L, Mapbox's 512×512@2x tile spans 512 logical pixels of
// metersPerPixel(L,Z) each, so half the side is the natural radius for the
// pink ring to indicate "this is what gets photographed".
function captureHalfSideDeg(lat, sliderRadiusKm) {
  const zoom = clampZoom(estimateZoomForRadiusKm(Math.max(sliderRadiusKm, 0.5)));
  const halfSideMeters = 256 * metersPerPixel(lat, zoom);
  return halfSideMeters / 1000 / KM_PER_DEG;
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const latInput      = document.getElementById('lat');
const lonInput      = document.getElementById('lon');
const radiusInput   = document.getElementById('radius');
const radiusValue   = document.getElementById('radius-value');
const captureBtn    = document.getElementById('capture-btn');
const statusEl      = document.getElementById('status');
const resultImg     = document.getElementById('result-img');
const downloadLink  = document.getElementById('download-link');
const shareBtn      = document.getElementById('share-btn');
const historyEl     = document.getElementById('capture-history');
const controlsPanel = document.querySelector('.controls');
const controlsClose = document.getElementById('controls-close');
const controlsReopen = document.getElementById('controls-reopen');
const resultClose    = document.getElementById('result-close');
const resultReopen   = document.getElementById('result-reopen');
const metadataClose  = document.getElementById('metadata-close');
const metadataReopen = document.getElementById('metadata-reopen');

// Allow canvas readback so we can generate thumbnails for the history
// strip. The Worker responds with CORS headers for our allowed origins,
// so an anonymous-credentials request loads cleanly without tainting.
if (resultImg) resultImg.crossOrigin = 'anonymous';
const metadataCard  = document.getElementById('metadata-card');
const coordsReadout = document.getElementById('globe-coords-readout');
const globeStatus   = document.getElementById('globe-status');
const resultPanel   = document.querySelector('.result');
const globeHint     = document.querySelector('.globe-hint');

const metaCoords     = document.getElementById('meta-coords');
const metaZoom       = document.getElementById('meta-zoom');
const metaResolution = document.getElementById('meta-resolution');
const metaSide       = document.getElementById('meta-side');
const metaArea       = document.getElementById('meta-area');
const metaTime       = document.getElementById('meta-time');
const metaSun        = document.getElementById('meta-sun');
const metaSolarTime  = document.getElementById('meta-solar-time');
const metaAntipode   = document.getElementById('meta-antipode');
const metaSource     = document.getElementById('meta-source');
const sourceInfoBtn   = document.getElementById('source-info-btn');
const sourceInfoPopup = document.getElementById('source-info-popup');
const sourceInfoBody  = document.getElementById('source-info-body');
const sourceInfoClose = document.getElementById('source-info-close');

// ---------------------------------------------------------------------------
// Status helper
// ---------------------------------------------------------------------------
function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind || '';
}

// ---------------------------------------------------------------------------
// HUD sync — keeps the overlay in step with the text inputs
// ---------------------------------------------------------------------------
function syncHud() {
  const lat = parseFloat(latInput.value);
  const lon = parseFloat(lonInput.value);
  if (!isNaN(lat) && !isNaN(lon)) {
    coordsReadout.textContent = formatLatLng(lat, lon);
  } else {
    coordsReadout.textContent = '--.------°, --.------°';
  }
}

latInput.addEventListener('input', syncHud);
lonInput.addEventListener('input', syncHud);

// ---------------------------------------------------------------------------
// Target selection — sets coords + visual marker without triggering capture.
// Capture only happens when the user explicitly hits the CAPTURE button.
// ---------------------------------------------------------------------------
// Slider fires `input` events much faster than the browser repaints; we
// coalesce them through requestAnimationFrame so globe.gl only rebuilds
// the cylinder + ring meshes once per frame even on a frantic drag.
let markerRAF = null;
function updateTargetMarker() {
  if (markerRAF !== null) return;
  markerRAF = requestAnimationFrame(() => {
    markerRAF = null;
    if (!globe) return;
    const lat = parseFloat(latInput.value);
    const lng = parseFloat(lonInput.value);
    const sliderKm = parseFloat(radiusInput.value);
    if (isNaN(lat) || isNaN(lng) || isNaN(sliderKm)) return;
    const radiusDeg = captureHalfSideDeg(lat, sliderKm);
    // Both the static disc (pointsData) and the radar pulse (ringsData) read
    // their size from the same per-feature radiusDeg, so slider/disc/ring/image
    // are all describing the same area.
    globe.pointsData([{ lat, lng, radiusDeg }]);
    globe.ringsData([{ lat, lng, radiusDeg }]);
  });
}

function dismissHeader() {
  const header = document.querySelector('.space-header');
  if (header) header.classList.add('dismissed');
}

function setTarget(lat, lng) {
  latInput.value = lat.toFixed(6);
  lonInput.value = lng.toFixed(6);
  syncHud();
  globeStatus.textContent = 'TARGET LOCKED';
  // Hard-stop any idle camera motion the moment the user picks a target.
  // Just flipping autoRotate off isn't enough: OrbitControls accumulates
  // rotation in `_sphericalDelta`, and with damping enabled (default in
  // three-globe) that residual bleeds out over ~1 s. During a pointOfView
  // flight, controls.update() composes that residual on top of the tween
  // each frame and drags the city off-center after the flight settles.
  // Zero the delta so the flight lands precisely on the target.
  if (globe && globe.controls && typeof globe.controls === 'function') {
    const ctrls = globe.controls();
    if (ctrls) {
      ctrls.autoRotate = false;
      const delta = ctrls._sphericalDelta || ctrls.sphericalDelta;
      if (delta && typeof delta.set === 'function') delta.set(0, 0, 0);
      const panOffset = ctrls._panOffset || ctrls.panOffset;
      if (panOffset && typeof panOffset.set === 'function') panOffset.set(0, 0, 0);
    }
  }
  updateTargetMarker();
  dismissHeader();
  // Mobile-only: once a target is locked, the user almost certainly
  // doesn't need the lat/lon text inputs again — they came from a label,
  // preset, or globe click. Drop them from the controls panel via a
  // body class so the sheet is shorter and the radius/CAPTURE controls
  // come up first. CSS at the (max-width: 720px) breakpoint reads it.
  document.body.classList.add('target-locked');
}

// ---------------------------------------------------------------------------
// Radius slider live readout
// ---------------------------------------------------------------------------
radiusInput.addEventListener('input', () => {
  radiusValue.textContent = radiusInput.value;
  updateTargetMarker();
});

// ---------------------------------------------------------------------------
// "Likely source" explainer popup
// ---------------------------------------------------------------------------
function buildSourceInfoHtml() {
  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lonInput.value);
  const sliderKm = parseFloat(radiusInput.value);
  if (isNaN(lat) || isNaN(lng) || isNaN(sliderKm)) {
    return 'Pick a target first to see the example.';
  }
  const zoom = clampZoom(estimateZoomForRadiusKm(Math.max(sliderKm, 0.5)));
  const city = closestCityName(lat, lng);
  const placeStr = city
    ? `your current capture near <strong>${city}</strong>`
    : `your current target at <strong>${formatLatLng(lat, lng)}</strong>`;
  const source = likelyImagerySource(zoom);
  const band = zoomBandLabel(zoom);
  return (
    `Mapbox's <strong>satellite-v9</strong> tileset is a composite — they ` +
    `stitch imagery from several satellites, picking different providers ` +
    `depending on zoom level and region, and they don't publish which ` +
    `satellite shot any specific tile. ` +
    `For ${placeStr} at zoom z${zoom} (${band}), the band is typically ` +
    `backed by <strong>${source}</strong>.`
  );
}

function openSourceInfo() {
  sourceInfoBody.innerHTML = buildSourceInfoHtml();
  sourceInfoPopup.hidden = false;
}

function closeSourceInfo() {
  sourceInfoPopup.hidden = true;
}

if (sourceInfoBtn) {
  sourceInfoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (sourceInfoPopup.hidden) openSourceInfo();
    else closeSourceInfo();
  });
}
if (sourceInfoClose) {
  sourceInfoClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSourceInfo();
  });
}
// Click anywhere outside the popup or the button to dismiss.
document.addEventListener('click', (e) => {
  if (sourceInfoPopup.hidden) return;
  if (sourceInfoPopup.contains(e.target)) return;
  if (e.target === sourceInfoBtn) return;
  closeSourceInfo();
});
// Keep text in sync if the user changes target/radius while the popup is open.
[latInput, lonInput, radiusInput].forEach((el) => {
  el.addEventListener('input', () => {
    if (!sourceInfoPopup.hidden) sourceInfoBody.innerHTML = buildSourceInfoHtml();
  });
});

// ---------------------------------------------------------------------------
// Metadata extras: solar position, local solar time, antipode
// ---------------------------------------------------------------------------

// NOAA-style approximation of the sun's elevation (degrees above horizon)
// at a given lat/lng/UTC date. Good to within ~0.5° — fine for a vibes-y
// "is it day or night where this picture was just taken" readout.
function solarElevationDeg(lat, lng, date) {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - startOfYear) / 86400000;
  const decl = 23.45 * Math.sin((2 * Math.PI * (dayOfYear - 81)) / 365);
  const utcHour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const localSolarHour = utcHour + lng / 15;
  const hourAngle = (localSolarHour - 12) * 15;
  const toRad = Math.PI / 180;
  const sinElev =
    Math.sin(lat * toRad) * Math.sin(decl * toRad) +
    Math.cos(lat * toRad) * Math.cos(decl * toRad) * Math.cos(hourAngle * toRad);
  return Math.asin(Math.max(-1, Math.min(1, sinElev))) / toRad;
}

function describeSun(elevDeg) {
  if (elevDeg >= 6)  return `Day · ${elevDeg.toFixed(1)}° above horizon`;
  if (elevDeg >= 0)  return `Sunrise/sunset · ${elevDeg.toFixed(1)}° above`;
  if (elevDeg >= -6) return `Civil twilight · ${(-elevDeg).toFixed(1)}° below`;
  if (elevDeg >= -18) return `Astronomical twilight · ${(-elevDeg).toFixed(1)}° below`;
  return `Night · ${(-elevDeg).toFixed(1)}° below`;
}

// Solar mean time at the given longitude — rough, ignores equation of time.
function localSolarTime(lng, date) {
  const utcMs = date.getTime();
  const offsetMs = (lng / 15) * 3600 * 1000;
  const local = new Date(utcMs + offsetMs);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} (LMT)`;
}

function antipode(lat, lng) {
  let aLng = lng + 180;
  if (aLng > 180) aLng -= 360;
  if (aLng < -180) aLng += 360;
  return { lat: -lat, lng: aLng };
}

// Mapbox satellite-v9 is a composite — they don't expose per-tile satellite
// metadata, but their docs publish the typical source by zoom band:
// https://docs.mapbox.com/data/tilesets/reference/mapbox-satellite/
function likelyImagerySource(zoom) {
  if (zoom <= 5)  return 'NASA MODIS / Blue Marble';
  if (zoom <= 9)  return 'Landsat 8 (USGS)';
  if (zoom <= 12) return 'Sentinel-2 (ESA) + Landsat';
  if (zoom <= 16) return 'Maxar Vivid';
  return 'Maxar Vivid HD';
}

function zoomBandLabel(zoom) {
  if (zoom <= 5)  return 'global scale';
  if (zoom <= 9)  return 'continental scale';
  if (zoom <= 12) return 'regional scale';
  if (zoom <= 16) return 'city scale';
  return 'street scale';
}

// Closest curated city to a lat/lng — used so the source-info popup can say
// "your capture near Bogotá" instead of just spitting out coordinates.
function closestCityName(lat, lng) {
  let best = null;
  let bestDeg = Infinity;
  for (const c of CITY_LABELS) {
    const ang = centralAngleDeg(lat, lng, c.lat, c.lng);
    if (ang < bestDeg) {
      bestDeg = ang;
      best = c.name;
    }
  }
  return bestDeg < 3 ? best : null;
}

// ---------------------------------------------------------------------------
// Metadata fill
// ---------------------------------------------------------------------------
function fillMetadata(lat, lon, zoom) {
  const mpp = metersPerPixel(lat, zoom);
  const sideMeters = 512 * mpp;
  const areaM2 = sideMeters * sideMeters;
  // @2x: Mapbox returns 1024 physical px representing 512 logical px,
  // so actual ground sample on the image is halved.
  const displayMpp = mpp / 2;

  const now = new Date();
  const elev = solarElevationDeg(lat, lon, now);
  const ant = antipode(lat, lon);

  metaCoords.textContent     = formatLatLng(lat, lon);
  metaZoom.textContent       = `z${zoom} · 512×512 @2x`;
  metaSource.textContent     = likelyImagerySource(zoom);
  metaResolution.textContent = formatResolution(displayMpp);
  metaSide.textContent       = `${formatLength(sideMeters)} × ${formatLength(sideMeters)}`;
  metaArea.textContent       = formatArea(areaM2);
  metaSun.textContent        = describeSun(elev);
  metaSolarTime.textContent  = localSolarTime(lon, now);
  metaAntipode.textContent   = formatLatLng(ant.lat, ant.lng);
  metaTime.textContent       = now.toLocaleString();

  setMetadataVisible(true);
}

// ---------------------------------------------------------------------------
// Share link — encode {lat, lng, radius} into the URL hash so a capture is
// replayable. Hash form: #lat=…&lng=…&r=…  Lat/lng to 6 decimals (~10 cm),
// radius matches the slider step (0.5 km).
// ---------------------------------------------------------------------------
function buildShareHash(lat, lng, radiusKm) {
  const params = new URLSearchParams({
    lat: lat.toFixed(6),
    lng: lng.toFixed(6),
    r: String(radiusKm),
  });
  return params.toString();
}

function parseShareHash() {
  const raw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const lat = parseFloat(params.get('lat'));
  const lng = parseFloat(params.get('lng'));
  const r   = parseFloat(params.get('r'));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  if (!Number.isFinite(r)   || r <= 0) return null;
  return { lat, lng, radius: r };
}

// Updating the hash via history.replaceState avoids both a scroll jump and
// flooding the back-stack with one entry per capture.
function updateShareHash(lat, lng, radiusKm) {
  const hash = '#' + buildShareHash(lat, lng, radiusKm);
  if (window.location.hash === hash) return;
  history.replaceState(null, '', window.location.pathname + window.location.search + hash);
}

let shareCopiedTimer = null;
async function copyShareLink() {
  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lonInput.value);
  const r   = parseFloat(radiusInput.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(r)) return;
  updateShareHash(lat, lng, r);
  const url = window.location.href;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const labelEl = shareBtn.querySelector('.share-btn-label');
    if (labelEl) labelEl.textContent = 'Copied!';
    shareBtn.classList.add('copied');
    if (shareCopiedTimer) clearTimeout(shareCopiedTimer);
    shareCopiedTimer = setTimeout(() => {
      if (labelEl) labelEl.textContent = 'Share';
      shareBtn.classList.remove('copied');
    }, 1600);
  } catch (err) {
    console.warn('[space] share copy failed:', err);
    setStatus('Could not copy link to clipboard.', 'error');
  }
}

if (shareBtn) shareBtn.addEventListener('click', copyShareLink);

// ---------------------------------------------------------------------------
// Closeable panels — controls / result / metadata-card
//
// Each closeable surface keeps its visibility on a single class or attribute,
// and a corresponding reopen affordance becomes visible when it's hidden.
// .result re-uses its existing `.visible` reveal class instead of a new
// collapsed state, so a fresh capture continues to auto-show it.
// ---------------------------------------------------------------------------
// The INPUT pill (controls-reopen) should only surface when the user is
// in "globe-only" mode — neither the controls panel nor the result panel
// is up. Showing it while the result is displayed would tease re-entering
// input on top of an active capture; hiding it then matches the user's
// expectation that the pill represents "no panel, just the globe."
function syncControlsReopenVisibility() {
  if (!controlsReopen) return;
  const collapsed   = !!controlsPanel && controlsPanel.classList.contains('collapsed');
  const resultShown = !!resultPanel   && resultPanel.classList.contains('visible');
  controlsReopen.hidden = !collapsed || resultShown;
}

// Download / Share are tied to the imagery: they only make sense while
// a capture exists AND the result panel is showing it. Closing the
// result hides them; re-opening via the DATA pill brings them back.
// The flag is flipped to true in the capture onload handler.
let captureReady = false;
function syncCaptureActionsVisibility() {
  const resultShown = !!resultPanel && resultPanel.classList.contains('visible');
  const visible = captureReady && resultShown;
  if (downloadLink) downloadLink.hidden = !visible;
  if (shareBtn)     shareBtn.hidden     = !visible;
}

function setControlsVisible(visible) {
  if (!controlsPanel) return;
  controlsPanel.classList.toggle('collapsed', !visible);
  syncControlsReopenVisibility();
}
function setResultVisible(visible) {
  if (!resultPanel) return;
  resultPanel.classList.toggle('visible', visible);
  if (resultReopen) resultReopen.hidden = visible;
  syncCaptureActionsVisibility();
  syncControlsReopenVisibility();
}
function setMetadataVisible(visible) {
  if (!metadataCard) return;
  metadataCard.hidden = !visible;
  if (metadataReopen) metadataReopen.hidden = visible;
}

if (controlsClose)  controlsClose.addEventListener('click',  () => setControlsVisible(false));
if (controlsReopen) controlsReopen.addEventListener('click', () => setControlsVisible(true));
if (resultClose)    resultClose.addEventListener('click',    () => setResultVisible(false));
if (resultReopen)   resultReopen.addEventListener('click',   () => setResultVisible(true));
if (metadataClose)  metadataClose.addEventListener('click',  () => setMetadataVisible(false));
if (metadataReopen) metadataReopen.addEventListener('click', () => setMetadataVisible(true));

// Tap-to-zoom on the captured image. CSS .zoomed promotes the image to
// a full-viewport fixed overlay with object-fit: contain — on mobile
// the user can then pinch-zoom (the page doesn't set user-scalable=no,
// so iOS Safari's native visual-viewport zoom kicks in on the now-
// dominant image). Tap again to dismiss. Escape works on desktop.
if (resultImg) {
  resultImg.addEventListener('click', () => {
    if (resultImg.hidden) return;
    resultImg.classList.toggle('zoomed');
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && resultImg && resultImg.classList.contains('zoomed')) {
    resultImg.classList.remove('zoomed');
  }
});

// On phone-sized viewports, default the controls panel to collapsed so the
// globe fills the screen on first paint. The user opens it via the floating
// "INPUT" pill in the bottom-right when they want to tweak target/radius
// or hit CAPTURE. Desktop and tablet keep the panel open by default.
//
// Also relocate the Download/Share buttons from the controls panel into
// the result panel so they remain accessible after CAPTURE collapses
// the controls. References (downloadLink, shareBtn) survive the move,
// so the existing capture pipeline continues to flip their hidden flags
// and href without any rewiring.
if (
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(max-width: 720px)').matches
) {
  setControlsVisible(false);
  const resultActions = document.querySelector('.result-actions');
  if (resultActions) {
    if (downloadLink)    resultActions.appendChild(downloadLink);
    if (shareBtn)        resultActions.appendChild(shareBtn);
    // Pull the INPUT reopen pill into the same row so all three sit
    // as standalone pills at bottom-right, INPUT last (rightmost).
    if (controlsReopen)  resultActions.appendChild(controlsReopen);
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------
function capture() {
  const lat    = parseFloat(latInput.value);
  const lon    = parseFloat(lonInput.value);
  const radius = parseFloat(radiusInput.value);

  if (isNaN(lat) || lat < -90 || lat > 90) {
    setStatus('Invalid latitude — must be between -90 and 90.', 'error');
    return;
  }
  if (isNaN(lon) || lon < -180 || lon > 180) {
    setStatus('Invalid longitude — must be between -180 and 180.', 'error');
    return;
  }
  if (isNaN(radius) || radius <= 0) {
    setStatus('Invalid radius — must be greater than 0.', 'error');
    return;
  }

  const zoom = clampZoom(estimateZoomForRadiusKm(Math.max(radius, 0.5)));
  const url  = buildUrl(lat, lon, radius);

  setStatus('Acquiring satellite imagery…', 'loading');
  globeStatus.textContent = 'CAPTURING…';
  captureBtn.disabled = true;

  // Reveal the result panel on first capture, hide the onboarding hint.
  // setResultVisible also dismisses any reopen pill the user left up.
  setResultVisible(true);
  if (globeHint)   globeHint.classList.add('hidden');
  // Mobile-only: the controls sheet is no longer relevant once CAPTURE
  // fires — the user's attention shifts to the imagery. Collapse it so
  // the result panel can use the full screen. The INPUT pill stays in
  // the bottom-right for re-targeting.
  if (
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(max-width: 720px)').matches
  ) {
    setControlsVisible(false);
  }

  // Update globe marker and ring to the current target
  updateTargetMarker();

  resultImg.onload = () => {
    resultImg.hidden  = false;
    downloadLink.href = url;
    downloadLink.download = `satellite_${lat.toFixed(4)}_${lon.toFixed(4)}_z${zoom}.jpg`;
    captureReady = true;
    syncCaptureActionsVisibility();
    updateShareHash(lat, lon, radius);
    setStatus('Imagery acquired successfully.', 'ok');
    globeStatus.textContent = 'TARGET LOCKED';
    captureBtn.disabled = false;
    fillMetadata(lat, lon, zoom);
    saveCaptureToHistory({ lat, lng: lon, zoom, radius, url, ts: Date.now() });
  };

  resultImg.onerror = () => {
    setStatus(
      'Image failed to load. The Worker may be unreachable, rate-limited, or the monthly cap has been reached. Try again later.',
      'error'
    );
    globeStatus.textContent = 'SIGNAL LOST';
    captureBtn.disabled = false;
    captureReady = false;
    syncCaptureActionsVisibility();
  };

  resultImg.src = url;
  resultImg.alt = `Satellite image at ${lat.toFixed(4)}, ${lon.toFixed(4)} zoom ${zoom}`;
}

// ---------------------------------------------------------------------------
// Capture button + Enter-key shortcut
// ---------------------------------------------------------------------------
captureBtn.addEventListener('click', capture);
latInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') capture(); });
lonInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') capture(); });

// ---------------------------------------------------------------------------
// Preset buttons
// ---------------------------------------------------------------------------
document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    let lat;
    let lng;
    let radius;
    if (btn.dataset.random === 'true') {
      const pick = CITY_LABELS[Math.floor(Math.random() * CITY_LABELS.length)];
      lat = pick.lat;
      lng = pick.lng;
      radius = 5;
    } else {
      lat = parseFloat(btn.dataset.lat);
      lng = parseFloat(btn.dataset.lon);
      radius = parseFloat(btn.dataset.radius);
    }

    radiusInput.value       = String(radius);
    radiusValue.textContent = String(radius);
    setTarget(lat, lng);

    if (globe) {
      globe.pointOfView({ lat, lng, altitude: 0.06 }, flightMs(800));
      setTimeout(() => globe._refreshAfterFlight && globe._refreshAfterFlight(), 900);
    }
  });
});

// ---------------------------------------------------------------------------
// 3D Globe (Globe.gl)
// ---------------------------------------------------------------------------
let globe = null;

(function initGlobe() {
  const container = document.getElementById('globe-container');
  if (!container || typeof globalThis.Globe !== 'function') return;

  // Fire the manifest fetch in parallel with globe construction. The slippy
  // tile engine doesn't ask for tiles until altitude drops below ~0.15, so
  // the small JSON has plenty of time to land before its first lookup.
  loadTileManifest().then((set) => { LOCAL_TILES = set; });

  globe = globalThis.Globe()(container)
    .globeImageUrl(GLOBE_TEXTURE)
    .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')
    .backgroundColor('rgba(0,0,0,0)')
    .showAtmosphere(true)
    .atmosphereColor('#7fff80')
    .atmosphereAltitude(0.18)
    .width(container.clientWidth)
    .height(container.clientHeight)
    // Slippy-tile engine. globe.gl computes the visible tile set per frame,
    // fetches each tile by calling this URL builder, drapes them on the
    // sphere with proper Mercator unwrapping, and disposes textures we no
    // longer need. The Blue Marble image above stays as the underlying
    // texture so orbital views (and any tile gaps mid-load) still show
    // recognizable Earth instead of black.
    .globeTileEngineUrl((x, y, l) => {
      const key = `${l}/${x}/${y}`;
      if (LOCAL_TILES && LOCAL_TILES.has(key)) {
        return `${TILE_LOCAL_BASE}/${l}/${x}/${y}.jpg`;
      }
      return `${TILE_PROXY_BASE}/${l}/${x}/${y}`;
    })
    // Target marker — semi-transparent disc whose radius matches the capture
    // half-side, so the user gets a visible footprint of what the next image
    // will cover. Lifted slightly above the polygon stack to stay visible.
    .pointAltitude(0.012)
    .pointRadius((d) => d.radiusDeg)
    // 12 segments is the default — drop to 8 so each rebuild on slider drag
    // is half the geometry. Visually indistinguishable for a translucent disc.
    .pointResolution(8)
    .pointColor(() => 'rgba(95,207,255, 0.45)')
    // Pulsing ring — altitude bumped above the polygon overlays (0.004–0.005)
    // so country borders and lakes can't depth-occlude it even when their
    // caps are transparent. Radius and propagation speed read off
    // each ring's own `radiusDeg`, set by updateTargetMarker() to match the
    // half-side of the captured image. So the pulse fans out exactly to the
    // edge of what the next CAPTURE will photograph.
    .ringAltitude(0.012)
    .ringColor(() => 'rgba(95,207,255,0.8)')
    .ringMaxRadius((d) => d.radiusDeg)
    .ringPropagationSpeed((d) => Math.max(d.radiusDeg / 1.2, 0.005))
    .ringRepeatPeriod(1500)
    // Vector overlays. Country borders load on init; lakes lazy-load on
    // first close-zoom. All features carry a `_kind` property so the
    // polygon style callbacks render each layer differently.
    .polygonsData([])
    .polygonAltitude((d) => {
      // Stack altitudes so country outlines sit above lakes to avoid
      // z-fighting on the extruded caps.
      switch (d._kind) {
        case 'lake':    return 0.004;
        case 'country': return 0.005;
        default:        return 0.005;
      }
    })
    .polygonCapColor((d) => {
      // Filled = visible polygon body (cap is the top face of the extrusion).
      switch (d._kind) {
        case 'lake':  return 'rgba(40,220,120, 0.35)';
        default:      return 'rgba(0,0,0,0)';
      }
    })
    .polygonSideColor(() => 'rgba(0,0,0,0)')
    .polygonStrokeColor((d) => {
      switch (d._kind) {
        case 'lake':    return 'rgba(80,255,150, 0.7)';
        case 'country': return 'rgba(57,255,20, 0.6)';
        default:        return 'rgba(0,0,0,0)';
      }
    })
    // City labels as DOM elements. WebGL-rendered labels use a default
    // typeface that lacks extended Latin glyphs (so 'Bogotá' became 'Bogot?');
    // HTML labels inherit the page's CSS font and support all Unicode.
    // Each element also gets its own click handler — clicking the label
    // snaps to the city's exact coordinates instead of relying on the
    // sphere raycast hitting the right pixel.
    // Initial label set is the top tier only (matches default altitude 1.8).
    // The onZoom listener swaps in the larger tier sets as the camera drops.
    .htmlElementsData(citiesForAltitude(1.8))
    .htmlLat('lat')
    .htmlLng('lng')
    .htmlAltitude(0.012)
    .htmlElement((d) => {
      const el = document.createElement('div');
      el.className = 'globe-city-label';
      el.title = `Lock target on ${d.name} and zoom in`;
      const dot = document.createElement('span');
      dot.className = 'city-dot';
      const name = document.createElement('span');
      name.className = 'city-name';
      name.textContent = d.name;
      el.appendChild(dot);
      el.appendChild(name);
      // Clicking a label locks the target and flies the camera in close
      // enough that the user can pick a more precise spot inside the city.
      // Capture only happens when they hit the CAPTURE button.
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        setTarget(d.lat, d.lng);
        // Surface the controls panel on label tap. On mobile it may be
        // collapsed (initial state, or after a previous CAPTURE) and
        // the user almost certainly wants to hit CAPTURE next. On
        // desktop it's already visible — no-op.
        setControlsVisible(true);
        loadDetailLayers(); // start fetching detail data immediately
        globe.pointOfView({ lat: d.lat, lng: d.lng, altitude: 0.06 }, flightMs(800));
        // Force a refresh once the flight settles.
        setTimeout(() => globe._refreshAfterFlight && globe._refreshAfterFlight(), 900);
      });
      return el;
    });

  // Tagged feature buckets. Country borders load now; lakes are lazy.
  // Each feature is augmented with a centroid so we can do a cheap spatial
  // filter (only render polygons within angular range of the camera).
  const polyBuckets = { country: [], lake: [] };

  // Spherical centroid + angular extent: convert each ring vertex to a 3D
  // unit vector, average + normalize for the centroid, then a second pass
  // records the max angular distance from centroid to any vertex.
  //
  // The centroid alone isn't enough to cull big polygons correctly — a
  // 12° camera radius at close zoom drops Russia from any city east of
  // ~Yekaterinburg (Russia's centroid sits in central Siberia, ~35° from
  // Kamchatka). Padding the cull by `_extentDeg` (the polygon's own
  // angular footprint) keeps the outline visible whenever the camera is
  // anywhere inside or near the polygon, regardless of how far the
  // centroid is.
  //
  // Vector-space averaging also handles antimeridian-crossing features
  // (Russia, Fiji, the Aleutians) correctly — a plain lat/lng bbox center
  // would put Russia's centroid over Europe.
  function sphericalCentroidAndExtent(geometry) {
    let sx = 0, sy = 0, sz = 0, n = 0;
    const accum = (a) => {
      if (typeof a[0] === 'number') {
        const lng = a[0] * DEG_TO_RAD;
        const lat = a[1] * DEG_TO_RAD;
        const c = Math.cos(lat);
        sx += c * Math.cos(lng);
        sy += c * Math.sin(lng);
        sz += Math.sin(lat);
        n++;
      } else {
        for (const x of a) accum(x);
      }
    };
    accum(geometry.coordinates);
    if (n === 0) return { lat: 0, lng: 0, extentDeg: 0 };
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
    const cx = sx / len, cy = sy / len, cz = sz / len;
    const lat = Math.asin(Math.max(-1, Math.min(1, cz))) * RAD_TO_DEG;
    const lng = Math.atan2(cy, cx) * RAD_TO_DEG;
    // Second pass: max angle from centroid to any vertex. Track the min
    // dot product (cos of largest angle) and convert back at the end.
    let minDot = 1;
    const extent = (a) => {
      if (typeof a[0] === 'number') {
        const vlng = a[0] * DEG_TO_RAD;
        const vlat = a[1] * DEG_TO_RAD;
        const vc = Math.cos(vlat);
        const dot = cx * (vc * Math.cos(vlng))
                  + cy * (vc * Math.sin(vlng))
                  + cz * Math.sin(vlat);
        if (dot < minDot) minDot = dot;
      } else {
        for (const x of a) extent(x);
      }
    };
    extent(geometry.coordinates);
    const extentDeg = Math.acos(Math.max(-1, Math.min(1, minDot))) * RAD_TO_DEG;
    return { lat, lng, extentDeg };
  }

  function tagFeature(feature, kind) {
    const { lat, lng, extentDeg } = sphericalCentroidAndExtent(feature.geometry);
    return { ...feature, _kind: kind, _lat: lat, _lng: lng, _extentDeg: extentDeg };
  }

  // Spatial filter: keep a feature whose centroid sits within
  // `radiusDeg + feature._extentDeg` of the camera. The extent term means
  // any polygon whose footprint reaches the view passes — without it,
  // big countries (Russia, USA, China) get culled when the camera sits
  // near their edge but far from their centroid.
  function filterToView(features, centerLat, centerLng, radiusDeg) {
    if (radiusDeg >= 360) return features;
    return features.filter(
      (f) =>
        centralAngleDeg(centerLat, centerLng, f._lat, f._lng) <
        radiusDeg + (f._extentDeg || 0)
    );
  }

  let lastFilterKey = '';
  function refreshPolygons() {
    const pov = globe.pointOfView();
    // Wider radius at higher altitude; tighter when zoomed in close.
    const radiusDeg =
      pov.altitude > 1.0 ? 360 :
      pov.altitude > 0.4 ? 60 :
      pov.altitude > 0.15 ? 25 :
      12;
    // Cheap stability key so we don't re-filter on every animation frame.
    const key = `${radiusDeg}|${pov.lat.toFixed(1)}|${pov.lng.toFixed(1)}|${polyBuckets.lake.length}|${polyBuckets.country.length}`;
    if (key === lastFilterKey) return;
    lastFilterKey = key;
    // Country borders also get spatially filtered at close zoom — at
    // altitude < 0.5 there are at most a handful in view, no point paying
    // for ~250 extruded meshes globally.
    const countries = pov.altitude > 0.5
      ? polyBuckets.country
      : filterToView(polyBuckets.country, pov.lat, pov.lng, radiusDeg);
    globe.polygonsData([
      ...countries,
      ...filterToView(polyBuckets.lake, pov.lat, pov.lng, radiusDeg),
    ]);
  }

  fetch(COUNTRIES_GEOJSON_URL)
    .then((r) => r.json())
    .then((geo) => {
      // Skip Antarctica — its polygon spans the whole bottom and looks messy.
      polyBuckets.country = geo.features
        .filter((f) => f.properties && f.properties.ISO_A2 !== 'AQ')
        .map((f) => tagFeature(f, 'country'));
      refreshPolygons();
    })
    .catch(() => {});

  // Populated places — used as the close-zoom label layer for richer
  // regional context beyond the curated CITY_LABELS list. Stored as
  // {lat, lng, name} so the existing htmlElement renderer works unchanged.
  let popPlaces = [];

  function filterPointsToView(points, centerLat, centerLng, radiusDeg) {
    if (radiusDeg >= 360) return points;
    return points.filter(
      (p) => centralAngleDeg(centerLat, centerLng, p.lat, p.lng) < radiusDeg
    );
  }

  let lastLabelKey = '';
  function refreshLabels() {
    const pov = globe.pointOfView();
    let labels;
    let key;
    if (pov.altitude > 0.5) {
      // Far/medium: curated tiered set, no spatial cull (small lists).
      labels = citiesForAltitude(pov.altitude);
      key = `tier|${labels.length}`;
    } else {
      // Close: combine curated CITY_LABELS (so megacities never disappear)
      // with the populated-places dataset for richer regional context, all
      // spatially filtered. Wider radius than the polygon cull because labels
      // are cheap (DOM elements; globe.gl auto-hides backside ones).
      const radiusDeg = pov.altitude > 0.15 ? 45 : 25;
      const curatedInView = filterPointsToView(
        CITY_LABELS, pov.lat, pov.lng, radiusDeg
      );
      // Accent-fold the dedupe key so curated 'Bogotá' matches NE's 'Bogota',
      // 'Brasília' matches 'Brasilia', etc. — otherwise both render and the
      // user sees double labels for any city with a diacritic.
      const seen = new Set(curatedInView.map((c) => normalizeCityName(c.name)));
      const popInView = popPlaces.length
        ? filterPointsToView(popPlaces, pov.lat, pov.lng, radiusDeg)
            .filter((p) => p.name && !seen.has(normalizeCityName(p.name)))
        : [];
      labels = [...curatedInView, ...popInView];
      key = `near|${pov.lat.toFixed(1)}|${pov.lng.toFixed(1)}|${radiusDeg}|${labels.length}|${popPlaces.length}`;
    }
    if (key === lastLabelKey) return;
    lastLabelKey = key;
    globe.htmlElementsData(labels);
  }

  // One-shot lazy loaders for the close-zoom layers.
  const lazyLoaded = { lake: false, pop: false };
  function loadDetailLayers() {
    if (!lazyLoaded.lake) {
      lazyLoaded.lake = true;
      fetch(LAKES_GEOJSON_URL)
        .then((r) => r.json())
        .then((geo) => {
          polyBuckets.lake = geo.features.map((f) => tagFeature(f, 'lake'));
          lastFilterKey = '';
          scheduleHeavyRefresh();
        })
        .catch(() => { lazyLoaded.lake = false; });
    }
    if (!lazyLoaded.pop) {
      lazyLoaded.pop = true;
      fetch(POP_PLACES_URL)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((geo) => {
          popPlaces = geo.features
            .filter((f) =>
              f.properties &&
              typeof f.properties.SCALERANK === 'number' &&
              f.properties.SCALERANK <= POP_PLACES_MAX_SCALERANK
            )
            .map((f) => ({
              lat: f.geometry.coordinates[1],
              lng: f.geometry.coordinates[0],
              name: f.properties.NAME || f.properties.NAMEASCII || '',
            }));
          lastLabelKey = ''; // force re-render of labels
          scheduleHeavyRefresh();
        })
        .catch((err) => {
          console.error('[space] populated-places fetch failed:', err);
          lazyLoaded.pop = false;
        });
    }
  }

  // Slow idle rotation. Skip for users who prefer reduced motion — the
  // continuous spin can be motion-sickness-inducing.
  globe.controls().autoRotate      = !PREFERS_REDUCED_MOTION;
  globe.controls().autoRotateSpeed = 0.4;

  // Stop rotation on any user interaction with the globe
  container.addEventListener('mousedown',  () => { globe.controls().autoRotate = false; });
  container.addEventListener('touchstart', () => { globe.controls().autoRotate = false; }, { passive: true });

  // Drop initial marker on default Stockholm coords
  updateTargetMarker();
  globe.pointOfView({ lat: DEFAULT_LAT, lng: DEFAULT_LON, altitude: 1.8 });

  // City label clicks are handled by the label's own DOM click listener,
  // which calls setTarget with the city's exact coordinates. The globe
  // and polygon raycaster click handlers fire for the same event, and
  // would otherwise overwrite that with the click's projected lat/lng
  // (close to the label but not exactly the city center). Skip them when
  // the click started on a label.
  function clickStartedOnLabel(event) {
    return !!(event &&
              event.target &&
              typeof event.target.closest === 'function' &&
              event.target.closest('.globe-city-label'));
  }

  // Globe click → set the target and update marker/ring. Capture is a
  // separate explicit action — the user hits CAPTURE when they're ready.
  // Surface the controls panel: on mobile it may be collapsed and the
  // user's next move is almost certainly CAPTURE.
  globe.onGlobeClick(({ lat, lng }, event) => {
    if (clickStartedOnLabel(event)) return;
    setTarget(lat, lng);
    setControlsVisible(true);
  });

  // Polygons (country borders, lakes) are 3D meshes above the
  // sphere, so when the user clicks on land their click hits the polygon
  // before reaching the globe sphere — onGlobeClick never fires. Register
  // onPolygonClick to forward those clicks to the same setTarget code,
  // using the globe-projected click point so the target lands exactly
  // where the cursor was, not at the polygon's centroid.
  globe.onPolygonClick((polygon, event) => {
    if (clickStartedOnLabel(event)) return;
    if (event && typeof globe.toGlobeCoords === 'function') {
      const coords = globe.toGlobeCoords(event.clientX, event.clientY);
      if (coords && !isNaN(coords.lat) && !isNaN(coords.lng)) {
        setTarget(coords.lat, coords.lng);
        setControlsVisible(true);
        return;
      }
    }
    if (polygon && typeof polygon._lat === 'number') {
      setTarget(polygon._lat, polygon._lng);
      setControlsVisible(true);
    }
  });

  // Disable the per-layer fade-in/out tweens — the user wants the disc and
  // ring to track the radius slider in real time. globe.gl's defaults
  // animate over ~1 s, which feels laggy especially when polygons occlude
  // the cylinder mid-transition. Feature-detected so missing methods don't
  // break the page.
  if (typeof globe.pointsTransitionDuration === 'function') {
    globe.pointsTransitionDuration(0);
  }
  if (typeof globe.polygonsTransitionDuration === 'function') {
    globe.polygonsTransitionDuration(0);
  }

  // Camera-driven detail updates. We listen to three.js OrbitControls
  // 'change' instead of globe.gl's onZoom because the latter doesn't
  // reliably fire during programmatic pointOfView flights in all versions.
  //
  // Light work (body class, lazy-load trigger, header dismiss) runs every
  // change. Heavier work — re-filtering polygons/labels and recomputing
  // the tile set — is debounced to fire 80 ms after the camera settles,
  // so a fly-in across dozens of degrees triggers exactly one heavy
  // refresh at the end instead of one per animation frame.
  let settleTimer = null;
  function scheduleHeavyRefresh() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      refreshLabels();
      refreshPolygons();
    }, 80);
  }
  function onCameraChange() {
    const pov = globe.pointOfView();
    const { altitude } = pov;
    if (altitude < 1.5) dismissHeader();
    if (altitude < VECTOR_LOAD_ALTITUDE) loadDetailLayers();
    // At close zoom, let clicks pass straight through labels to the globe
    // sphere underneath. CSS rule keyed off this class flips
    // `pointer-events: none` on the city labels.
    document.body.classList.toggle('globe-close-zoom', altitude < 0.2);
    scheduleHeavyRefresh();
  }
  globe.controls().addEventListener('change', onCameraChange);

  // Expose a synchronous refresh for the label/preset click handlers to
  // call right after their pointOfView animation finishes — bypasses the
  // settle debounce so the user sees the new vector overlay/labels exactly
  // when the camera arrives.
  globe._refreshAfterFlight = () => {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    loadDetailLayers();
    refreshLabels();
    refreshPolygons();
  };

  // Keep canvas sized to its container on window resize
  window.addEventListener('resize', () => {
    globe.width(container.clientWidth).height(container.clientHeight);
  });
})();

// ---------------------------------------------------------------------------
// Capture history — persists the last few successful captures locally so
// the user can flip between them without burning Worker quota. We store a
// tiny JPEG thumbnail plus the original URL; revisiting the same URL is
// served from the browser HTTP cache (Worker sets max-age=86400) so a
// replay typically does not increment our monthly counter.
// ---------------------------------------------------------------------------
const HISTORY_KEY = 'space.history.v1';
const HISTORY_MAX = 6;
const THUMB_PX = 96;

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persistHistory(history) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // QuotaExceededError, private-browsing denial, etc. — skip silently.
  }
}

// Quantize the storage key so a tap-tap-tap on the same spot doesn't fill
// history with near-duplicates. ~10 m at the equator is finer than the
// imagery resolves, plenty for "have I already captured this?".
function captureKey(lat, lng, zoom) {
  return `${lat.toFixed(4)}|${lng.toFixed(4)}|z${zoom}`;
}

function makeThumbnail(img, size) {
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch (err) {
    // Tainted canvas (image loaded without proper CORS) — skip the thumb.
    console.warn('[space] thumbnail generation failed:', err);
    return null;
  }
}

function saveCaptureToHistory(entry) {
  if (!entry || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lng)) return;
  const thumb = makeThumbnail(resultImg, THUMB_PX);
  const item = { ...entry, thumb };
  const history = loadHistory();
  const key = captureKey(item.lat, item.lng, item.zoom);
  const filtered = history.filter(
    (h) => captureKey(h.lat, h.lng, h.zoom) !== key
  );
  filtered.unshift(item);
  const trimmed = filtered.slice(0, HISTORY_MAX);
  persistHistory(trimmed);
  renderHistory(trimmed);
}

// Short coord form used as the history-strip label when no curated city
// is within range. "59.3°N 18.1°E" reads at a glance and fits a 64 px tile.
function formatLatLngShort(lat, lng) {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}°${latDir} ${Math.abs(lng).toFixed(1)}°${lonDir}`;
}

function placeLabelFor(lat, lng) {
  return closestCityName(lat, lng) || formatLatLngShort(lat, lng);
}

function renderHistory(items) {
  if (!historyEl) return;
  const list = items || loadHistory();
  // Strip excludes the most recent entry — that's whatever the image frame
  // is currently showing, no point listing it as a "recent" capture too.
  // Hide the strip entirely until there's at least one previous capture
  // (i.e. ≥2 captures total).
  const visible = list.slice(1);
  if (!visible.length) {
    historyEl.hidden = true;
    historyEl.innerHTML = '';
    return;
  }
  historyEl.hidden = false;
  historyEl.innerHTML = '';

  const heading = document.createElement('div');
  heading.className = 'history-label';
  heading.textContent = 'RECENT CAPTURES';
  historyEl.appendChild(heading);

  const strip = document.createElement('div');
  strip.className = 'history-strip';
  for (const item of visible) {
    const place = placeLabelFor(item.lat, item.lng);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item';
    btn.title = `${place} · ${formatLatLng(item.lat, item.lng)} · ${item.radius} km · z${item.zoom}`;
    btn.setAttribute(
      'aria-label',
      `Replay capture near ${place}, ${item.radius} km radius`
    );

    if (item.thumb) {
      const img = document.createElement('img');
      img.src = item.thumb;
      img.alt = '';
      btn.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'history-item-placeholder';
      ph.innerHTML = '<i class="fas fa-satellite-dish" aria-hidden="true"></i>';
      btn.appendChild(ph);
    }

    const meta = document.createElement('span');
    meta.className = 'history-item-meta';
    meta.textContent = place;
    btn.appendChild(meta);

    btn.addEventListener('click', () => replayCapture(item));
    strip.appendChild(btn);
  }
  historyEl.appendChild(strip);
}

function replayCapture(item) {
  radiusInput.value       = String(item.radius);
  radiusValue.textContent = String(item.radius);
  setTarget(item.lat, item.lng);
  if (globe) {
    globe.pointOfView({ lat: item.lat, lng: item.lng, altitude: 0.06 }, flightMs(800));
    setTimeout(() => {
      if (globe._refreshAfterFlight) globe._refreshAfterFlight();
    }, 900);
  }
  capture();
}

renderHistory();

// ---------------------------------------------------------------------------
// Initial HUD
// ---------------------------------------------------------------------------
syncHud();
globeStatus.textContent = 'READY';

// ---------------------------------------------------------------------------
// Share-link bootstrap — if the page loaded with a #lat=…&lng=…&r=… hash,
// apply that target, fly the globe in, and auto-capture so the recipient
// sees the same imagery the sharer did. Plain visits without a hash drop
// into the normal Stockholm idle state.
// ---------------------------------------------------------------------------
function applyShareFromHash() {
  const parsed = parseShareHash();
  if (!parsed) return;
  const { lat, lng, radius } = parsed;
  radiusInput.value       = String(radius);
  radiusValue.textContent = String(radius);
  setTarget(lat, lng);
  if (globe) {
    globe.pointOfView({ lat, lng, altitude: 0.06 }, flightMs(800));
    setTimeout(() => {
      if (globe._refreshAfterFlight) globe._refreshAfterFlight();
      capture();
    }, 900);
  } else {
    // Globe failed to init (no WebGL) — still trigger the capture so the
    // image and metadata fill in.
    capture();
  }
}
applyShareFromHash();
