const ROUTER_URL = 'https://brouter.de/brouter';
const GEOCODER_URL = 'https://nominatim.openstreetmap.org/search';
const map = L.map('map', { zoomControl: false }).setView([51.7563, 14.3329], 12);
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

async function requestRoute(start, destination, mode) {
  const url = new URL(ROUTER_URL);
  url.searchParams.set('lonlats', `${start.lon},${start.lat}|${destination.lon},${destination.lat}`);
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
  return {
    feature,
    coordinates,
    distance: Number(properties['track-length'] || properties.distance || polylineLength(coordinates)),
    time: parseRouteTime(properties, coordinates),
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

function nearestRouteIndex(position) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  const coordinates = currentRoute.coordinates;
  for (let i = 0; i < coordinates.length; i += 1) {
    const point = coordinates[i];
    const d = distanceMeters(position, { lat: point[1], lon: point[0] });
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  }
  return { index: bestIndex, distance: bestDistance };
}

function getNextInstruction(routeIndex) {
  return currentRoute.instructions.find((instruction, index) => instruction.index > routeIndex + 2 && index > 0)
    || currentRoute.instructions.at(-1);
}

function instructionClass(instruction) {
  if (!instruction) return 'straight';
  if (instruction.kind === 'left') return 'left';
  if (instruction.kind === 'right') return 'right';
  if (instruction.kind === 'arrive') return 'arrive';
  return 'straight';
}

function updateManeuverIcon(instruction) {
  const icon = $('maneuverIcon');
  icon.className = `maneuver-icon ${instructionClass(instruction)}`;
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

function parseRouteTime(properties, coordinates) {
  const raw = Number(properties['total-time'] || properties.time || 0);
  if (raw > 100000) return raw;
  if (raw > 0) return raw * 1000;
  return (polylineLength(coordinates) / 11.1) * 1000;
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

function buildInstructions(coordinates) {
  const instructions = [{ index: 0, point: coordinates[0], text: 'Der Route folgen', kind: 'straight' }];
  let lastInstructionIndex = 0;
  for (let i = 8; i < coordinates.length - 8; i += 4) {
    const before = { lat: coordinates[i - 6][1], lon: coordinates[i - 6][0] };
    const center = { lat: coordinates[i][1], lon: coordinates[i][0] };
    const after = { lat: coordinates[i + 6][1], lon: coordinates[i + 6][0] };
    const turn = normalizeTurn(bearing(center, after) - bearing(before, center));
    if (Math.abs(turn) < 38 || i - lastInstructionIndex < 18) continue;
    const sharp = Math.abs(turn) > 105;
    const right = turn > 0;
    instructions.push({
      index: i,
      point: coordinates[i],
      text: sharp ? `${right ? 'Scharf rechts' : 'Scharf links'} abbiegen` : `${right ? 'Rechts' : 'Links'} abbiegen`,
      kind: right ? 'right' : 'left'
    });
    lastInstructionIndex = i;
  }
  instructions.push({ index: coordinates.length - 1, point: coordinates.at(-1), text: 'Du hast dein Ziel erreicht', kind: 'arrive' });
  return instructions;
}

async function calculateRoute() {
  const routeButton = $('routeBtn');
  routeButton.disabled = true;
  routeButton.textContent = 'Berechnung läuft...';
  try {
    if (!startPoint) startPoint = $('startInput').value.trim() ? await resolveInput('startInput', null) : await getLocation();
    destinationPoint = await resolveInput('destinationInput', destinationPoint);
    if (!startPoint || !destinationPoint) throw new Error('Start und Ziel fehlen.');
    currentRoute = await requestRoute(startPoint, destinationPoint, currentMode);
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.geoJSON(currentRoute.feature, { style: { weight: 7, opacity: 0.9 } }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
    $('duration').textContent = formatDuration(currentRoute.time);
    $('distance').textContent = formatDistance(currentRoute.distance);
    $('routeSummary').classList.remove('hidden');
    showStatus(currentMode === 'strict50' ? 'Die dritte Moped-Alternative wurde gewählt. Eine harte 50-km/h-Grenze kann der öffentliche Server nicht garantieren.' : 'Route berechnet.');
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
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'de-DE';
  utterance.rate = 1;
  speechSynthesis.speak(utterance);
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

$('startNavigationBtn').addEventListener('click', () => {
  if (!currentRoute) return;
  $('routeSummary').classList.add('hidden');
  $('searchCard').classList.add('hidden');
  $('navigationPanel').classList.remove('hidden');
  $('navigationFooter').classList.remove('hidden');
  document.body.classList.add('navigation-active');
  navigationFollowing = true;
  lastSpoken = -1;
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

    if (positionMarker) {
      positionMarker.setLatLng([pos.lat, pos.lon]);
      positionMarker.setIcon(createPositionIcon(lastHeading));
    } else {
      positionMarker = L.marker([pos.lat, pos.lon], { icon: createPositionIcon(lastHeading), zIndexOffset: 1000 }).addTo(map);
    }

    if (navigationFollowing) {
      map.setView([pos.lat, pos.lon], 18, { animate: true });
      if (window.matchMedia('(orientation: landscape) and (max-height: 600px)').matches) {
        map.panBy([Math.min(150, window.innerWidth * 0.13), 0], { animate: true });
      }
    }

    const nearest = nearestRouteIndex(pos);
    routeProgress = nearest.index;
    const nextInstruction = getNextInstruction(nearest.index);
    const instructionPoint = { lat: nextInstruction.point[1], lon: nextInstruction.point[0] };
    const instructionDistance = Math.max(0,
      currentRoute.progress.cumulative[nextInstruction.index] - currentRoute.progress.cumulative[nearest.index]
    );
    const remainingDistance = Math.max(0, currentRoute.progress.total - currentRoute.progress.cumulative[nearest.index]);
    const ratio = currentRoute.progress.total > 0 ? remainingDistance / currentRoute.progress.total : 0;
    const remainingTime = Math.max(0, currentRoute.time * ratio);

    $('currentInstruction').textContent = nextInstruction.text;
    $('instructionDistance').textContent = nextInstruction.kind === 'arrive'
      ? formatDistance(distanceMeters(pos, instructionPoint))
      : `In ${formatDistance(instructionDistance)}`;
    $('remainingTime').textContent = formatDuration(remainingTime);
    $('remainingDistance').textContent = formatDistance(remainingDistance);
    $('arrivalTime').textContent = formatArrival(remainingTime);
    updateManeuverIcon(nextInstruction);

    const instructionIndex = currentRoute.instructions.indexOf(nextInstruction);
    if (instructionDistance < 140 && lastSpoken !== instructionIndex) {
      const spokenDistance = Math.max(20, Math.round(instructionDistance / 10) * 10);
      speak(nextInstruction.kind === 'arrive' ? nextInstruction.text : `In ${spokenDistance} Metern ${nextInstruction.text}`);
      lastSpoken = instructionIndex;
    }

    if (nearest.distance > 90 && Date.now() - lastRecalculation > 30000) {
      lastRecalculation = Date.now();
      try {
        showStatus('Route wird neu berechnet...');
        startPoint = { ...pos, label: 'Aktueller Standort' };
        currentRoute = await requestRoute(startPoint, destinationPoint, currentMode);
        if (routeLayer) map.removeLayer(routeLayer);
        routeLayer = L.geoJSON(currentRoute.feature, { style: { weight: 8, opacity: 0.92 } }).addTo(map);
        lastSpoken = -1;
        showStatus('Neue Route ist bereit.');
      } catch (error) {
        showStatus(`Neuberechnung fehlgeschlagen: ${error.message}`);
      }
    }
  }, () => showStatus('GPS-Signal verloren.'), { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 });
});

$('recenterBtn').addEventListener('click', () => {
  navigationFollowing = true;
  if (lastPosition) map.setView([lastPosition.lat, lastPosition.lon], 18, { animate: true });
});

map.on('dragstart', () => {
  if (watchId !== null) navigationFollowing = false;
});

$('stopNavigationBtn').addEventListener('click', () => {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  $('navigationPanel').classList.add('hidden');
  $('navigationFooter').classList.add('hidden');
  document.body.classList.remove('navigation-active');
  $('searchCard').classList.remove('hidden');
  $('routeSummary').classList.remove('hidden');
  navigationFollowing = true;
  lastPosition = null;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
});


function refreshMapLayout() {
  window.setTimeout(() => {
    map.invalidateSize({ pan: false });
    if (watchId !== null && navigationFollowing && lastPosition) {
      map.setView([lastPosition.lat, lastPosition.lon], 18, { animate: false });
      if (window.matchMedia('(orientation: landscape) and (max-height: 600px)').matches) {
        map.panBy([Math.min(150, window.innerWidth * 0.13), 0], { animate: false });
      }
    }
  }, 180);
}
window.addEventListener('orientationchange', refreshMapLayout);
window.addEventListener('resize', refreshMapLayout);
