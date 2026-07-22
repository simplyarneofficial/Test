const ROUTER_URL = 'https://brouter.de/brouter';
const GEOCODER_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const map = L.map('map', {
  zoomControl: false,
  rotate: true,
  touchRotate: false,
  rotateControl: false,
  bearing: 0
}).setView([51.7563, 14.3329], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap-Mitwirkende'
}).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

let startPoint = null;
let destinationPoint = null;
let routeLayer = null;
let positionMarker = null;
let watchId = null;
let currentRoute = null;
let currentMode = 'fast';
let lastSpoken = -1;
let lastRecalculation = 0;
let navigationFollowing = true;
let lastPosition = null;
let lastHeading = 0;
let routeProgress = null;
let snappedPosition = null;
let currentMapBearing = 0;
let waypoints = [];
let waypointCounter = 0;
let stopMarkers = [];
let voiceMuted = false;
let navigationOverview = false;
let selectedVoiceName = localStorage.getItem('mopedVoiceName') || '';
let voiceVolume = Number(localStorage.getItem('mopedVoiceVolume') || 1);
let voiceRate = Number(localStorage.getItem('mopedVoiceRate') || 1);
let spokenStages = new Set();
let announcedWaypoints = new Set();
let arrivalAnnounced = false;
let lastNavigationProgress = 0;
let filteredGpsPosition = null;
let targetSnappedPosition = null;
let displayedSnappedPosition = null;
let targetRouteHeading = 0;
let displayedRouteHeading = 0;
let lastSnapIndex = 0;
let lastSnapProgress = 0;
let navigationAnimationFrame = null;
let lastMapFollowFrame = 0;
let instructionDistanceHistory = new Map();
let lastGpsTimestamp = 0;
let filteredSpeedKmh = 0;
let lastRawGpsPosition = null;
let lastRawGpsTimestamp = 0;
let routeTurnMarkerLayer = null;
let routeTurnMarkerSpecs = [];
let routeTurnMarkerRenderFrame = null;
let activeRouteTurnMarkerSpec = null;

const $ = id => document.getElementById(id);
function showStatus(message, duration = 4000) {
  const element = $('status');
  element.textContent = message;
  element.classList.remove('hidden');
  window.clearTimeout(showStatus.timer);
  showStatus.timer = window.setTimeout(() => element.classList.add('hidden'), duration);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

document.querySelectorAll('.mode').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.mode').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    currentMode = button.dataset.mode;
  });
});

async function searchAddress(query) {
  if (query.trim().length < 3) return [];
  const url = new URL(GEOCODER_URL);
  url.searchParams.set('q', query.trim());
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '6');
  url.searchParams.set('countrycodes', 'de');
  url.searchParams.set('accept-language', 'de');
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Adresssuche ist gerade nicht erreichbar.');
  return response.json();
}

function bindAutocomplete(inputId, listId, setter) {
  let timer;
  $(inputId).addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const list = $(listId);
      list.innerHTML = '';
      try {
        const results = await searchAddress($(inputId).value);
        results.forEach(item => {
          const button = document.createElement('button');
          button.className = 'suggestion';
          button.textContent = item.display_name;
          button.addEventListener('click', () => {
            setter({ lat: Number(item.lat), lon: Number(item.lon), label: item.display_name });
            $(inputId).value = item.display_name;
            list.innerHTML = '';
          });
          list.appendChild(button);
        });
      } catch (error) {
        showStatus(error.message);
      }
    }, 450);
  });
}

bindAutocomplete('startInput', 'startSuggestions', point => { startPoint = point; });
bindAutocomplete('destinationInput', 'destinationSuggestions', point => { destinationPoint = point; });


function waypointLabel(point, index) {
  return point?.label || `Zwischenstopp ${index + 1}`;
}

function addWaypoint(initialPoint = null) {
  const item = { id: ++waypointCounter, point: initialPoint };
  waypoints.push(item);
  renderWaypoints();
}

function renderWaypoints() {
  const list = $('waypointsList');
  list.innerHTML = '';
  waypoints.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'waypoint-row';
    row.innerHTML = `
      <span class="waypoint-number">${index + 1}</span>
      <input id="waypoint-${item.id}" autocomplete="off" placeholder="Zwischenstopp ${index + 1}" value="${item.point?.label ? escapeHtml(item.point.label) : ''}">
      <button class="waypoint-remove" type="button" title="Zwischenstopp löschen">×</button>
      <div class="waypoint-controls">
        <button class="waypoint-up" type="button" ${index === 0 ? 'disabled' : ''}>Nach oben</button>
        <button class="waypoint-down" type="button" ${index === waypoints.length - 1 ? 'disabled' : ''}>Nach unten</button>
      </div>
      <div id="waypoint-suggestions-${item.id}" class="suggestions waypoint-suggestions"></div>`;
    list.appendChild(row);
    const input = row.querySelector('input');
    let timer;
    input.addEventListener('input', () => {
      item.point = null;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const suggestions = row.querySelector('.waypoint-suggestions');
        suggestions.innerHTML = '';
        try {
          const results = await searchAddress(input.value);
          results.forEach(result => {
            const button = document.createElement('button');
            button.className = 'suggestion';
            button.textContent = result.display_name;
            button.addEventListener('click', () => {
              item.point = { lat: Number(result.lat), lon: Number(result.lon), label: result.display_name };
              input.value = result.display_name;
              suggestions.innerHTML = '';
            });
            suggestions.appendChild(button);
          });
        } catch (error) { showStatus(error.message); }
      }, 400);
    });
    row.querySelector('.waypoint-remove').addEventListener('click', () => {
      waypoints = waypoints.filter(point => point.id !== item.id);
      renderWaypoints();
    });
    row.querySelector('.waypoint-up').addEventListener('click', () => moveWaypoint(index, -1));
    row.querySelector('.waypoint-down').addEventListener('click', () => moveWaypoint(index, 1));
  });
}

function moveWaypoint(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= waypoints.length) return;
  [waypoints[index], waypoints[target]] = [waypoints[target], waypoints[index]];
  renderWaypoints();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[character]);
}

async function resolveWaypoints() {
  const resolved = [];
  for (const item of waypoints) {
    if (item.point) {
      resolved.push(item.point);
      continue;
    }
    const input = $(`waypoint-${item.id}`);
    const results = await searchAddress(input?.value || '');
    if (!results[0]) throw new Error('Ein Zwischenstopp konnte nicht gefunden werden.');
    item.point = { lat: Number(results[0].lat), lon: Number(results[0].lon), label: results[0].display_name };
    resolved.push(item.point);
  }
  return resolved;
}

$('addWaypointBtn').addEventListener('click', () => addWaypoint());
$('swapRouteBtn').addEventListener('click', () => {
  const oldStart = startPoint;
  startPoint = destinationPoint;
  destinationPoint = oldStart;
  const startValue = $('startInput').value;
  $('startInput').value = $('destinationInput').value;
  $('destinationInput').value = startValue;
});

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Dieses Gerät unterstützt keinen Standort.'));
    navigator.geolocation.getCurrentPosition(
      position => resolve({ lat: position.coords.latitude, lon: position.coords.longitude, label: 'Aktueller Standort' }),
      () => reject(new Error('Standort konnte nicht ermittelt werden. Prüfe die Berechtigung.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
    );
  });
}

async function useCurrentLocation() {
  try {
    startPoint = await getLocation();
    $('startInput').value = 'Aktueller Standort';
    map.setView([startPoint.lat, startPoint.lon], 16);
  } catch (error) {
    showStatus(error.message);
  }
}
$('useLocationBtn').addEventListener('click', useCurrentLocation);
$('locateBtn').addEventListener('click', useCurrentLocation);

async function resolveInput(inputId, existingPoint) {
  if (existingPoint) return existingPoint;
  const results = await searchAddress($(inputId).value);
  if (!results[0]) return null;
  return { lat: Number(results[0].lat), lon: Number(results[0].lon), label: results[0].display_name };
}

function getAlternativeIndex(mode) {
  if (mode === 'safe') return 1;
  if (mode === 'strict50') return 2;
  return 0;
}

async function requestRoute(start, destination, mode, intermediatePoints = []) {
  const url = new URL(ROUTER_URL);
  const routePoints = [start, ...intermediatePoints, destination];
  url.searchParams.set('lonlats', routePoints.map(point => `${point.lon},${point.lat}`).join('|'));
  url.searchParams.set('profile', 'moped');
  url.searchParams.set('alternativeidx', String(getAlternativeIndex(mode)));
  url.searchParams.set('format', 'geojson');
  url.searchParams.set('timode', '2');
  const response = await fetch(url, { headers: { Accept: 'application/geo+json,application/json' } });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail.slice(0, 180) || 'Keine passende Moped-Route gefunden.');
  }
  const geojson = await response.json();
  const feature = geojson.type === 'FeatureCollection' ? geojson.features.find(item => item.geometry?.type === 'LineString') : geojson;
  if (!feature?.geometry?.coordinates?.length) throw new Error('Der Routingdienst hat keine Route geliefert.');
  const properties = feature.properties || geojson.properties || {};
  const coordinates = feature.geometry.coordinates;
  const distance = Number(properties['track-length'] || properties.distance || polylineLength(coordinates));
  const progress = buildRouteProgress(coordinates);
  let instructions = buildInstructions(coordinates);
  try {
    instructions = await enrichInstructionsWithRoundabouts(coordinates, progress, instructions);
  } catch (error) {
    console.warn('Kreisverkehrsdaten konnten nicht ergänzt werden:', error);
  }
  return {
    feature,
    coordinates,
    distance,
    time: estimateMopedTravelTime(distance, mode, intermediatePoints.length),
    instructions,
    progress
  };
}


function buildRouteProgress(coordinates) {
  const cumulative = [0];
  for (let i = 1; i < coordinates.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distanceMeters(
      { lat: coordinates[i - 1][1], lon: coordinates[i - 1][0] },
      { lat: coordinates[i][1], lon: coordinates[i][0] }
    ));
  }
  return { cumulative, total: cumulative.at(-1) || 0 };
}

function nearestPointOnRoute(position, { local = true } = {}) {
  const coordinates = currentRoute.coordinates;
  const latScale = 111320;
  const lonScale = Math.max(1, 111320 * Math.cos(position.lat * Math.PI / 180));
  let best = {
    index: 0,
    nextIndex: Math.min(1, coordinates.length - 1),
    fraction: 0,
    distance: Infinity,
    point: { lat: coordinates[0][1], lon: coordinates[0][0] },
    progress: 0,
    heading: 0
  };

  // Während der Navigation zuerst nur in der Nähe des letzten Treffers suchen.
  // Das verhindert Sprünge auf parallele Straßen oder auf einen anderen Teil
  // der Route, wenn GPS kurz ungenau ist.
  let searchStart = 0;
  let searchEnd = coordinates.length - 2;
  if (local && watchId !== null && Number.isFinite(lastSnapIndex)) {
    searchStart = Math.max(0, lastSnapIndex - 35);
    searchEnd = Math.min(coordinates.length - 2, lastSnapIndex + 140);
  }

  const scan = (from, to) => {
    for (let i = from; i <= to; i += 1) {
      const a = { lat: coordinates[i][1], lon: coordinates[i][0] };
      const b = { lat: coordinates[i + 1][1], lon: coordinates[i + 1][0] };
      const ax = (a.lon - position.lon) * lonScale;
      const ay = (a.lat - position.lat) * latScale;
      const bx = (b.lon - position.lon) * lonScale;
      const by = (b.lat - position.lat) * latScale;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const fraction = lengthSquared > 0
        ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared))
        : 0;
      const px = ax + fraction * dx;
      const py = ay + fraction * dy;
      const distance = Math.hypot(px, py);

      if (distance < best.distance) {
        const segmentLength = currentRoute.progress.cumulative[i + 1] - currentRoute.progress.cumulative[i];
        best = {
          index: i,
          nextIndex: i + 1,
          fraction,
          distance,
          point: {
            lat: a.lat + (b.lat - a.lat) * fraction,
            lon: a.lon + (b.lon - a.lon) * fraction
          },
          progress: currentRoute.progress.cumulative[i] + segmentLength * fraction,
          heading: bearing(a, b)
        };
      }
    }
  };

  scan(searchStart, searchEnd);
  // Wenn der lokale Treffer sehr weit weg liegt, einmal die gesamte Route prüfen.
  if (best.distance > 120 && (searchStart > 0 || searchEnd < coordinates.length - 2)) {
    best.distance = Infinity;
    scan(0, coordinates.length - 2);
  }
  return best;
}
function nearestRouteIndex(position) {
  const nearest = nearestPointOnRoute(position);
  return { index: nearest.fraction >= 0.5 ? nearest.nextIndex : nearest.index, distance: nearest.distance };
}

function getNextInstruction(progressMeters) {
  return currentRoute.instructions.find((instruction, index) => instruction.progress > progressMeters + 7 && index > 0)
    || currentRoute.instructions.at(-1);
}

function getFollowingInstruction(currentInstruction) {
  const index = currentRoute.instructions.indexOf(currentInstruction);
  if (index < 0 || index >= currentRoute.instructions.length - 1) return null;
  return currentRoute.instructions[index + 1];
}

function instructionClass(instruction) {
  const supported = new Set([
    'straight', 'keep-left', 'keep-right', 'slight-left', 'slight-right',
    'half-left', 'half-right', 'left', 'right', 'sharp-left', 'sharp-right',
    'uturn', 'roundabout', 'arrive'
  ]);
  return supported.has(instruction?.kind) ? instruction.kind : 'straight';
}

function updateManeuverIcon(instruction) {
  const icon = $('maneuverIcon');
  const kind = instructionClass(instruction);
  icon.className = `maneuver-icon ${kind}`;

  const paths = {
    straight: '<path d="M32 56V14"/><path d="M18 28L32 14l14 14"/>',
    'keep-left': '<path d="M40 56V34c0-8-3-12-11-17l-9-6"/><path d="M21 27l-1-16 16 3"/>',
    'keep-right': '<path d="M24 56V34c0-8 3-12 11-17l9-6"/><path d="M43 27l1-16-16 3"/>',
    'slight-left': '<path d="M43 56V40c0-8-3-13-10-18L20 13"/><path d="M21 29L20 13l16 2"/>',
    'slight-right': '<path d="M21 56V40c0-8 3-13 10-18l13-9"/><path d="M43 29l1-16-16 2"/>',
    'half-left': '<path d="M44 56V39c0-8-4-13-12-17L18 15"/><path d="M21 31l-3-16 16 1"/>',
    'half-right': '<path d="M20 56V39c0-8 4-13 12-17l14-7"/><path d="M43 31l3-16-16 1"/>',
    left: '<path d="M46 56V36c0-7-5-12-12-12H16"/><path d="M28 12L16 24l12 12"/>',
    right: '<path d="M18 56V36c0-7 5-12 12-12h18"/><path d="M36 12l12 12-12 12"/>',
    'sharp-left': '<path d="M48 56V34c0-9-6-15-15-15H16"/><path d="M29 7L16 19l13 12"/>',
    'sharp-right': '<path d="M16 56V34c0-9 6-15 15-15h17"/><path d="M35 7l13 12-13 12"/>',
    uturn: '<path d="M43 56V28c0-10-6-16-15-16S13 18 13 28v9"/><path d="M4 28l9 9 9-9"/>',
    roundabout: '<circle cx="32" cy="32" r="17"/><path d="M32 49v9"/><path d="M46 21l8-5"/><path d="M48 12l6 4-1 8"/>',
    arrive: '<circle cx="32" cy="30" r="15"/><circle cx="32" cy="30" r="5"/><path d="M32 45v11"/>'
  };

  icon.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">${paths[kind] || paths.straight}</svg>`;
}


function buildRouteArrowSvg(spec) {
  // Der Pfeil wird aus dem tatsächlichen Verlauf der Route rund um das
  // Manöver aufgebaut. Anschließend wird dieser Ausschnitt in eine feste
  // Pixelbox skaliert. Dadurch folgt die Form exakt der Linie, bleibt beim
  // Zoomen aber immer gleich groß.
  const BOX_W = 74;
  const BOX_H = 92;
  const PAD = 10;
  const beforeMeters = 34;
  const afterMeters = 23;
  const samples = 18;
  const points = [];

  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const routeProgress = Math.max(
      0,
      Math.min(spec.totalProgress, spec.progress - beforeMeters + (beforeMeters + afterMeters) * t)
    );
    const geo = pointAtProgress(spec.coordinates, spec.cumulative, routeProgress).point;
    points.push(map.latLngToLayerPoint([geo.lat, geo.lon]));
  }

  const first = points[0];
  const local = points.map(point => ({ x: point.x - first.x, y: point.y - first.y }));
  const minX = Math.min(...local.map(point => point.x));
  const maxX = Math.max(...local.map(point => point.x));
  const minY = Math.min(...local.map(point => point.y));
  const maxY = Math.max(...local.map(point => point.y));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const scale = Math.min((BOX_W - PAD * 2) / width, (BOX_H - PAD * 2) / height);
  const offsetX = (BOX_W - width * scale) / 2;
  const offsetY = (BOX_H - height * scale) / 2;
  const fitted = local.map(point => ({
    x: offsetX + (point.x - minX) * scale,
    y: offsetY + (point.y - minY) * scale
  }));

  const path = fitted.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const tip = fitted[fitted.length - 1];
  const previous = fitted[fitted.length - 3] || fitted[fitted.length - 2];
  const angle = Math.atan2(tip.y - previous.y, tip.x - previous.x);
  const headLength = 13;
  const headSpread = 0.68;
  const left = {
    x: tip.x - Math.cos(angle - headSpread) * headLength,
    y: tip.y - Math.sin(angle - headSpread) * headLength
  };
  const right = {
    x: tip.x - Math.cos(angle + headSpread) * headLength,
    y: tip.y - Math.sin(angle + headSpread) * headLength
  };
  const head = `M${left.x.toFixed(1)} ${left.y.toFixed(1)} L${tip.x.toFixed(1)} ${tip.y.toFixed(1)} L${right.x.toFixed(1)} ${right.y.toFixed(1)}`;

  return `<svg viewBox="0 0 ${BOX_W} ${BOX_H}" aria-hidden="true"><path class="route-arrow-outline" d="${path}"/><path class="route-arrow-line" d="${path}"/><path class="route-arrow-head-outline" d="${head}"/><path class="route-arrow-head" d="${head}"/></svg>`;
}

function clearRouteTurnMarkers() {
  routeTurnMarkerSpecs = [];
  activeRouteTurnMarkerSpec = null;
  if (routeTurnMarkerLayer) routeTurnMarkerLayer.clearLayers();
}

function updateVisibleRouteTurnMarkers() {
  routeTurnMarkerRenderFrame = null;
  if (!routeTurnMarkerLayer) return;

  routeTurnMarkerLayer.clearLayers();
  const spec = activeRouteTurnMarkerSpec;
  if (!spec) return;

  // Der nächste Pfeil wird erst erzeugt, wenn sein Routenpunkt wirklich im
  // sichtbaren Kartenbereich liegt. Dadurch gibt es außerhalb des Viewports
  // keinerlei Marker oder SVG, die Leaflet bewegen oder neu zeichnen müsste.
  const visibleBounds = map.getBounds().pad(0.04);
  if (!visibleBounds.contains(spec.latlng)) return;

  const icon = L.divIcon({
    className: 'route-turn-marker',
    html: `<div class="route-maneuver-arrow">${buildRouteArrowSvg(spec)}</div>`,
    iconSize: [74, 92],
    iconAnchor: [37, 46]
  });
  L.marker(spec.latlng, {
    icon,
    interactive: false,
    keyboard: false,
    zIndexOffset: 720
  }).addTo(routeTurnMarkerLayer);
}

function setNextRouteTurnMarker(progressMeters) {
  if (!routeTurnMarkerSpecs.length) {
    activeRouteTurnMarkerSpec = null;
    activeRouteTurnMarkerSpec = null;
    scheduleVisibleRouteTurnMarkers();
    return;
  }

  // Nur das unmittelbar nächste noch nicht gefahrene Manöver anzeigen.
  // Ein kleiner Puffer verhindert, dass der Pfeil direkt auf der Kreuzung
  // hektisch zwischen zwei Manövern wechselt.
  const next = routeTurnMarkerSpecs.find(spec => spec.progress > progressMeters + 6) || null;
  if (activeRouteTurnMarkerSpec !== next) {
    activeRouteTurnMarkerSpec = next;
    scheduleVisibleRouteTurnMarkers();
  }
}

function scheduleVisibleRouteTurnMarkers() {
  if (routeTurnMarkerRenderFrame) return;
  routeTurnMarkerRenderFrame = requestAnimationFrame(updateVisibleRouteTurnMarkers);
}

map.on('move zoom resize rotate', scheduleVisibleRouteTurnMarkers);

function drawRoute(feature) {
  clearRouteTurnMarkers();
  const group = L.layerGroup().addTo(map);
  L.geoJSON(feature, {
    style: { color: '#ffffff', weight: 13, opacity: 0.94, lineCap: 'round', lineJoin: 'round' }
  }).addTo(group);
  L.geoJSON(feature, {
    style: { color: '#078ee8', weight: 8, opacity: 1, lineCap: 'round', lineJoin: 'round' }
  }).addTo(group);

  routeTurnMarkerLayer = L.layerGroup().addTo(group);
  const coordinates = feature.geometry?.coordinates || [];
  if (coordinates.length > 1) {
    const progress = buildRouteProgress(coordinates);
    const maneuvers = currentRoute?.instructions || buildInstructions(coordinates);

    routeTurnMarkerSpecs = maneuvers
      .map((instruction, instructionIndex) => ({ instruction, instructionIndex }))
      .filter(({ instruction }) => instruction && instruction.kind !== 'straight' && instruction.kind !== 'arrive' && instruction.progress >= 18)
      .map(({ instruction, instructionIndex }) => {
        // Der Pfeil liegt kurz vor der Kreuzung auf der eingehenden Route.
        // So ist er nicht nur ein Symbol auf dem Kreuzungspunkt, sondern zeigt
        // genau auf der Fahrspur, was als Nächstes passiert.
        const leadDistance = Math.min(38, Math.max(20, instruction.progress * 0.08));
        const markerProgress = Math.max(4, instruction.progress - leadDistance);
        const center = pointAtProgress(coordinates, progress.cumulative, instruction.progress).point;
        return {
          latlng: L.latLng(center.lat, center.lon),
          kind: instructionClass(instruction),
          progress: instruction.progress,
          totalProgress: progress.total,
          cumulative: progress.cumulative,
          coordinates,
          instructionIndex
        };
      });

    scheduleVisibleRouteTurnMarkers();
  }
  group.getBounds = () => L.geoJSON(feature).getBounds();
  return group;
}

function shortestAngleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

function setNavigationBearing(routeHeading, immediate = false) {
  if (typeof map.setBearing !== 'function' || !Number.isFinite(routeHeading)) return;
  const target = (360 - routeHeading) % 360;
  const delta = shortestAngleDelta(currentMapBearing, target);
  currentMapBearing = immediate ? target : (currentMapBearing + delta * 0.28 + 360) % 360;
  map.setBearing(currentMapBearing);
}

function formatArrival(milliseconds) {
  const date = new Date(Date.now() + milliseconds);
  return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function createPositionIcon(heading) {
  return L.divIcon({
    className: 'position-marker-wrapper',
    html: `<div class="position-arrow" style="transform:rotate(${Math.round(heading)}deg)"><span></span></div>`,
    iconSize: [46, 46],
    iconAnchor: [23, 23]
  });
}

function estimateMopedTravelTime(distanceMetersValue, mode, waypointCount = 0) {
  const distanceKm = Math.max(0, distanceMetersValue / 1000);
  // Realistische Durchschnittswerte für ein 45-km/h-Fahrzeug inklusive
  // Ortschaften, Ampeln, Abbiegen und kurzen Verzögerungen.
  const averageKmh = mode === 'safe' ? 33 : mode === 'strict50' ? 30 : 38;
  const movingMinutes = distanceKm / averageKmh * 60;
  const junctionDelay = Math.min(12, 2 + distanceKm * 0.10);
  const stopDelay = waypointCount * 1.5;
  return Math.max(60_000, (movingMinutes + junctionDelay + stopDelay) * 60_000);
}

function polylineLength(coordinates) {
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    total += distanceMeters({ lat: coordinates[i - 1][1], lon: coordinates[i - 1][0] }, { lat: coordinates[i][1], lon: coordinates[i][0] });
  }
  return total;
}

function bearing(a, b) {
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dl = (b.lon - a.lon) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function normalizeTurn(value) {
  return ((value + 540) % 360) - 180;
}

function pointAtProgress(coordinates, cumulative, target) {
  const clamped = Math.max(0, Math.min(cumulative.at(-1) || 0, target));
  let hi = cumulative.findIndex(value => value >= clamped);
  if (hi <= 0) return { point: { lat: coordinates[0][1], lon: coordinates[0][0] }, index: 0 };
  if (hi < 0) hi = cumulative.length - 1;
  const lo = hi - 1;
  const span = Math.max(0.001, cumulative[hi] - cumulative[lo]);
  const f = (clamped - cumulative[lo]) / span;
  return {
    point: {
      lat: coordinates[lo][1] + (coordinates[hi][1] - coordinates[lo][1]) * f,
      lon: coordinates[lo][0] + (coordinates[hi][0] - coordinates[lo][0]) * f
    },
    index: f < 0.5 ? lo : hi
  };
}

function maneuverDefinition(kind, extra = {}) {
  const exit = extra.exitNumber || 1;
  const defs = {
    straight: { kind: 'straight', text: 'Geradeaus weiterfahren', spoken: 'geradeaus weiterfahren' },
    'keep-left': { kind: 'keep-left', text: 'Links halten', spoken: 'links halten' },
    'keep-right': { kind: 'keep-right', text: 'Rechts halten', spoken: 'rechts halten' },
    'slight-left': { kind: 'slight-left', text: 'Leicht links abbiegen', spoken: 'leicht links abbiegen' },
    'slight-right': { kind: 'slight-right', text: 'Leicht rechts abbiegen', spoken: 'leicht rechts abbiegen' },
    'half-left': { kind: 'half-left', text: 'Halb links abbiegen', spoken: 'halb links abbiegen' },
    'half-right': { kind: 'half-right', text: 'Halb rechts abbiegen', spoken: 'halb rechts abbiegen' },
    left: { kind: 'left', text: 'Links abbiegen', spoken: 'links abbiegen' },
    right: { kind: 'right', text: 'Rechts abbiegen', spoken: 'rechts abbiegen' },
    'sharp-left': { kind: 'sharp-left', text: 'Scharf links abbiegen', spoken: 'scharf links abbiegen' },
    'sharp-right': { kind: 'sharp-right', text: 'Scharf rechts abbiegen', spoken: 'scharf rechts abbiegen' },
    uturn: { kind: 'uturn', text: 'Bitte wenden', spoken: 'bitte wenden' },
    roundabout: { kind: 'roundabout', text: `Im Kreisverkehr die ${exit}. Ausfahrt nehmen`, spoken: `im Kreisverkehr die ${exit}. Ausfahrt nehmen` },
    arrive: { kind: 'arrive', text: 'Du hast dein Ziel erreicht', spoken: 'Du hast dein Ziel erreicht' }
  };
  return { ...(defs[kind] || defs.straight), ...extra };
}

function classifyTurn(angle) {
  const absolute = Math.abs(angle);
  const right = angle > 0;
  if (absolute >= 158) return maneuverDefinition('uturn');
  if (absolute >= 118) return maneuverDefinition(right ? 'sharp-right' : 'sharp-left');
  if (absolute >= 78) return maneuverDefinition(right ? 'right' : 'left');
  if (absolute >= 48) return maneuverDefinition(right ? 'half-right' : 'half-left');
  if (absolute >= 28) return maneuverDefinition(right ? 'slight-right' : 'slight-left');
  return maneuverDefinition(right ? 'keep-right' : 'keep-left');
}

function buildInstructions(coordinates) {
  const routeProgressData = buildRouteProgress(coordinates);
  const cumulative = routeProgressData.cumulative;
  const total = routeProgressData.total;
  const candidates = [];

  // Distanzbasierte Erkennung statt fester Punktabstände. So gehen auch kurze
  // Abzweigungen in sehr detaillierten oder sehr groben OSM-Linien nicht verloren.
  for (let progress = 18; progress < total - 18; progress += 7) {
    const nearWindow = Math.min(26, Math.max(14, total / 400));
    const before = pointAtProgress(coordinates, cumulative, progress - nearWindow).point;
    const centerResult = pointAtProgress(coordinates, cumulative, progress);
    const after = pointAtProgress(coordinates, cumulative, progress + nearWindow).point;
    const angle = normalizeTurn(bearing(before, centerResult.point) - bearing(centerResult.point, after)) * -1;
    if (Math.abs(angle) < 14) continue;
    candidates.push({
      index: centerResult.index,
      point: coordinates[centerResult.index],
      progress,
      angle,
      strength: Math.abs(angle)
    });
  }

  // Mehrere Messpunkte derselben Kurve zu genau einem Manöver bündeln.
  const clusters = [];
  for (const candidate of candidates) {
    const previous = clusters.at(-1);
    if (previous && candidate.progress - previous.endProgress <= 34) {
      previous.items.push(candidate);
      previous.endProgress = candidate.progress;
    } else {
      clusters.push({ items: [candidate], endProgress: candidate.progress });
    }
  }

  const instructions = [{
    index: 0, point: coordinates[0], progress: 0, angle: 0,
    ...maneuverDefinition('straight')
  }];

  for (const cluster of clusters) {
    const strongest = cluster.items.reduce((best, item) => item.strength > best.strength ? item : best);
    const firstProgress = cluster.items[0].progress;
    const lastProgress = cluster.items.at(-1).progress;
    const clusterLength = lastProgress - firstProgress;

    // Lange, gleichmäßige Straßenkurven nicht als Abbiegen melden. Kurze
    // Richtungswechsel und starke Winkel bleiben erhalten.
    if (clusterLength > 105 && strongest.strength < 58) continue;
    const previous = instructions.at(-1);
    if (previous && strongest.progress - previous.progress < 12 && strongest.strength < 62) continue;

    const classified = classifyTurn(strongest.angle);
    instructions.push({ ...strongest, ...classified });
  }

  instructions.push({
    index: coordinates.length - 1, point: coordinates.at(-1), progress: total,
    angle: 0, ...maneuverDefinition('arrive')
  });
  return instructions;
}


function sampleRoutePointsByDistance(coordinates, progressData, spacing = 420, maxSamples = 220) {
  const samples = [];
  const total = progressData.total;
  spacing = Math.max(spacing, total / Math.max(1, maxSamples - 1));
  for (let p = 0; p <= total && samples.length < maxSamples; p += spacing) {
    const result = pointAtProgress(coordinates, progressData.cumulative, p).point;
    samples.push([result.lon, result.lat]);
  }
  const last = coordinates.at(-1);
  if (!samples.length || distanceMeters({ lat: samples.at(-1)[1], lon: samples.at(-1)[0] }, { lat: last[1], lon: last[0] }) > 30) {
    samples.push(last);
  }
  return samples;
}

async function fetchRoundaboutChunk(samples) {
  const aroundQueries = samples.map(([lon, lat]) => `way(around:150,${lat.toFixed(6)},${lon.toFixed(6)})["junction"~"roundabout|circular"]`).join(';');
  const query = `[out:json][timeout:28];(${aroundQueries};)->.r;node(w.r)->.rn;way(bn.rn)[highway];(.r;.connected;);out body geom;`;
  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: `data=${encodeURIComponent(query)}`
  });
  if (!response.ok) throw new Error('Overpass nicht erreichbar');
  return response.json();
}

async function fetchRoundaboutData(coordinates, progressData) {
  const samples = sampleRoutePointsByDistance(coordinates, progressData);
  const elements = new Map();
  // Kleine Abfragen sind bei Overpass wesentlich zuverlässiger als eine einzige
  // riesige Anfrage für die komplette Route.
  const chunks = [];
  for (let i = 0; i < samples.length; i += 24) chunks.push(samples.slice(i, i + 24));
  for (let i = 0; i < chunks.length; i += 3) {
    const results = await Promise.all(chunks.slice(i, i + 3).map(fetchRoundaboutChunk));
    for (const data of results) {
      for (const element of data.elements || []) {
        if (element.type === 'way' && Array.isArray(element.geometry)) {
          elements.set(`${element.type}:${element.id}`, element);
        }
      }
    }
  }
  const ways = [...elements.values()];
  return {
    roundaboutWays: ways.filter(way => /roundabout|circular/.test(way.tags?.junction || '')),
    connectedWays: ways.filter(way => !/roundabout|circular/.test(way.tags?.junction || ''))
  };
}

function pointToSegmentDistance(point, a, b) {
  const latScale = 111320;
  const lonScale = Math.max(1, 111320 * Math.cos(point.lat * Math.PI / 180));
  const ax = (a.lon - point.lon) * lonScale;
  const ay = (a.lat - point.lat) * latScale;
  const bx = (b.lon - point.lon) * lonScale;
  const by = (b.lat - point.lat) * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function distanceToWay(point, way) {
  let best = Infinity;
  const geometry = way.geometry || [];
  for (let i = 0; i < geometry.length - 1; i += 1) {
    best = Math.min(best, pointToSegmentDistance(point,
      { lat: geometry[i].lat, lon: geometry[i].lon },
      { lat: geometry[i + 1].lat, lon: geometry[i + 1].lon }));
  }
  return best;
}

function roundaboutRouteSpan(coordinates, ways) {
  const hits = [];
  for (let i = 0; i < coordinates.length; i += 1) {
    const routePoint = { lat: coordinates[i][1], lon: coordinates[i][0] };
    const min = Math.min(...ways.map(way => distanceToWay(routePoint, way)));
    if (min <= 24) hits.push(i);
  }
  if (hits.length < 2) return null;
  const start = hits[0];
  const end = hits.at(-1);
  if (end <= start) return null;
  return { start, end };
}

function groupRoundaboutWays(ways) {
  const groups = [];
  for (const way of ways) {
    let group = groups.find(candidate => candidate.some(other => {
      const a = way.geometry || [];
      const b = other.geometry || [];
      return a.some(pa => b.some(pb => distanceMeters({ lat: pa.lat, lon: pa.lon }, { lat: pb.lat, lon: pb.lon }) < 9));
    }));
    if (!group) {
      group = [];
      groups.push(group);
    }
    group.push(way);
  }
  return groups;
}

function validRoundaboutBranch(road) {
  const highway = road.tags?.highway;
  return highway && !['service', 'track', 'path', 'footway', 'cycleway', 'pedestrian', 'steps', 'construction'].includes(highway)
    && road.tags?.access !== 'no' && road.tags?.motor_vehicle !== 'no';
}

function countRoundaboutExit(ways, connectedWays, span, coordinates, progressData) {
  const startProgress = progressData.cumulative[span.start] || 0;
  const endProgress = progressData.cumulative[span.end] || startProgress;
  const branchProgresses = [];

  for (const road of connectedWays) {
    if (!validRoundaboutBranch(road)) continue;
    let best = { distance: Infinity, progress: 0 };
    for (let i = span.start; i <= span.end; i += 1) {
      const point = { lat: coordinates[i][1], lon: coordinates[i][0] };
      const distance = distanceToWay(point, road);
      if (distance < best.distance) best = { distance, progress: progressData.cumulative[i] || 0 };
    }
    if (best.distance > 11) continue;
    // Ein Weg muss vom Kreisverkehr wegführen, sonst ist er nur ein Teil der Ringgeometrie.
    const extendsOutside = (road.geometry || []).some(point =>
      Math.min(...ways.map(way => distanceToWay({ lat: point.lat, lon: point.lon }, way))) > 22
    );
    if (!extendsOutside) continue;
    // Einfahrt nicht als Ausfahrt mitzählen. Die gewählte Ausfahrt am Ende zählt.
    if (best.progress <= startProgress + 9 || best.progress > endProgress + 18) continue;
    if (!branchProgresses.some(value => Math.abs(value - best.progress) < 14)) branchProgresses.push(best.progress);
  }
  branchProgresses.sort((a, b) => a - b);
  return Math.max(1, branchProgresses.length);
}

function detectRoundaboutsFromGeometry(coordinates, progressData) {
  const candidates = [];
  for (let p = 25; p < progressData.total - 25; p += 8) {
    const before = pointAtProgress(coordinates, progressData.cumulative, p - 22).point;
    const center = pointAtProgress(coordinates, progressData.cumulative, p).point;
    const after = pointAtProgress(coordinates, progressData.cumulative, p + 22).point;
    const turn = Math.abs(normalizeTurn(bearing(before, center) - bearing(center, after)));
    if (turn > 24) candidates.push(p);
  }
  const clusters = [];
  for (const p of candidates) {
    const last = clusters.at(-1);
    if (last && p - last.at(-1) < 22) last.push(p); else clusters.push([p]);
  }
  return clusters.filter(cluster => cluster.length >= 4).map(cluster => ({
    progress: cluster[0],
    startProgress: Math.max(0, cluster[0] - 12),
    endProgress: Math.min(progressData.total, cluster.at(-1) + 12),
    exitNumber: null,
    fallback: true
  }));
}

async function enrichInstructionsWithRoundabouts(coordinates, progressData, instructions) {
  let detected = [];
  try {
    const { roundaboutWays, connectedWays } = await fetchRoundaboutData(coordinates, progressData);
    for (const group of groupRoundaboutWays(roundaboutWays)) {
      const span = roundaboutRouteSpan(coordinates, group);
      if (!span) continue;
      const startProgress = progressData.cumulative[span.start] || 0;
      const endProgress = progressData.cumulative[span.end] || startProgress;
      detected.push({
        span,
        progress: startProgress,
        startProgress,
        endProgress,
        exitNumber: countRoundaboutExit(group, connectedWays, span, coordinates, progressData)
      });
    }
  } catch (error) {
    console.warn('Overpass-Kreisverkehrserkennung fehlgeschlagen:', error);
  }

  // Geometrische Reserveerkennung: Sie liefert bei Overpass-Ausfällen zumindest
  // einen Kreisverkehrshinweis, erfindet aber bewusst keine Ausfahrtnummer.
  for (const fallback of detectRoundaboutsFromGeometry(coordinates, progressData)) {
    if (!detected.some(item => Math.abs(item.progress - fallback.progress) < 70)) detected.push(fallback);
  }
  if (!detected.length) return instructions;

  let result = instructions.filter(instruction => !detected.some(roundabout =>
    instruction.progress >= roundabout.startProgress - 22
    && instruction.progress <= roundabout.endProgress + 24
    && instruction.kind !== 'arrive'
  ));

  for (const roundabout of detected) {
    const location = pointAtProgress(coordinates, progressData.cumulative, roundabout.progress);
    const definition = roundabout.exitNumber
      ? maneuverDefinition('roundabout', { exitNumber: roundabout.exitNumber })
      : { kind: 'roundabout', text: 'Im Kreisverkehr der Route folgen', spoken: 'im Kreisverkehr der Route folgen', exitNumber: null };
    result.push({
      index: location.index,
      point: coordinates[location.index],
      progress: roundabout.progress,
      angle: 0,
      ...definition
    });
  }
  return result.sort((a, b) => a.progress - b.progress);
}

function saveRecentDestination(point) {
  if (!point) return;
  const stored = JSON.parse(localStorage.getItem('moped-recent-destinations') || '[]');
  const next = [point, ...stored.filter(item => Math.abs(item.lat - point.lat) > 0.00001 || Math.abs(item.lon - point.lon) > 0.00001)].slice(0, 5);
  localStorage.setItem('moped-recent-destinations', JSON.stringify(next));
  renderRecentDestinations();
}

function renderRecentDestinations() {
  const recent = JSON.parse(localStorage.getItem('moped-recent-destinations') || '[]');
  const section = $('recentDestinations');
  const container = $('recentDestinationButtons');
  container.innerHTML = '';
  section.classList.toggle('hidden', recent.length === 0);
  recent.forEach(point => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = point.label || 'Gespeichertes Ziel';
    button.addEventListener('click', () => {
      destinationPoint = point;
      $('destinationInput').value = point.label || '';
    });
    container.appendChild(button);
  });
}
renderRecentDestinations();

function clearStopMarkers() {
  stopMarkers.forEach(marker => map.removeLayer(marker));
  stopMarkers = [];
}

function drawStopMarkers(points) {
  clearStopMarkers();
  points.forEach((point, index) => {
    const icon = L.divIcon({ className: '', html: `<div class="stop-marker">${index + 1}</div>`, iconSize:[28,28], iconAnchor:[14,14] });
    stopMarkers.push(L.marker([point.lat, point.lon], { icon, interactive:false, zIndexOffset:700 }).addTo(map));
  });
}

function showRouteOverview() {
  navigationOverview = true;
  navigationFollowing = false;
  document.body.classList.add('overview-mode');
  if (routeLayer) {
    if (typeof map.setBearing === 'function') map.setBearing(0);
    currentMapBearing = 0;
    map.fitBounds(routeLayer.getBounds(), { paddingTopLeft:[40,40], paddingBottomRight:[40,40], animate:false });
  }
}

$('overviewBtn').addEventListener('click', showRouteOverview);
$('overviewNavBtn').addEventListener('click', showRouteOverview);
function updateVoiceButton() {
  const muteLabel = $('muteBtn').querySelector('.action-label');
  if (muteLabel) muteLabel.textContent = voiceMuted ? 'Ton aus' : 'Ton an';
  $('muteBtn').classList.toggle('muted', voiceMuted);
  $('voiceEnabled').checked = !voiceMuted;
}

$('muteBtn').addEventListener('click', () => {
  voiceMuted = !voiceMuted;
  localStorage.setItem('mopedVoiceMuted', voiceMuted ? '1' : '0');
  updateVoiceButton();
  if (voiceMuted && 'speechSynthesis' in window) speechSynthesis.cancel();
  if (!voiceMuted) speak('Sprachausgabe aktiviert.');
});

voiceMuted = localStorage.getItem('mopedVoiceMuted') === '1';
updateVoiceButton();

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  const select = $('voiceSelect');
  const voices = speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith('de'));
  select.innerHTML = '<option value="">Automatisch</option>';
  voices.forEach(voice => {
    const option = document.createElement('option');
    option.value = voice.name;
    option.textContent = `${voice.name} (${voice.lang})`;
    option.selected = voice.name === selectedVoiceName;
    select.appendChild(option);
  });
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}
$('voiceVolume').value = String(voiceVolume);
$('voiceRate').value = String(voiceRate);
$('voiceSettingsBtn').addEventListener('click', () => $('voiceDialog').classList.remove('hidden'));
$('closeVoiceBtn').addEventListener('click', () => $('voiceDialog').classList.add('hidden'));
$('voiceDialog').addEventListener('click', event => { if (event.target === $('voiceDialog')) $('voiceDialog').classList.add('hidden'); });
$('voiceEnabled').addEventListener('change', event => {
  voiceMuted = !event.target.checked;
  localStorage.setItem('mopedVoiceMuted', voiceMuted ? '1' : '0');
  updateVoiceButton();
  if (voiceMuted && 'speechSynthesis' in window) speechSynthesis.cancel();
});
$('voiceSelect').addEventListener('change', event => {
  selectedVoiceName = event.target.value;
  localStorage.setItem('mopedVoiceName', selectedVoiceName);
});
$('voiceVolume').addEventListener('input', event => {
  voiceVolume = Number(event.target.value);
  localStorage.setItem('mopedVoiceVolume', String(voiceVolume));
});
$('voiceRate').addEventListener('input', event => {
  voiceRate = Number(event.target.value);
  localStorage.setItem('mopedVoiceRate', String(voiceRate));
});
$('testVoiceBtn').addEventListener('click', () => speak('Sprachausgabe ist aktiviert. In 200 Metern rechts abbiegen.'));
async function calculateRoute() {
  const routeButton = $('routeBtn');
  routeButton.disabled = true;
  routeButton.textContent = 'Berechnung läuft...';
  try {
    if (!startPoint) startPoint = $('startInput').value.trim() ? await resolveInput('startInput', null) : await getLocation();
    destinationPoint = await resolveInput('destinationInput', destinationPoint);
    if (!startPoint || !destinationPoint) throw new Error('Start und Ziel fehlen.');
    const resolvedWaypoints = await resolveWaypoints();
    currentRoute = await requestRoute(startPoint, destinationPoint, currentMode, resolvedWaypoints);
    drawStopMarkers(resolvedWaypoints);
    saveRecentDestination(destinationPoint);
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = drawRoute(currentRoute.feature);
    if (typeof map.setBearing === 'function') map.setBearing(0);
    currentMapBearing = 0;
    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
    $('duration').textContent = formatDuration(currentRoute.time);
    $('distance').textContent = formatDistance(currentRoute.distance);
    $('routeSummary').classList.remove('hidden');
    showStatus(currentMode === 'strict50' ? 'Route berechnet. Straßen über 50 km/h werden soweit möglich vermieden.' : 'Route berechnet. Die Fahrzeit ist auf ein 45-km/h-Fahrzeug angepasst.');
  } catch (error) {
    showStatus(error.message, 6500);
  } finally {
    routeButton.disabled = false;
    routeButton.textContent = 'Route berechnen';
  }
}
$('routeBtn').addEventListener('click', calculateRoute);

function formatDistance(meters) {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}
function formatDuration(milliseconds) {
  const minutes = Math.max(1, Math.round(milliseconds / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
function speak(text, { interrupt = true } = {}) {
  if (voiceMuted || !('speechSynthesis' in window) || !text) return;
  if (interrupt) speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'de-DE';
  utterance.rate = voiceRate;
  utterance.volume = voiceVolume;
  const voices = speechSynthesis.getVoices();
  const chosen = voices.find(voice => voice.name === selectedVoiceName)
    || voices.find(voice => voice.lang.toLowerCase().startsWith('de'));
  if (chosen) utterance.voice = chosen;
  speechSynthesis.speak(utterance);
}

function spokenManeuverText(instruction) {
  if (!instruction) return 'der Route folgen';
  return instruction.spoken || maneuverDefinition(instruction.kind, instruction).spoken || 'geradeaus weiterfahren';
}


function announceInstruction(instruction, instructionIndex, distance) {
  if (!instruction || voiceMuted) return;
  if (instruction.kind === 'arrive') {
    if (distance < 35 && !arrivalAnnounced) {
      speak('Du hast dein Ziel erreicht.');
      arrivalAnnounced = true;
    }
    return;
  }

  // Feste, nachvollziehbare Ansagepunkte. Eine Stufe wird nur beim echten
  // Unterschreiten angesagt, damit es keine doppelten oder hektischen Ansagen gibt.
  const stages = [
    { threshold: 5000, key: '5000', text: () => `In 5 Kilometern ${spokenManeuverText(instruction)}.` },
    { threshold: 1000, key: '1000', text: () => `In einem Kilometer ${spokenManeuverText(instruction)}.` },
    { threshold: 500, key: '500', text: () => `In 500 Metern ${spokenManeuverText(instruction)}.` },
    { threshold: 250, key: '250', text: () => `In 250 Metern ${spokenManeuverText(instruction)}.` },
    { threshold: 100, key: '100', text: () => `In 100 Metern ${spokenManeuverText(instruction)}.` },
    { threshold: 50, key: '50', text: () => `In 50 Metern ${spokenManeuverText(instruction)}.` },
    { threshold: 10, key: '10', text: () => `In 10 Metern ${spokenManeuverText(instruction)}.` },
    { threshold: 4, key: 'now', text: () => `Jetzt ${spokenManeuverText(instruction)}.` }
  ];

  const previous = instructionDistanceHistory.get(instructionIndex);
  instructionDistanceHistory.set(instructionIndex, distance);

  // Beim ersten Erfassen eines weit entfernten Manövers nicht sofort eine
  // ungenaue Ansage auslösen. Sehr nahe Manöver werden dagegen sofort angesagt.
  if (!Number.isFinite(previous)) {
    if (distance <= 12) {
      const stage = distance <= 4 ? stages.at(-1) : stages.at(-2);
      const key = `${instructionIndex}:${stage.key}`;
      if (!spokenStages.has(key)) {
        speak(stage.text());
        spokenStages.add(key);
      }
    }
    return;
  }

  const crossed = stages.filter(stage => previous > stage.threshold && distance <= stage.threshold);
  if (!crossed.length) return;

  // Bei einem GPS-Sprung nur die räumlich passendste Stufe sprechen, die
  // übersprungenen größeren Stufen aber als erledigt markieren.
  crossed.forEach(stage => spokenStages.add(`${instructionIndex}:${stage.key}`));
  const stageToSpeak = crossed.at(-1);
  speak(stageToSpeak.text());
}

function announceNearbyWaypoint(position) {
  waypoints.forEach((item, index) => {
    if (!item.point || announcedWaypoints.has(item.id)) return;
    if (distanceMeters(position, item.point) < 55) {
      announcedWaypoints.add(item.id);
      speak(`Zwischenstopp ${index + 1} erreicht. Danach der Route weiter folgen.`);
    }
  });
}
function distanceMeters(a, b) {
  const radius = 6371000;
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dp = (b.lat - a.lat) * Math.PI / 180;
  const dl = (b.lon - a.lon) * Math.PI / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function nearestInstruction(position) {
  let best = { i: 0, d: Infinity };
  currentRoute.instructions.forEach((instruction, index) => {
    const d = distanceMeters(position, { lat: instruction.point[1], lon: instruction.point[0] });
    if (d < best.d) best = { i: index, d };
  });
  return best;
}
function distanceToRoute(position) {
  let best = Infinity;
  for (let i = 0; i < currentRoute.coordinates.length; i += 8) {
    const point = currentRoute.coordinates[i];
    best = Math.min(best, distanceMeters(position, { lat: point[1], lon: point[0] }));
  }
  return best;
}

function smoothGpsPosition(raw, accuracy = 25, speedMps = 0) {
  if (!filteredGpsPosition) {
    filteredGpsPosition = { ...raw };
    return filteredGpsPosition;
  }
  const movement = distanceMeters(filteredGpsPosition, raw);

  // Im Stand kleine GPS-Wanderungen komplett ignorieren. Das verhindert,
  // dass der Fahrzeugpfeil an Ampeln oder beim Warten hin und her springt.
  const standstillRadius = Math.max(7, Math.min(18, accuracy * 0.45));
  if (speedMps < 0.9 && movement < standstillRadius) return filteredGpsPosition;

  // Während der Fahrt weich nachführen, bei schlechtem GPS deutlich ruhiger.
  let alpha = speedMps > 8 ? 0.30 : speedMps > 3 ? 0.24 : speedMps > 1.2 ? 0.17 : 0.10;
  if (accuracy > 25) alpha *= 0.72;
  if (accuracy > 45) alpha *= 0.55;
  if (movement > 65 && accuracy < 30) alpha = Math.max(alpha, 0.42);
  filteredGpsPosition = {
    lat: filteredGpsPosition.lat + (raw.lat - filteredGpsPosition.lat) * alpha,
    lon: filteredGpsPosition.lon + (raw.lon - filteredGpsPosition.lon) * alpha
  };
  return filteredGpsPosition;
}

function interpolateAngle(from, to, factor) {
  return (from + shortestAngleDelta(from, to) * factor + 360) % 360;
}

function startNavigationAnimation() {
  if (navigationAnimationFrame) cancelAnimationFrame(navigationAnimationFrame);
  const tick = timestamp => {
    if (watchId === null) {
      navigationAnimationFrame = null;
      return;
    }
    if (targetSnappedPosition) {
      if (!displayedSnappedPosition) displayedSnappedPosition = { ...targetSnappedPosition };
      displayedSnappedPosition.lat += (targetSnappedPosition.lat - displayedSnappedPosition.lat) * 0.10;
      displayedSnappedPosition.lon += (targetSnappedPosition.lon - displayedSnappedPosition.lon) * 0.10;
      displayedRouteHeading = interpolateAngle(displayedRouteHeading, targetRouteHeading, 0.08);
      snappedPosition = displayedSnappedPosition;

      if (positionMarker) {
        positionMarker.setLatLng([displayedSnappedPosition.lat, displayedSnappedPosition.lon]);
      }
      if (navigationFollowing && timestamp - lastMapFollowFrame > 70) {
        setNavigationBearing(displayedRouteHeading);
        followSnappedPosition({ zoom: 18 });
        lastMapFollowFrame = timestamp;
      }
    }
    navigationAnimationFrame = requestAnimationFrame(tick);
  };
  navigationAnimationFrame = requestAnimationFrame(tick);
}

function followSnappedPosition({ zoom = 18 } = {}) {
  if (!navigationFollowing || !snappedPosition) return;

  map.stop();
  map.setView([snappedPosition.lat, snappedPosition.lon], zoom, { animate: false });

  const landscape = window.matchMedia('(orientation: landscape)').matches;
  if (landscape) {
    const sidebarWidth = Math.min(330, Math.max(245, window.innerWidth * 0.31));
    const desiredMarkerX = sidebarWidth + (window.innerWidth - sidebarWidth) * 0.42;
    const offsetX = Math.round(window.innerWidth / 2 - desiredMarkerX);
    map.panBy([offsetX, 0], { animate: false });
  } else {
    const desiredMarkerY = window.innerHeight * 0.62;
    const offsetY = Math.round(window.innerHeight / 2 - desiredMarkerY);
    map.panBy([0, offsetY], { animate: false });
  }
}


function remainingWaypointsForProgress(progressMeters) {
  return waypoints.filter(item => item.point).filter(item => {
    const nearest = nearestPointOnRoute(item.point);
    return nearest.progress > progressMeters + 80;
  }).map(item => item.point);
}

$('startNavigationBtn').addEventListener('click', () => {
  if (!currentRoute) return;
  $('routeSummary').classList.add('hidden');
  $('searchCard').classList.add('hidden');
  $('navigationPanel').classList.remove('hidden');
  $('navigationFooter').classList.remove('hidden');
  document.body.classList.add('navigation-active');
  navigationFollowing = true;
  navigationOverview = false;
  document.body.classList.remove('overview-mode');
  lastSpoken = -1;
  spokenStages.clear();
  instructionDistanceHistory.clear();
  announcedWaypoints.clear();
  arrivalAnnounced = false;
  lastNavigationProgress = 0;
  filteredGpsPosition = null;
  targetSnappedPosition = null;
  displayedSnappedPosition = null;
  lastSnapIndex = 0;
  lastSnapProgress = 0;
  displayedRouteHeading = 0;
  targetRouteHeading = 0;
  startNavigationAnimation();
  speak('Navigation gestartet. Folge der markierten Route.');
  map.dragging.enable();
  map.once('dragstart', () => { navigationFollowing = false; });

  watchId = navigator.geolocation.watchPosition(async position => {
    const rawPos = { lat: position.coords.latitude, lon: position.coords.longitude };
    const nowTimestamp = position.timestamp || Date.now();
    const elapsedSeconds = lastGpsTimestamp > 0 ? Math.max(0.25, Math.min(10, (nowTimestamp - lastGpsTimestamp) / 1000)) : 1;
    lastGpsTimestamp = nowTimestamp;

    let sensorSpeedMps = Number.isFinite(position.coords.speed) && position.coords.speed >= 0 ? position.coords.speed : null;
    let calculatedSpeedMps = null;
    if (lastRawGpsPosition && lastRawGpsTimestamp > 0) {
      const dt = Math.max(0.35, Math.min(8, (nowTimestamp - lastRawGpsTimestamp) / 1000));
      const moved = distanceMeters(lastRawGpsPosition, rawPos);
      if (position.coords.accuracy <= 65 && moved >= Math.max(1.2, position.coords.accuracy * 0.08)) calculatedSpeedMps = moved / dt;
    }
    lastRawGpsPosition = rawPos;
    lastRawGpsTimestamp = nowTimestamp;

    let speedMps = sensorSpeedMps;
    if (speedMps === null || (speedMps < 0.7 && calculatedSpeedMps !== null && calculatedSpeedMps > 1.1)) speedMps = calculatedSpeedMps;
    speedMps = Math.max(0, Math.min(22, speedMps || 0));
    const accuracyFactor = Math.max(0.08, Math.min(0.42, 18 / Math.max(18, position.coords.accuracy || 25)));
    const targetSpeedKmh = speedMps * 3.6;
    filteredSpeedKmh += (targetSpeedKmh - filteredSpeedKmh) * accuracyFactor;
    if (targetSpeedKmh < 1.2) filteredSpeedKmh *= 0.72;
    const speedKmh = Math.max(0, Math.round(filteredSpeedKmh));
    $('currentSpeed').textContent = String(speedKmh);
    const pos = smoothGpsPosition(rawPos, position.coords.accuracy || 25, speedMps);

    let heading = Number.isFinite(position.coords.heading) && position.coords.heading >= 0
      ? position.coords.heading
      : lastHeading;
    if ((!Number.isFinite(position.coords.heading) || position.coords.heading < 0) && lastPosition && distanceMeters(lastPosition, pos) > 2.5) {
      heading = bearing(lastPosition, pos);
    }
    lastHeading = heading || 0;
    lastPosition = pos;

    const nearest = nearestPointOnRoute(pos);
    // Fortschritt darf bei normaler GPS-Ungenauigkeit nicht rückwärts springen.
    if (nearest.progress < lastSnapProgress - 22 && nearest.distance < 80) {
      nearest.progress = lastSnapProgress;
      const held = pointAtProgress(currentRoute.coordinates, currentRoute.progress.cumulative, lastSnapProgress);
      nearest.point = held.point;
      nearest.index = held.index;
      nearest.heading = bearing(
        pointAtProgress(currentRoute.coordinates, currentRoute.progress.cumulative, Math.max(0, lastSnapProgress - 5)).point,
        pointAtProgress(currentRoute.coordinates, currentRoute.progress.cumulative, Math.min(currentRoute.progress.total, lastSnapProgress + 12)).point
      );
    }
    // Unplausibel große Vorwärtssprünge begrenzen. Bei Stillstand bleibt der
    // Pfeil nahezu fest, während er bei normaler Fahrt weiter weich vorläuft.
    const rawAdvance = nearest.progress - lastSnapProgress;
    const maxAdvance = Math.max(5, speedMps * elapsedSeconds * 2.2 + 8);
    if (lastSnapProgress > 0 && rawAdvance > maxAdvance && nearest.distance < 90) {
      nearest.progress = lastSnapProgress + maxAdvance;
      const limited = pointAtProgress(currentRoute.coordinates, currentRoute.progress.cumulative, nearest.progress);
      nearest.point = limited.point;
      nearest.index = limited.index;
    }
    if (speedMps < 0.9 && lastSnapProgress > 0 && nearest.progress - lastSnapProgress < 7) {
      nearest.progress = lastSnapProgress;
      const held = pointAtProgress(currentRoute.coordinates, currentRoute.progress.cumulative, lastSnapProgress);
      nearest.point = held.point;
      nearest.index = held.index;
    }

    lastSnapProgress = Math.max(lastSnapProgress, nearest.progress);
    lastSnapIndex = nearest.index;
    targetSnappedPosition = nearest.point;
    routeProgress = nearest.index;
    const headingBefore = pointAtProgress(currentRoute.coordinates, currentRoute.progress.cumulative, Math.max(0, nearest.progress - 12)).point;
    const headingAfter = pointAtProgress(currentRoute.coordinates, currentRoute.progress.cumulative, Math.min(currentRoute.progress.total, nearest.progress + 24)).point;
    targetRouteHeading = bearing(headingBefore, headingAfter);
    setNextRouteTurnMarker(nearest.progress);

    if (!positionMarker) {
      displayedSnappedPosition = { ...nearest.point };
      displayedRouteHeading = nearest.heading;
      positionMarker = L.marker([nearest.point.lat, nearest.point.lon], { icon: createPositionIcon(0), zIndexOffset: 1000, interactive: false }).addTo(map);
    }

    const nextInstruction = getNextInstruction(nearest.progress);
    const followingInstruction = getFollowingInstruction(nextInstruction);
    const instructionPoint = { lat: nextInstruction.point[1], lon: nextInstruction.point[0] };
    const instructionDistance = Math.max(0, nextInstruction.progress - nearest.progress);
    const remainingDistance = Math.max(0, currentRoute.progress.total - nearest.progress);
    const ratio = currentRoute.progress.total > 0 ? remainingDistance / currentRoute.progress.total : 0;
    const remainingTime = Math.max(0, currentRoute.time * ratio);

    $('currentInstruction').textContent = nextInstruction.text;
    const followingBox = $('followingInstruction');
    if (followingInstruction && nextInstruction.kind !== 'arrive') {
      const gap = Math.max(0, followingInstruction.progress - nextInstruction.progress);
      $('followingInstructionText').textContent = `${followingInstruction.text}${gap > 15 ? ` in ${formatDistance(gap)}` : ''}`;
      followingBox.classList.remove('hidden');
    } else {
      followingBox.classList.add('hidden');
    }
    $('instructionDistance').textContent = nextInstruction.kind === 'arrive'
      ? formatDistance(distanceMeters(pos, instructionPoint))
      : `In ${formatDistance(instructionDistance)}`;
    $('remainingTime').textContent = formatDuration(remainingTime);
    $('remainingDistance').textContent = formatDistance(remainingDistance);
    $('arrivalTime').textContent = formatArrival(remainingTime);
    updateManeuverIcon(nextInstruction);

    // Wurde ein Manöver zwischen zwei GPS-Messungen übersprungen, wird es
    // trotzdem einmal angesagt, statt unbemerkt aus der Liste zu verschwinden.
    currentRoute.instructions.forEach((instruction, index) => {
      if (instruction.kind === 'straight' || instruction.kind === 'arrive') return;
      if (instruction.progress > lastNavigationProgress + 4 && instruction.progress <= nearest.progress + 10) {
        const key = `${index}:now`;
        if (!spokenStages.has(key)) {
          speak(`Jetzt ${spokenManeuverText(instruction)}.`);
          spokenStages.add(key);
        }
      }
    });
    lastNavigationProgress = Math.max(lastNavigationProgress, nearest.progress);

    const instructionIndex = currentRoute.instructions.indexOf(nextInstruction);
    announceInstruction(nextInstruction, instructionIndex, instructionDistance);
    announceNearbyWaypoint(pos);

    if (nearest.distance > 90 && Date.now() - lastRecalculation > 30000) {
      lastRecalculation = Date.now();
      try {
        showStatus('Route wird neu berechnet...');
        speak('Du hast die Route verlassen. Die Route wird neu berechnet.');
        startPoint = { ...pos, label: 'Aktueller Standort' };
        const remainingStops = remainingWaypointsForProgress(nearest.progress);
        currentRoute = await requestRoute(startPoint, destinationPoint, currentMode, remainingStops);
        drawStopMarkers(remainingStops);
        if (routeLayer) map.removeLayer(routeLayer);
        routeLayer = drawRoute(currentRoute.feature);
        lastSpoken = -1;
        spokenStages.clear();
        instructionDistanceHistory.clear();
        arrivalAnnounced = false;
        lastNavigationProgress = 0;
        showStatus('Neue Route ist bereit.');
        speak('Neue Route ist bereit.');
      } catch (error) {
        showStatus(`Neuberechnung fehlgeschlagen: ${error.message}`);
      }
    }
  }, () => showStatus('GPS-Signal verloren.'), { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 });
});

$('recenterBtn').addEventListener('click', () => {
  navigationOverview = false;
  document.body.classList.remove('overview-mode');
  navigationFollowing = true;
  followSnappedPosition({ zoom: 18 });
});

map.on('dragstart', () => {
  if (watchId !== null) navigationFollowing = false;
});

function openStopDialog() {
  $('stopDialog').classList.remove('hidden');
}

function closeStopDialog() {
  $('stopDialog').classList.add('hidden');
}

function stopNavigation() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  closeStopDialog();
  $('navigationPanel').classList.add('hidden');
  $('navigationFooter').classList.add('hidden');
  document.body.classList.remove('navigation-active', 'overview-mode');
  $('searchCard').classList.remove('hidden');
  $('routeSummary').classList.remove('hidden');
  navigationFollowing = true;
  navigationOverview = false;
  lastPosition = null;
  snappedPosition = null;
  if (typeof map.setBearing === 'function') map.setBearing(0);
  currentMapBearing = 0;
  if (navigationAnimationFrame) cancelAnimationFrame(navigationAnimationFrame);
  navigationAnimationFrame = null;
  filteredGpsPosition = null;
  targetSnappedPosition = null;
  displayedSnappedPosition = null;
  lastSnapProgress = 0;
  lastSnapIndex = 0;
  lastGpsTimestamp = 0;
  filteredSpeedKmh = 0;
  lastRawGpsPosition = null;
  lastRawGpsTimestamp = 0;
  instructionDistanceHistory.clear();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (routeLayer) map.fitBounds(routeLayer.getBounds(), { padding:[40,40], animate:false });
}

$('stopNavigationBtn').addEventListener('click', openStopDialog);
$('cancelStopBtn').addEventListener('click', closeStopDialog);
$('confirmStopBtn').addEventListener('click', stopNavigation);
$('stopDialog').addEventListener('click', event => {
  if (event.target === $('stopDialog')) closeStopDialog();
});


function refreshMapLayout() {
  window.setTimeout(() => {
    map.invalidateSize({ pan: false });
    if (watchId !== null && navigationFollowing && snappedPosition) {
      followSnappedPosition({ zoom: 18 });
    }
  }, 180);
}
window.addEventListener('orientationchange', refreshMapLayout);
window.addEventListener('resize', refreshMapLayout);
