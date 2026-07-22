const $ = id => document.getElementById(id);

const state = {
  map: null,
  gps: null,
  lastGps: null,
  display: null,
  target: null,
  userMarker: null,
  route: null,
  routeLine: null,
  routeArrowGroup: null,
  watchId: null,
  navigation: false,
  currentStep: 0,
  voice: true,
  profile: 'safe',
  speedSamples: [],
  spoken: new Set(),
  animating: false,
  autocompleteTimers: new Map(),
  selected: { start: null, destination: null }
};

const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([51.756, 14.335], 13);
state.map = map;

map.createPane('routePane');
map.getPane('routePane').classList.add('leaflet-route-pane');
map.createPane('arrowPane');
map.getPane('arrowPane').classList.add('leaflet-arrow-pane');

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

const vehicleIcon = L.divIcon({
  className: '',
  iconSize: [40, 40],
  iconAnchor: [20, 20],
  html: '<div class="vehicle"><svg viewBox="0 0 48 48"><path d="M24 4 40 42 24 33 8 42 24 4Z" fill="#168eff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg></div>'
});

const hidden = (id, value) => $(id).classList.toggle('hidden', value);

const distance = (a, b) => {
  const R = 6371000;
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dp = (b.lat - a.lat) * Math.PI / 180;
  const dl = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

const fmtDistance = metres => metres >= 1000
  ? `${(metres / 1000).toFixed(metres >= 10000 ? 0 : 1).replace('.', ',')} km`
  : `${Math.max(0, Math.round(metres / 10) * 10)} m`;

const fmtTime = seconds => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.max(1, Math.round((seconds % 3600) / 60));
  return hours ? `${hours} h ${minutes} min` : `${minutes} min`;
};

const bearing = (a, b) => {
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dl = (b.lng - a.lng) * Math.PI / 180;
  return (Math.atan2(
    Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  ) * 180 / Math.PI + 360) % 360;
};

const smoothAngle = (a, b, factor = 0.16) => a + ((((b - a) + 540) % 360) - 180) * factor;
const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));

async function searchAddresses(text, limit = 6) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${limit}&accept-language=de&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, { headers: { 'Accept-Language': 'de' } });
  if (!response.ok) throw new Error('Adresssuche nicht erreichbar');
  return response.json();
}

async function geocode(text, selected) {
  if (selected && selected.label === text) return selected;
  const results = await searchAddresses(text, 1);
  if (!results.length) throw new Error(`Adresse nicht gefunden: ${text}`);
  return { lat: +results[0].lat, lng: +results[0].lon, label: results[0].display_name };
}

async function reverseGeocode(lat, lng) {
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`, {
      headers: { 'Accept-Language': 'de' }
    });
    return (await response.json()).display_name || 'Aktueller Standort';
  } catch {
    return 'Aktueller Standort';
  }
}

function setupAutocomplete(inputId, suggestionsId, key) {
  const input = $(inputId);
  const box = $(suggestionsId);
  const close = () => hidden(suggestionsId, true);

  input.addEventListener('input', () => {
    state.selected[key] = null;
    clearTimeout(state.autocompleteTimers.get(key));
    const query = input.value.trim();
    if (query.length < 3) {
      close();
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const results = await searchAddresses(query);
        if (input.value.trim() !== query) return;
        if (!results.length) {
          close();
          return;
        }

        box.innerHTML = results.map((item, index) => `
          <button type="button" class="suggestion" data-index="${index}">
            <b>⌖</b><span>${escapeHtml(item.display_name)}</span>
          </button>
        `).join('');

        box.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => {
          const item = results[Number(button.dataset.index)];
          state.selected[key] = { lat: +item.lat, lng: +item.lon, label: item.display_name };
          input.value = item.display_name;
          close();
        }));

        hidden(suggestionsId, false);
      } catch (error) {
        console.warn(error);
        close();
      }
    }, 350);

    state.autocompleteTimers.set(key, timer);
  });

  input.addEventListener('focus', () => {
    if (box.children.length) hidden(suggestionsId, false);
  });

  document.addEventListener('pointerdown', event => {
    if (!box.contains(event.target) && event.target !== input) close();
  });
}

setupAutocomplete('startInput', 'startSuggestions', 'start');
setupAutocomplete('destinationInput', 'destinationSuggestions', 'destination');

function routeUrls(a, b) {
  const path = `${a.lng},${a.lat};${b.lng},${b.lat}`;
  const query = 'overview=full&geometries=geojson&steps=true&alternatives=false&continue_straight=true';
  return [
    `https://router.project-osrm.org/route/v1/driving/${path}?${query}`,
    `https://routing.openstreetmap.de/routed-car/route/v1/driving/${path}?${query}`
  ];
}

async function fetchRoute(a, b) {
  let lastError;
  for (const url of routeUrls(a, b)) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Routing-Server ${response.status}`);
      const data = await response.json();
      if (data.code === 'Ok' && data.routes?.length) return data.routes[0];
      throw new Error(data.message || 'Keine Route gefunden');
    } catch (error) {
      lastError = error;
      console.warn('Routing-Versuch fehlgeschlagen', error);
    }
  }
  throw lastError || new Error('Keine Route gefunden');
}

function anchor(step) {
  const point = step?.maneuver?.location;
  return point ? { lat: point[1], lng: point[0] } : null;
}

function nearestCoordinateIndex(coords, pos) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  coords.forEach(([lat, lng], index) => {
    const currentDistance = (lat - pos.lat) ** 2 + (lng - pos.lng) ** 2;
    if (currentDistance < bestDistance) {
      bestIndex = index;
      bestDistance = currentDistance;
    }
  });
  return bestIndex;
}

function prepareSteps(steps, routeCoords) {
  return steps.map((step, index) => {
    const point = anchor(step);
    return {
      ...step,
      _index: index,
      _routeIndex: point ? nearestCoordinateIndex(routeCoords, point) : 0
    };
  });
}

async function calculateRoute() {
  try {
    $('calculateButton').disabled = true;
    $('calculateButton').textContent = 'Route wird berechnet…';

    const startText = $('startInput').value.trim();
    let start;
    if (startText) start = await geocode(startText, state.selected.start);
    else if (state.gps) start = { lat: state.gps.lat, lng: state.gps.lng, label: 'Aktueller Standort' };
    else throw new Error('Startadresse eingeben oder GPS verwenden');

    const targetText = $('destinationInput').value.trim();
    if (!targetText) throw new Error('Zieladresse eingeben');
    const target = await geocode(targetText, state.selected.destination);
    const route = await fetchRoute(start, target);
    const coords = route.geometry?.coordinates?.map(([lng, lat]) => [lat, lng]);

    if (!coords || coords.length < 2) {
      throw new Error('Der Routingdienst hat keine sichtbare Routenlinie geliefert');
    }

    const rawSteps = route.legs.flatMap(leg => leg.steps || []);
    state.route = {
      ...route,
      start,
      target,
      coords,
      steps: prepareSteps(rawSteps, coords)
    };
    state.currentStep = findNextInstructionIndex(0);

    if (state.routeLine) map.removeLayer(state.routeLine);
    clearRouteArrow();

    state.routeLine = L.polyline(coords, {
      pane: 'routePane',
      color: '#168eff',
      weight: 9,
      opacity: 1,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map).bringToFront();

    requestAnimationFrame(() => {
      map.invalidateSize();
      map.fitBounds(state.routeLine.getBounds(), { padding: [45, 45], animate: true });
      state.routeLine.bringToFront();
    });

    $('routeResult').innerHTML = `
      <div><small>Fahrzeit</small><strong>${fmtTime(route.duration)}</strong></div>
      <div><small>Strecke</small><strong>${fmtDistance(route.distance)}</strong></div>
      <div><small>Ankunft</small><strong>${new Date(Date.now() + route.duration * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</strong></div>
    `;

    hidden('routeResult', false);
    hidden('startButton', false);
  } catch (error) {
    console.error(error);
    alert(error.message || 'Route konnte nicht berechnet werden');
  } finally {
    $('calculateButton').disabled = false;
    $('calculateButton').textContent = 'Route berechnen';
  }
}

function maneuverType(step) {
  return String(step?.maneuver?.type || '').toLowerCase();
}

function maneuverModifier(step) {
  return String(step?.maneuver?.modifier || '').toLowerCase();
}

function isRoundaboutType(type) {
  return type.includes('roundabout') || type.includes('rotary');
}

function isRoundaboutStep(index) {
  const steps = state.route?.steps || [];
  const step = steps[index];
  if (!step) return false;

  const type = maneuverType(step);
  if (isRoundaboutType(type)) return true;

  const previousType = maneuverType(steps[index - 1]);
  const nextType = maneuverType(steps[index + 1]);

  return type.startsWith('exit ') && isRoundaboutType(previousType)
    || isRoundaboutType(previousType) && type === 'continue'
    || isRoundaboutType(nextType) && (type === 'turn' || type === 'continue');
}

function roundaboutExit(index) {
  const steps = state.route?.steps || [];
  for (let i = index; i < Math.min(steps.length, index + 3); i++) {
    const exit = Number(steps[i]?.maneuver?.exit);
    if (Number.isFinite(exit) && exit > 0) return exit;
  }
  for (let i = index - 1; i >= Math.max(0, index - 2); i--) {
    const exit = Number(steps[i]?.maneuver?.exit);
    if (Number.isFinite(exit) && exit > 0) return exit;
  }
  return null;
}

function roadAfterStep(index) {
  const steps = state.route?.steps || [];
  for (let i = index; i < Math.min(steps.length, index + 4); i++) {
    const name = String(steps[i]?.name || '').trim();
    if (name) return name;
  }
  return 'Straßenverlauf folgen';
}

function maneuver(step, index) {
  const type = maneuverType(step);
  const modifier = maneuverModifier(step);
  let icon = '↑';
  let text = 'Geradeaus weiter';

  if (isRoundaboutStep(index)) {
    const exit = roundaboutExit(index);
    icon = '⟲';
    text = exit
      ? `Im Kreisverkehr die ${exit}. Ausfahrt nehmen`
      : 'In den Kreisverkehr einfahren';
  } else if (type === 'arrive') {
    icon = '●';
    text = 'Ziel erreicht';
  } else if (type === 'uturn' || modifier === 'uturn') {
    icon = '↶';
    text = 'Wenden';
  } else if (modifier.includes('slight left')) {
    icon = '↖';
    text = 'Leicht links halten';
  } else if (modifier.includes('sharp left')) {
    icon = '↰';
    text = 'Scharf links abbiegen';
  } else if (modifier.includes('left')) {
    icon = '←';
    text = 'Links abbiegen';
  } else if (modifier.includes('slight right')) {
    icon = '↗';
    text = 'Leicht rechts halten';
  } else if (modifier.includes('sharp right')) {
    icon = '↱';
    text = 'Scharf rechts abbiegen';
  } else if (modifier.includes('right')) {
    icon = '→';
    text = 'Rechts abbiegen';
  } else if (type === 'merge') {
    icon = '↗';
    text = 'Einfädeln';
  } else if (type === 'fork') {
    icon = modifier.includes('left') ? '↖' : '↗';
    text = modifier.includes('left') ? 'Links halten' : 'Rechts halten';
  } else if (type === 'end of road') {
    icon = modifier.includes('left') ? '←' : '→';
    text = modifier.includes('left') ? 'Am Straßenende links abbiegen' : 'Am Straßenende rechts abbiegen';
  }

  return {
    icon,
    text,
    road: roadAfterStep(index),
    roundabout: isRoundaboutStep(index)
  };
}

function isInstructionStep(step) {
  const type = maneuverType(step);
  return type !== 'depart' && type !== 'notification';
}

function findNextInstructionIndex(startIndex) {
  const steps = state.route?.steps || [];
  for (let i = Math.max(0, startIndex); i < steps.length; i++) {
    if (isInstructionStep(steps[i])) return i;
  }
  return Math.max(0, steps.length - 1);
}

function nearestRouteIndex(pos) {
  return nearestCoordinateIndex(state.route.coords, pos);
}

function remainingDistance(pos) {
  const start = nearestRouteIndex(pos);
  let total = distance(pos, { lat: state.route.coords[start][0], lng: state.route.coords[start][1] });
  for (let i = start + 1; i < state.route.coords.length; i++) {
    total += distance(
      { lat: state.route.coords[i - 1][0], lng: state.route.coords[i - 1][1] },
      { lat: state.route.coords[i][0], lng: state.route.coords[i][1] }
    );
  }
  return total;
}

function clearRouteArrow() {
  if (state.routeArrowGroup) {
    map.removeLayer(state.routeArrowGroup);
    state.routeArrowGroup = null;
  }
}

function stepDisplayGeometry(step) {
  const raw = step?.geometry?.coordinates || [];
  if (raw.length < 2) return [];

  const latLngs = raw.map(([lng, lat]) => L.latLng(lat, lng));
  const screenPoints = latLngs.map(point => map.latLngToLayerPoint(point));
  const selected = [latLngs[0]];
  let travelled = 0;
  const maximumPixels = isRoundaboutStep(step._index) ? 230 : 150;

  for (let i = 1; i < screenPoints.length; i++) {
    travelled += screenPoints[i - 1].distanceTo(screenPoints[i]);
    selected.push(latLngs[i]);
    if (travelled >= maximumPixels) break;
  }

  return selected;
}

function pointAlongPolyline(latLngs, targetPixels) {
  if (latLngs.length < 2) return null;
  let remaining = targetPixels;

  for (let i = 1; i < latLngs.length; i++) {
    const a = map.latLngToLayerPoint(latLngs[i - 1]);
    const b = map.latLngToLayerPoint(latLngs[i]);
    const segmentLength = a.distanceTo(b);
    if (segmentLength === 0) continue;

    if (remaining <= segmentLength) {
      const factor = remaining / segmentLength;
      const point = L.point(
        a.x + (b.x - a.x) * factor,
        a.y + (b.y - a.y) * factor
      );
      return {
        latLng: map.layerPointToLatLng(point),
        angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 90
      };
    }

    remaining -= segmentLength;
  }

  const last = latLngs.at(-1);
  const previous = latLngs.at(-2);
  const a = map.latLngToLayerPoint(previous);
  const b = map.latLngToLayerPoint(last);
  return {
    latLng: last,
    angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 90
  };
}

function routeArrowIcon(angle) {
  return L.divIcon({
    className: '',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    html: `
      <div style="width:30px;height:30px;transform:rotate(${angle}deg);filter:drop-shadow(0 2px 4px rgba(0,0,0,.75));">
        <svg viewBox="0 0 30 30" width="30" height="30" aria-hidden="true">
          <path d="M15 3 L27 24 L15 19 L3 24 Z" fill="#ffffff" stroke="#073d75" stroke-width="3" stroke-linejoin="round"/>
        </svg>
      </div>
    `
  });
}

function drawNextArrow(step) {
  clearRouteArrow();
  if (!step) return;

  const geometry = stepDisplayGeometry(step);
  if (geometry.length < 2) return;

  const bounds = L.latLngBounds(geometry);
  if (!map.getBounds().pad(0.12).intersects(bounds)) return;

  const layers = [];
  const guide = L.polyline(geometry, {
    pane: 'arrowPane',
    color: '#ffffff',
    weight: 4,
    opacity: 0.88,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false
  });
  layers.push(guide);

  const screenLength = geometry.slice(1).reduce((sum, point, index) => {
    const previous = map.latLngToLayerPoint(geometry[index]);
    const current = map.latLngToLayerPoint(point);
    return sum + previous.distanceTo(current);
  }, 0);

  const positions = screenLength < 70
    ? [screenLength * 0.62]
    : screenLength < 130
      ? [screenLength * 0.38, screenLength * 0.76]
      : [screenLength * 0.28, screenLength * 0.56, screenLength * 0.84];

  positions.forEach(position => {
    const arrow = pointAlongPolyline(geometry, position);
    if (!arrow) return;
    layers.push(L.marker(arrow.latLng, {
      pane: 'arrowPane',
      icon: routeArrowIcon(arrow.angle),
      interactive: false,
      keyboard: false,
      zIndexOffset: 900
    }));
  });

  state.routeArrowGroup = L.layerGroup(layers).addTo(map);
}

function speak(step, dist, instruction) {
  if (!state.voice || !('speechSynthesis' in window)) return;
  const thresholds = [5000, 1000, 500, 250, 100, 50, 10];

  for (const threshold of thresholds) {
    const key = `${state.currentStep}-${threshold}`;
    if (dist <= threshold && !state.spoken.has(key)) {
      state.spoken.add(key);
      const prefix = threshold === 10 ? 'Jetzt' : `In ${fmtDistance(threshold)}`;
      const utterance = new SpeechSynthesisUtterance(
        `${prefix} ${instruction.text}${instruction.road ? ` auf ${instruction.road}` : ''}`
      );
      utterance.lang = 'de-DE';
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
      break;
    }
  }
}

function updateCurrentStep(pos) {
  const steps = state.route.steps;
  let index = state.currentStep;
  const routeIndex = nearestRouteIndex(pos);

  while (index < steps.length - 1) {
    const step = steps[index];
    const point = anchor(step);
    const dist = point ? distance(pos, point) : Infinity;
    const clearlyPassed = routeIndex > (step._routeIndex + 2);
    const directlyAtManeuver = dist < 9;

    if (!clearlyPassed && !directlyAtManeuver) break;
    index = findNextInstructionIndex(index + 1);
  }

  state.currentStep = index;
}

function updateNavigation(pos) {
  if (!state.navigation || !state.route || !pos) return;

  updateCurrentStep(pos);
  const step = state.route.steps[state.currentStep];
  if (!step) return;

  const point = anchor(step);
  const dist = point ? distance(pos, point) : 0;
  const instruction = maneuver(step, state.currentStep);

  $('instructionIcon').textContent = instruction.icon;
  $('instructionDistance').textContent = dist < 12 ? 'Jetzt' : fmtDistance(dist);
  $('instructionText').textContent = instruction.text;
  $('instructionRoad').textContent = instruction.road;

  drawNextArrow(step);

  const left = remainingDistance(pos);
  const speed = Math.max(5, state.speedSamples.at(-1) || 8);
  const seconds = left / speed;

  $('remainingDistance').textContent = fmtDistance(left);
  $('remainingTime').textContent = fmtTime(seconds);
  $('arrivalTime').textContent = new Date(Date.now() + seconds * 1000).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit'
  });

  speak(step, dist, instruction);
}

function onGps(position) {
  const coords = position.coords;
  const now = performance.now();
  const raw = {
    lat: coords.latitude,
    lng: coords.longitude,
    heading: Number.isFinite(coords.heading) ? coords.heading : null,
    speed: Number.isFinite(coords.speed) ? coords.speed : null,
    time: now
  };

  if (state.lastGps) {
    const dt = (now - state.lastGps.time) / 1000;
    const calculated = dt > 0.25 ? distance(state.lastGps, raw) / dt : null;
    const chosen = raw.speed != null && raw.speed > 0.3 ? raw.speed : calculated;
    if (Number.isFinite(chosen) && chosen < 45) {
      state.speedSamples.push(chosen);
      if (state.speedSamples.length > 8) state.speedSamples.shift();
    }
  }

  state.lastGps = raw;
  state.gps = raw;
  state.target = raw;
  if (!state.display) state.display = { ...raw, heading: raw.heading || 0 };

  $('gpsBadge').textContent = `GPS ±${Math.round(coords.accuracy)} m`;

  if (!state.userMarker) {
    state.userMarker = L.marker([raw.lat, raw.lng], {
      icon: vehicleIcon,
      zIndexOffset: 1000
    }).addTo(map);
  }

  if (!state.animating) {
    state.animating = true;
    requestAnimationFrame(animate);
  }

  if (state.navigation) updateNavigation(raw);
}

function animate() {
  if (state.display && state.target && state.userMarker) {
    state.display.lat += (state.target.lat - state.display.lat) * 0.09;
    state.display.lng += (state.target.lng - state.display.lng) * 0.09;

    const desired = state.target.heading ?? bearing(state.display, state.target);
    state.display.heading = smoothAngle(state.display.heading || 0, desired || 0);

    state.userMarker.setLatLng([state.display.lat, state.display.lng]);
    const element = state.userMarker.getElement()?.querySelector('.vehicle');
    if (element) element.style.transform = `rotate(${state.display.heading}deg)`;

    if (state.navigation) {
      const point = map.latLngToContainerPoint([state.display.lat, state.display.lng]);
      const wanted = L.point(map.getSize().x * 0.5, map.getSize().y * 0.62);
      if (point.distanceTo(wanted) > 95) {
        map.panTo([state.display.lat, state.display.lng], { animate: true, duration: 0.45 });
      }
    }
  }

  requestAnimationFrame(animate);
}

function startGps() {
  if (!navigator.geolocation) {
    $('gpsBadge').textContent = 'GPS fehlt';
    return;
  }

  state.watchId = navigator.geolocation.watchPosition(
    onGps,
    () => { $('gpsBadge').textContent = 'GPS nicht verfügbar'; },
    { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 }
  );
}

function startNavigation() {
  if (!state.route) return;
  state.navigation = true;
  state.currentStep = findNextInstructionIndex(0);
  state.spoken.clear();
  document.body.classList.add('app-nav-active');
  hidden('planner', true);
  hidden('navigationTop', false);
  hidden('speed', false);
  hidden('navBar', false);

  requestAnimationFrame(() => {
    map.invalidateSize();
    if (state.gps) map.setView([state.gps.lat, state.gps.lng], 17);
    updateNavigation(state.gps || state.route.start);
  });
}

function stopNavigation() {
  state.navigation = false;
  document.body.classList.remove('app-nav-active');
  clearRouteArrow();
  hidden('navigationTop', true);
  hidden('speed', true);
  hidden('navBar', true);
  hidden('planner', false);

  requestAnimationFrame(() => {
    map.invalidateSize();
    if (state.routeLine) map.fitBounds(state.routeLine.getBounds(), { padding: [40, 40] });
  });
}

$('calculateButton').onclick = calculateRoute;
$('startButton').onclick = startNavigation;
$('stopButton').onclick = stopNavigation;
$('quickStopButton').onclick = stopNavigation;
$('locationButton').onclick = $('recenterButton').onclick = () => state.gps && map.setView([state.gps.lat, state.gps.lng], 17);
$('overviewButton').onclick = () => state.routeLine && map.fitBounds(state.routeLine.getBounds(), { padding: [40, 40] });
$('voiceButton').onclick = () => {
  state.voice = !state.voice;
  $('voiceButton').style.opacity = state.voice ? '1' : '.45';
};
$('gpsStartButton').onclick = async () => {
  if (!state.gps) return alert('GPS ist noch nicht bereit');
  const label = await reverseGeocode(state.gps.lat, state.gps.lng);
  $('startInput').value = label;
  state.selected.start = { lat: state.gps.lat, lng: state.gps.lng, label };
};
$('menuButton').onclick = () => {
  $('planner').classList.toggle('closed');
  requestAnimationFrame(() => map.invalidateSize());
};

document.querySelectorAll('.profile').forEach(button => {
  button.onclick = () => {
    document.querySelectorAll('.profile').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    state.profile = button.dataset.profile;
  };
});

map.on('moveend zoomend', () => {
  if (state.navigation && state.route?.steps[state.currentStep]) {
    drawNextArrow(state.route.steps[state.currentStep]);
  }
});

window.addEventListener('resize', () => requestAnimationFrame(() => map.invalidateSize()));

setInterval(() => {
  const average = state.speedSamples.reduce((sum, value) => sum + value, 0) / (state.speedSamples.length || 1);
  $('speedValue').textContent = Math.round(average * 3.6);
}, 350);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.warn));
}

startGps();
