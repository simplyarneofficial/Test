const ROUTER_URL = 'https://brouter.de/brouter';
const GEOCODER_URL = 'https://nominatim.openstreetmap.org/search';
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
  return {
    feature,
    coordinates,
    distance,
    time: estimateMopedTravelTime(distance, mode, intermediatePoints.length),
    instructions: buildInstructions(coordinates),
    progress: buildRouteProgress(coordinates)
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

function nearestPointOnRoute(position) {
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

  for (let i = 0; i < coordinates.length - 1; i += 1) {
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
  if (!instruction) return 'straight';
  if (instruction.kind === 'slight-left') return 'slight-left';
  if (instruction.kind === 'slight-right') return 'slight-right';
  if (instruction.kind === 'left') return 'left';
  if (instruction.kind === 'right') return 'right';
  if (instruction.kind === 'sharp-left') return 'sharp-left';
  if (instruction.kind === 'sharp-right') return 'sharp-right';
  if (instruction.kind === 'uturn') return 'uturn';
  if (instruction.kind === 'arrive') return 'arrive';
  return 'straight';
}

function updateManeuverIcon(instruction) {
  const icon = $('maneuverIcon');
  const kind = instructionClass(instruction);
  icon.className = `maneuver-icon ${kind}`;

  const paths = {
    straight: '<path d="M32 56V14"/><path d="M18 28L32 14l14 14"/>',
    'slight-left': '<path d="M43 56V40c0-8-3-13-10-18L20 13"/><path d="M21 29L20 13l16 2"/>',
    'slight-right': '<path d="M21 56V40c0-8 3-13 10-18l13-9"/><path d="M43 29l1-16-16 2"/>',
    left: '<path d="M46 56V36c0-7-5-12-12-12H16"/><path d="M28 12L16 24l12 12"/>',
    right: '<path d="M18 56V36c0-7 5-12 12-12h18"/><path d="M36 12l12 12-12 12"/>',
    'sharp-left': '<path d="M48 56V34c0-9-6-15-15-15H16"/><path d="M29 7L16 19l13 12"/>',
    'sharp-right': '<path d="M16 56V34c0-9 6-15 15-15h17"/><path d="M35 7l13 12-13 12"/>',
    uturn: '<path d="M43 56V28c0-10-6-16-15-16S13 18 13 28v9"/><path d="M4 28l9 9 9-9"/>',
    arrive: '<circle cx="32" cy="30" r="15"/><circle cx="32" cy="30" r="5"/><path d="M32 45v11"/>'
  };

  icon.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">${paths[kind] || paths.straight}</svg>`;
}


function drawRoute(feature) {
  const group = L.layerGroup().addTo(map);
  L.geoJSON(feature, {
    style: { color: '#ffffff', weight: 12, opacity: 0.88, lineCap: 'round', lineJoin: 'round' }
  }).addTo(group);
  L.geoJSON(feature, {
    style: { color: '#1687d9', weight: 7, opacity: 1, lineCap: 'round', lineJoin: 'round' }
  }).addTo(group);
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

function classifyTurn(angle) {
  const absolute = Math.abs(angle);
  const right = angle > 0;
  if (absolute >= 155) return { kind: 'uturn', text: 'Wenden' };
  if (absolute >= 110) return { kind: right ? 'sharp-right' : 'sharp-left', text: `Scharf ${right ? 'rechts' : 'links'} abbiegen` };
  if (absolute >= 45) return { kind: right ? 'right' : 'left', text: `${right ? 'Rechts' : 'Links'} abbiegen` };
  return { kind: right ? 'slight-right' : 'slight-left', text: `Leicht ${right ? 'rechts' : 'links'} halten` };
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
    if (Math.abs(angle) < 19) continue;
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
    text: 'Der Route folgen', kind: 'straight'
  }];

  for (const cluster of clusters) {
    const strongest = cluster.items.reduce((best, item) => item.strength > best.strength ? item : best);
    const firstProgress = cluster.items[0].progress;
    const lastProgress = cluster.items.at(-1).progress;
    const clusterLength = lastProgress - firstProgress;

    // Lange, gleichmäßige Straßenkurven nicht als Abbiegen melden. Kurze
    // Richtungswechsel und starke Winkel bleiben erhalten.
    if (clusterLength > 85 && strongest.strength < 70) continue;
    const previous = instructions.at(-1);
    if (previous && strongest.progress - previous.progress < 16 && strongest.strength < 75) continue;

    const classified = classifyTurn(strongest.angle);
    instructions.push({ ...strongest, ...classified });
  }

  instructions.push({
    index: coordinates.length - 1, point: coordinates.at(-1), progress: total,
    angle: 0, text: 'Du hast dein Ziel erreicht', kind: 'arrive'
  });
  return instructions;
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
  $('muteBtn').textContent = voiceMuted ? 'Ton aus' : 'Ton an';
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
  const spoken = {
    'slight-left': 'leicht links halten',
    'slight-right': 'leicht rechts halten',
    left: 'links abbiegen',
    right: 'rechts abbiegen',
    'sharp-left': 'scharf links abbiegen',
    'sharp-right': 'scharf rechts abbiegen',
    uturn: 'wenden',
    arrive: 'Du hast dein Ziel erreicht'
  };
  return spoken[instruction.kind] || instruction.text || 'geradeaus weiterfahren';
}


function announceInstruction(instruction, instructionIndex, distance) {
  if (!instruction || voiceMuted) return;
  if (instruction.kind === 'arrive') {
    if (distance < 45 && !arrivalAnnounced) {
      speak('Du hast dein Ziel erreicht.');
      arrivalAnnounced = true;
    }
    return;
  }
  const stages = [
    { threshold: 850, key: '800', text: d => `In ${Math.max(500, Math.round(d / 100) * 100)} Metern ${spokenManeuverText(instruction)}.` },
    { threshold: 320, key: '300', text: d => `In ${Math.max(150, Math.round(d / 50) * 50)} Metern ${spokenManeuverText(instruction)}.` },
    { threshold: 95, key: 'soon', text: d => `In ${Math.max(40, Math.round(d / 10) * 10)} Metern ${spokenManeuverText(instruction)}.` },
    { threshold: 28, key: 'now', text: () => `Jetzt ${spokenManeuverText(instruction)}.` }
  ];
  for (const stage of stages) {
    const key = `${instructionIndex}:${stage.key}`;
    if (distance <= stage.threshold && !spokenStages.has(key)) {
      speak(stage.text(distance));
      spokenStages.add(key);
      break;
    }
  }
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
  announcedWaypoints.clear();
  arrivalAnnounced = false;
  lastNavigationProgress = 0;
  speak('Navigation gestartet. Folge der markierten Route.');
  map.dragging.enable();
  map.once('dragstart', () => { navigationFollowing = false; });

  watchId = navigator.geolocation.watchPosition(async position => {
    const pos = { lat: position.coords.latitude, lon: position.coords.longitude };
    const speedKmh = Math.max(0, Math.round((position.coords.speed || 0) * 3.6));
    $('currentSpeed').textContent = String(speedKmh);

    let heading = Number.isFinite(position.coords.heading) && position.coords.heading >= 0
      ? position.coords.heading
      : lastHeading;
    if ((!Number.isFinite(position.coords.heading) || position.coords.heading < 0) && lastPosition && distanceMeters(lastPosition, pos) > 3) {
      heading = bearing(lastPosition, pos);
    }
    lastHeading = heading || 0;
    lastPosition = pos;

    const nearest = nearestPointOnRoute(pos);
    snappedPosition = nearest.point;
    routeProgress = nearest.index;
    const routeHeading = nearest.heading;

    if (positionMarker) {
      positionMarker.setLatLng([snappedPosition.lat, snappedPosition.lon]);
      positionMarker.setIcon(createPositionIcon(0));
    } else {
      positionMarker = L.marker([snappedPosition.lat, snappedPosition.lon], { icon: createPositionIcon(0), zIndexOffset: 1000, interactive: false }).addTo(map);
    }

    if (navigationFollowing) {
      setNavigationBearing(routeHeading);
      followSnappedPosition({ zoom: 18 });
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
