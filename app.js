const $ = (id) => document.getElementById(id);
const state = { start:null, end:null, route:null, routeLayer:null, startMarker:null, endMarker:null, watchId:null };

const map = L.map('map', { zoomControl:true }).setView([51.7563,14.3329], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'© OpenStreetMap-Mitwirkende' }).addTo(map);

function setStatus(text,error=false){ $('status').textContent=text; $('status').classList.toggle('error',error); }
function formatDistance(m){ return m>=1000 ? `${(m/1000).toFixed(1)} km` : `${Math.round(m)} m`; }
function formatDuration(s){ const min=Math.round(s/60); return min>=60 ? `${Math.floor(min/60)} h ${min%60} min` : `${min} min`; }
function debounce(fn,wait=350){ let t; return (...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),wait)}; }

async function geocode(query){
  const url=`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=de&q=${encodeURIComponent(query)}`;
  const r=await fetch(url,{headers:{'Accept-Language':'de'}}); if(!r.ok) throw new Error('Ortssuche fehlgeschlagen'); return r.json();
}
function wireSearch(inputId,resultId,key){
  const input=$(inputId), box=$(resultId);
  input.addEventListener('input',debounce(async()=>{
    box.innerHTML=''; if(input.value.trim().length<3)return;
    try{ const items=await geocode(input.value.trim()); items.forEach(item=>{
      const el=document.createElement('div'); el.className='result'; el.textContent=item.display_name;
      el.onclick=()=>{ state[key]={lat:+item.lat,lon:+item.lon,label:item.display_name}; input.value=item.display_name; box.innerHTML=''; setMarker(key); };
      box.appendChild(el);
    }); }catch(e){setStatus(e.message,true)}
  }));
}
wireSearch('startInput','startResults','start'); wireSearch('endInput','endResults','end');

function setMarker(key){
  const p=state[key]; if(!p)return; const ll=[p.lat,p.lon];
  if(key==='start'){ if(state.startMarker)map.removeLayer(state.startMarker); state.startMarker=L.marker(ll).addTo(map).bindPopup('Start'); }
  else{ if(state.endMarker)map.removeLayer(state.endMarker); state.endMarker=L.marker(ll).addTo(map).bindPopup('Ziel'); }
  if(state.start&&state.end)map.fitBounds([[state.start.lat,state.start.lon],[state.end.lat,state.end.lon]],{padding:[70,70]}); else map.setView(ll,15);
}

$('locateBtn').onclick=()=>{
  if(!navigator.geolocation)return setStatus('Standort wird von diesem Browser nicht unterstützt.',true);
  setStatus('Standort wird ermittelt ...');
  navigator.geolocation.getCurrentPosition(pos=>{
    state.start={lat:pos.coords.latitude,lon:pos.coords.longitude,label:'Aktueller Standort'}; $('startInput').value='Aktueller Standort'; setMarker('start'); setStatus('Standort übernommen.');
  },()=>setStatus('Standort konnte nicht gelesen werden. Bitte Berechtigung prüfen.',true),{enableHighAccuracy:true,timeout:12000});
};

function graphHopperModel(){
  const priority=[
    {if:'road_class == MOTORWAY',multiply_by:'0'},
    {if:'road_class == TRUNK',multiply_by:'0'},
    {if:'road_access == PRIVATE',multiply_by:'0'},
    {if:'road_access == NO',multiply_by:'0'}
  ];
  if($('preferQuiet').checked){ priority.push({if:'road_class == PRIMARY',multiply_by:'0.75'},{if:'road_class == SECONDARY',multiply_by:'0.9'}); }
  const speed=[{if:'true',limit_to:'45'}];
  return {distance_influence:45,priority,speed};
}

async function routeGraphHopper(){
  const key=localStorage.getItem('tempo45-key')||''; if(!key)throw new Error('Bitte zuerst in den Einstellungen einen GraphHopper API-Key eintragen.');
  const body={profile:'car',points:[[state.start.lon,state.start.lat],[state.end.lon,state.end.lat]],locale:'de',instructions:true,calc_points:true,points_encoded:false,'ch.disable':true,custom_model:graphHopperModel()};
  const r=await fetch(`https://graphhopper.com/api/1/route?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await r.json(); if(!r.ok||!data.paths?.[0])throw new Error(data.message||'Routing fehlgeschlagen');
  const p=data.paths[0]; return {coords:p.points.coordinates.map(([lon,lat])=>[lat,lon]),distance:p.distance,duration:p.time/1000,instructions:p.instructions||[],verified:true};
}

async function routeDemo(){
  const url=`https://router.project-osrm.org/route/v1/driving/${state.start.lon},${state.start.lat};${state.end.lon},${state.end.lat}?overview=full&geometries=geojson&steps=true`;
  const r=await fetch(url); const data=await r.json(); if(!r.ok||data.code!=='Ok')throw new Error('Demo-Routing fehlgeschlagen');
  const x=data.routes[0]; const duration=x.distance/1000/38*3600;
  return {coords:x.geometry.coordinates.map(([lon,lat])=>[lat,lon]),distance:x.distance,duration,instructions:x.legs.flatMap(l=>l.steps.map(s=>({text:s.maneuver?.instruction||s.name||'Route folgen',distance:s.distance}))),verified:false};
}

$('routeBtn').onclick=async()=>{
  if(!state.start||!state.end)return setStatus('Bitte Start und Ziel auswählen.',true);
  setStatus('Route wird berechnet ...'); $('routeBtn').disabled=true;
  try{
    const provider=localStorage.getItem('tempo45-provider')||'demo';
    state.route=provider==='demo'?await routeDemo():await routeGraphHopper();
    if(state.routeLayer)map.removeLayer(state.routeLayer);
    state.routeLayer=L.polyline(state.route.coords,{weight:7,opacity:.92}).addTo(map); map.fitBounds(state.routeLayer.getBounds(),{padding:[60,60]});
    $('duration').textContent=formatDuration(state.route.duration); $('distance').textContent=formatDistance(state.route.distance);
    $('arrival').textContent=new Date(Date.now()+state.route.duration*1000).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
    $('summary').classList.remove('hidden');
    setStatus(state.route.verified?'45-km/h-Profil angewendet. Autobahn und Trunk/Schnellstraße ausgeschlossen.':'Demo-Route berechnet. Vor der Fahrt Beschilderung prüfen: Dieser Modus kann Kraftfahrstraßen nicht sicher erkennen.',!state.route.verified);
  }catch(e){setStatus(e.message,true)}finally{$('routeBtn').disabled=false}
};

$('openNavBtn').onclick=()=>{
  if(!state.route)return; $('summary').classList.add('hidden'); $('route-card').classList.add('hidden'); $('navPanel').classList.remove('hidden');
  const first=state.route.instructions?.[0]; $('nextInstruction').textContent=first?.text||first?.street_name||'Route folgen'; $('remaining').textContent=`${formatDistance(state.route.distance)} bis zum Ziel`;
  if(navigator.geolocation)state.watchId=navigator.geolocation.watchPosition(p=>{ const ll=[p.coords.latitude,p.coords.longitude]; map.setView(ll,17); },()=>{}, {enableHighAccuracy:true});
};
$('stopNavBtn').onclick=()=>{ if(state.watchId!=null)navigator.geolocation.clearWatch(state.watchId); state.watchId=null; $('navPanel').classList.add('hidden'); $('route-card').classList.remove('hidden'); $('summary').classList.remove('hidden'); };

const dialog=$('settingsDialog');
$('settingsBtn').onclick=()=>{ $('provider').value=localStorage.getItem('tempo45-provider')||'demo'; $('apiKey').value=localStorage.getItem('tempo45-key')||''; dialog.showModal(); };
$('saveSettings').onclick=(e)=>{ e.preventDefault(); localStorage.setItem('tempo45-provider',$('provider').value); localStorage.setItem('tempo45-key',$('apiKey').value.trim()); dialog.close(); setStatus('Einstellungen gespeichert.'); };

if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js'));
