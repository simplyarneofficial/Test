const $=id=>document.getElementById(id);
const state={map:null,gps:null,lastGps:null,display:null,target:null,userMarker:null,route:null,routeLine:null,routeArrowGroup:null,watchId:null,navigation:false,currentStep:0,voice:true,profile:'safe',speedSamples:[],spoken:new Set(),animating:false,autocompleteTimers:new Map(),selected:{start:null,destination:null},routeProgress:0,lastRouteIndex:0,lastManeuverDistance:null,lastManeuverKey:null,lastNavUpdate:0};

const map=L.map('map',{zoomControl:false,preferCanvas:true}).setView([51.756,14.335],13);state.map=map;
map.createPane('routePane');map.getPane('routePane').classList.add('leaflet-route-pane');
map.createPane('arrowPane');map.getPane('arrowPane').classList.add('leaflet-arrow-pane');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
const vehicleIcon=L.divIcon({className:'',iconSize:[40,40],iconAnchor:[20,20],html:'<div class="vehicle"><svg viewBox="0 0 48 48"><path d="M24 4 40 42 24 33 8 42 24 4Z" fill="#168eff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg></div>'});

const TurnArrowLayer=L.Layer.extend({
  initialize(points){this.points=points},
  onAdd(map){
    this._map=map;
    this._svg=L.DomUtil.create('svg','turn-arrow-svg');
    this._svg.setAttribute('aria-hidden','true');
    this._svg.style.position='absolute';
    this._svg.style.left='0';
    this._svg.style.top='0';
    this._svg.style.pointerEvents='none';
    this._svg.style.overflow='visible';
    this._defs=document.createElementNS('http://www.w3.org/2000/svg','defs');
    this._marker=document.createElementNS('http://www.w3.org/2000/svg','marker');
    const markerId=`turn-arrow-head-${L.Util.stamp(this)}`;
    this._marker.setAttribute('id',markerId);
    this._marker.setAttribute('markerWidth','7');
    this._marker.setAttribute('markerHeight','7');
    this._marker.setAttribute('refX','5.8');
    this._marker.setAttribute('refY','3.5');
    this._marker.setAttribute('orient','auto');
    this._marker.setAttribute('markerUnits','strokeWidth');
    const head=document.createElementNS('http://www.w3.org/2000/svg','path');
    head.setAttribute('d','M 0 0 L 7 3.5 L 0 7 L 1.8 3.5 Z');
    head.setAttribute('fill','#ffffff');
    head.setAttribute('stroke','#2532a6');
    head.setAttribute('stroke-width','.75');
    head.setAttribute('stroke-linejoin','round');
    this._marker.appendChild(head);
    this._defs.appendChild(this._marker);
    this._svg.appendChild(this._defs);
    this._path=document.createElementNS('http://www.w3.org/2000/svg','path');
    this._path.setAttribute('fill','none');
    this._path.setAttribute('stroke','#ffffff');
    this._path.setAttribute('stroke-width','9');
    this._path.setAttribute('stroke-linecap','round');
    this._path.setAttribute('stroke-linejoin','round');
    this._path.setAttribute('marker-end',`url(#${markerId})`);
    this._path.style.filter='drop-shadow(0 0 2px #2532a6) drop-shadow(0 2px 3px rgba(0,0,0,.35))';
    this._svg.appendChild(this._path);
    map.getPane('arrowPane').appendChild(this._svg);
    map.on('zoom viewreset move resize',this._update,this);
    this._update();
  },
  onRemove(map){
    map.off('zoom viewreset move resize',this._update,this);
    this._svg?.remove();
  },
  _update(){
    if(!this._map||!this.points?.length)return;
    const size=this._map.getSize();
    this._svg.setAttribute('width',size.x);
    this._svg.setAttribute('height',size.y);
    this._svg.setAttribute('viewBox',`0 0 ${size.x} ${size.y}`);
    const screen=this.points.map(point=>this._map.latLngToContainerPoint(point));
    if(screen.length<2)return;
    const d=screen.map((point,index)=>`${index?'L':'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
    this._path.setAttribute('d',d);
  }
});


const hidden=(id,value)=>$(id).classList.toggle('hidden',value);
const distance=(a,b)=>{const R=6371000,p1=a.lat*Math.PI/180,p2=b.lat*Math.PI/180,dp=(b.lat-a.lat)*Math.PI/180,dl=(b.lng-a.lng)*Math.PI/180;const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))};
const fmtDistance=m=>m>=1000?`${(m/1000).toFixed(m>=10000?0:1).replace('.',',')} km`:`${Math.max(0,Math.round(m/10)*10)} m`;
const fmtTime=s=>{const h=Math.floor(s/3600),m=Math.max(1,Math.round((s%3600)/60));return h?`${h} h ${m} min`:`${m} min`};
const bearing=(a,b)=>{const p1=a.lat*Math.PI/180,p2=b.lat*Math.PI/180,dl=(b.lng-a.lng)*Math.PI/180;return(Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI+360)%360};
const smoothAngle=(a,b,f=.16)=>a+((((b-a)+540)%360)-180)*f;
const escapeHtml=value=>String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));

async function searchAddresses(text,limit=6){
  const url=`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${limit}&accept-language=de&q=${encodeURIComponent(text)}`;
  const response=await fetch(url,{headers:{'Accept-Language':'de'}});
  if(!response.ok)throw new Error('Adresssuche nicht erreichbar');
  return response.json();
}
async function geocode(text,selected){
  if(selected&&selected.label===text)return selected;
  const results=await searchAddresses(text,1);
  if(!results.length)throw new Error(`Adresse nicht gefunden: ${text}`);
  return{lat:+results[0].lat,lng:+results[0].lon,label:results[0].display_name};
}
async function reverseGeocode(lat,lng){try{const r=await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`,{headers:{'Accept-Language':'de'}});return(await r.json()).display_name||'Aktueller Standort'}catch{return'Aktueller Standort'}}

function setupAutocomplete(inputId,suggestionsId,key){
  const input=$(inputId),box=$(suggestionsId);
  const close=()=>hidden(suggestionsId,true);
  input.addEventListener('input',()=>{
    state.selected[key]=null;
    clearTimeout(state.autocompleteTimers.get(key));
    const query=input.value.trim();
    if(query.length<3){close();return}
    const timer=setTimeout(async()=>{
      try{
        const results=await searchAddresses(query);
        if(input.value.trim()!==query)return;
        if(!results.length){close();return}
        box.innerHTML=results.map((item,index)=>`<button type="button" class="suggestion" data-index="${index}"><b>⌖</b><span>${escapeHtml(item.display_name)}</span></button>`).join('');
        box.querySelectorAll('.suggestion').forEach(button=>button.addEventListener('click',()=>{
          const item=results[Number(button.dataset.index)];
          state.selected[key]={lat:+item.lat,lng:+item.lon,label:item.display_name};
          input.value=item.display_name;
          close();
        }));
        hidden(suggestionsId,false);
      }catch(error){console.warn(error);close()}
    },350);
    state.autocompleteTimers.set(key,timer);
  });
  input.addEventListener('focus',()=>{if(box.children.length)hidden(suggestionsId,false)});
  document.addEventListener('pointerdown',event=>{if(!box.contains(event.target)&&event.target!==input)close()});
}
setupAutocomplete('startInput','startSuggestions','start');
setupAutocomplete('destinationInput','destinationSuggestions','destination');

function routeUrls(a,b){
  const path=`${a.lng},${a.lat};${b.lng},${b.lat}`;
  const query='overview=full&geometries=geojson&steps=true&alternatives=false&continue_straight=true';
  return[
    `https://router.project-osrm.org/route/v1/driving/${path}?${query}`,
    `https://routing.openstreetmap.de/routed-car/route/v1/driving/${path}?${query}`
  ];
}
async function fetchRoute(a,b){
  let lastError;
  for(const url of routeUrls(a,b)){
    try{
      const response=await fetch(url);
      if(!response.ok)throw new Error(`Routing-Server ${response.status}`);
      const data=await response.json();
      if(data.code==='Ok'&&data.routes?.length)return data.routes[0];
      throw new Error(data.message||'Keine Route gefunden');
    }catch(error){lastError=error;console.warn('Routing-Versuch fehlgeschlagen',error)}
  }
  throw lastError||new Error('Keine Route gefunden');
}
async function calculateRoute(){
  try{
    $('calculateButton').disabled=true;$('calculateButton').textContent='Route wird berechnet…';
    const startText=$('startInput').value.trim();
    let start;if(startText)start=await geocode(startText,state.selected.start);else if(state.gps)start={lat:state.gps.lat,lng:state.gps.lng,label:'Aktueller Standort'};else throw new Error('Startadresse eingeben oder GPS verwenden');
    const targetText=$('destinationInput').value.trim();if(!targetText)throw new Error('Zieladresse eingeben');
    const target=await geocode(targetText,state.selected.destination);
    const route=await fetchRoute(start,target);
    const coords=route.geometry?.coordinates?.map(([lng,lat])=>[lat,lng]);
    if(!coords||coords.length<2)throw new Error('Der Routingdienst hat keine sichtbare Routenlinie geliefert');
    state.route={...route,start,target,coords,steps:route.legs.flatMap(leg=>leg.steps||[])};buildRouteMetrics(state.route);state.currentStep=0;state.routeProgress=0;state.lastRouteIndex=0;state.lastManeuverDistance=null;state.lastManeuverKey=null;
    if(state.routeLine)map.removeLayer(state.routeLine);
    clearRouteArrow();
    state.routeLine=L.polyline(coords,{pane:'routePane',color:'#168eff',weight:9,opacity:1,lineCap:'round',lineJoin:'round'}).addTo(map).bringToFront();
    requestAnimationFrame(()=>{map.invalidateSize();map.fitBounds(state.routeLine.getBounds(),{padding:[45,45],animate:true});state.routeLine.bringToFront()});
    $('routeResult').innerHTML=`<div><small>Fahrzeit</small><strong>${fmtTime(route.duration)}</strong></div><div><small>Strecke</small><strong>${fmtDistance(route.distance)}</strong></div><div><small>Ankunft</small><strong>${new Date(Date.now()+route.duration*1000).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}</strong></div>`;
    hidden('routeResult',false);hidden('startButton',false);
  }catch(error){console.error(error);alert(error.message||'Route konnte nicht berechnet werden')}
  finally{$('calculateButton').disabled=false;$('calculateButton').textContent='Route berechnen'}
}

function normalizeType(step){return String(step?.maneuver?.type||'').toLowerCase()}
function normalizeModifier(step){return String(step?.maneuver?.modifier||'').toLowerCase()}
function isRoundaboutStep(step){const type=normalizeType(step);return type.includes('roundabout')||type.includes('rotary')}
function isActualManeuver(step){
  const type=normalizeType(step),mod=normalizeModifier(step);
  if(['depart','arrive','notification','new name'].includes(type))return false;
  if(isRoundaboutStep(step))return true;
  if(type==='uturn'||mod==='uturn')return true;
  if(mod.includes('left')||mod.includes('right'))return true;
  return ['turn','fork','merge','end of road'].includes(type);
}
function roundaboutExit(step,index){
  const direct=Number(step?.maneuver?.exit);
  if(Number.isFinite(direct)&&direct>0)return direct;
  for(let i=index;i<Math.min(state.route.steps.length,index+3);i++){
    const candidate=Number(state.route.steps[i]?.maneuver?.exit);
    if(Number.isFinite(candidate)&&candidate>0)return candidate;
  }
  return null;
}
function maneuver(step,index=state.currentStep){
  const type=normalizeType(step),mod=normalizeModifier(step),exit=roundaboutExit(step,index);
  let icon='↑',text='Geradeaus weiter';
  if(isRoundaboutStep(step)){icon='⟳';text=exit?`Im Kreisverkehr die ${exit}. Ausfahrt nehmen`:'In den Kreisverkehr einfahren'}
  else if(type==='uturn'||mod==='uturn'){icon='↶';text='Wenden'}
  else if(mod.includes('slight left')){icon='↖';text='Leicht links halten'}
  else if(mod.includes('sharp left')){icon='↰';text='Scharf links abbiegen'}
  else if(mod.includes('left')){icon='←';text='Links abbiegen'}
  else if(mod.includes('slight right')){icon='↗';text='Leicht rechts halten'}
  else if(mod.includes('sharp right')){icon='↱';text='Scharf rechts abbiegen'}
  else if(mod.includes('right')){icon='→';text='Rechts abbiegen'}
  return{icon,text,road:step.name||'Straßenverlauf folgen'};
}
function anchor(step){const p=step?.maneuver?.location;return p?{lat:p[1],lng:p[0]}:null}
function buildRouteMetrics(route){
  route.cumulative=[0];
  for(let i=1;i<route.coords.length;i++){
    route.cumulative[i]=route.cumulative[i-1]+distance(
      {lat:route.coords[i-1][0],lng:route.coords[i-1][1]},
      {lat:route.coords[i][0],lng:route.coords[i][1]}
    );
  }
  route.totalLength=route.cumulative.at(-1)||route.distance||0;
  let minimumIndex=0;
  route.steps.forEach((step,index)=>{
    const point=anchor(step);
    if(!point){step._routeIndex=minimumIndex;step._routeDistance=route.cumulative[minimumIndex]||0;return}
    let bestIndex=minimumIndex,bestDistance=Infinity;
    for(let i=minimumIndex;i<route.coords.length;i++){
      const d=distance(point,{lat:route.coords[i][0],lng:route.coords[i][1]});
      if(d<bestDistance){bestDistance=d;bestIndex=i}
      if(i>bestIndex+100&&bestDistance<15)break;
    }
    minimumIndex=bestIndex;
    step._routeIndex=bestIndex;
    step._routeDistance=route.cumulative[bestIndex]||0;
    step._key=`${index}:${Math.round(step._routeDistance)}`;
  });
}
function projectToRoute(pos){
  const coords=state.route.coords,cum=state.route.cumulative;
  const center=Math.max(0,Math.min(coords.length-2,state.lastRouteIndex||0));
  const from=Math.max(0,center-35),to=Math.min(coords.length-2,center+180);
  const latScale=111320,lngScale=111320*Math.cos(pos.lat*Math.PI/180);
  let best={distance:Infinity,index:center,t:0,progress:cum[center]||0,lat:coords[center][0],lng:coords[center][1]};
  for(let i=from;i<=to;i++){
    const a=coords[i],b=coords[i+1];
    const ax=(a[1]-pos.lng)*lngScale,ay=(a[0]-pos.lat)*latScale;
    const bx=(b[1]-pos.lng)*lngScale,by=(b[0]-pos.lat)*latScale;
    const vx=bx-ax,vy=by-ay,len2=vx*vx+vy*vy;
    const t=len2?Math.max(0,Math.min(1,-(ax*vx+ay*vy)/len2)):0;
    const x=ax+vx*t,y=ay+vy*t,d=Math.hypot(x,y);
    if(d<best.distance){
      const segmentLength=(cum[i+1]||cum[i])-cum[i];
      best={distance:d,index:i,t,progress:cum[i]+segmentLength*t,lat:a[0]+(b[0]-a[0])*t,lng:a[1]+(b[1]-a[1])*t};
    }
  }
  state.lastRouteIndex=best.index;
  state.routeProgress=Math.max(state.routeProgress||0,best.progress-8);
  return best;
}
function nextManeuverIndex(progress){
  for(let i=0;i<state.route.steps.length;i++){
    const step=state.route.steps[i];
    if(isActualManeuver(step)&&step._routeDistance>progress+7)return i;
  }
  return state.route.steps.length-1;
}
function remainingDistanceFromProgress(progress){return Math.max(0,(state.route.totalLength||0)-progress)}
function clearRouteArrow(){if(state.routeArrowGroup){map.removeLayer(state.routeArrowGroup);state.routeArrowGroup=null}}
function geometryAroundManeuver(stepIndex){
  const step=state.route.steps[stepIndex];
  const routeIndex=step?._routeIndex;
  if(!Number.isFinite(routeIndex))return[];
  const roundabout=isRoundaboutStep(step);
  const beforeMeters=roundabout?45:38,afterMeters=roundabout?120:65;
  let start=routeIndex,end=routeIndex;
  while(start>0&&state.route.cumulative[routeIndex]-state.route.cumulative[start]<beforeMeters)start--;
  while(end<state.route.coords.length-1&&state.route.cumulative[end]-state.route.cumulative[routeIndex]<afterMeters)end++;
  return state.route.coords.slice(start,end+1).map(([lat,lng])=>[lat,lng]);
}
function drawNextArrow(stepIndex){
  clearRouteArrow();
  const step=state.route?.steps?.[stepIndex];
  if(!step||!isActualManeuver(step))return;
  const points=geometryAroundManeuver(stepIndex);
  if(points.length<2)return;
  const bounds=L.latLngBounds(points);
  if(!map.getBounds().pad(.2).intersects(bounds))return;
  state.routeArrowGroup=new TurnArrowLayer(points).addTo(map);
}
function speechThresholds(distanceToManeuver){
  const all=[5000,2000,1000,500,250,100,50,10];
  return all.filter(value=>value<=Math.max(10,distanceToManeuver+50));
}
function markPassedSpeechThresholds(stepKey,dist){
  for(const threshold of [5000,2000,1000,500,250,100,50,10]){
    if(threshold>dist+30)state.spoken.add(`${stepKey}:${threshold}`);
  }
}
function speak(step,stepIndex,dist,ins,projection){
  if(!state.voice||!('speechSynthesis'in window)||!isActualManeuver(step))return;
  if(projection.distance>55)return;
  const key=step._key||String(stepIndex);
  if(state.lastManeuverKey!==key){
    state.lastManeuverKey=key;
    state.lastManeuverDistance=dist;
    markPassedSpeechThresholds(key,dist);
  }
  const previous=state.lastManeuverDistance;
  state.lastManeuverDistance=dist;
  if(previous!=null&&dist>previous+25)return;
  const thresholds=speechThresholds(dist);
  for(const threshold of thresholds){
    const spokenKey=`${key}:${threshold}`;
    const crossed=dist<=threshold&&(previous==null||previous>threshold-8);
    if(crossed&&!state.spoken.has(spokenKey)){
      state.spoken.add(spokenKey);
      const prefix=threshold===10?'Jetzt':`In ${fmtDistance(threshold)}`;
      const road=ins.road&&ins.road!=='Straßenverlauf folgen'?` auf ${ins.road}`:'';
      const utter=new SpeechSynthesisUtterance(`${prefix} ${ins.text}${road}`);
      utter.lang='de-DE';utter.rate=1.02;
      speechSynthesis.cancel();speechSynthesis.speak(utter);
      break;
    }
  }
}
function updateNavigation(pos){
  if(!state.navigation||!state.route||!pos)return;
  const now=performance.now();
  if(now-state.lastNavUpdate<250)return;
  state.lastNavUpdate=now;
  const projection=projectToRoute(pos);
  const progress=Math.max(state.routeProgress,projection.progress);
  const stepIndex=nextManeuverIndex(progress);
  if(stepIndex!==state.currentStep){state.currentStep=stepIndex;state.lastManeuverDistance=null;state.lastManeuverKey=null}
  const step=state.route.steps[stepIndex];
  if(!step)return;
  const dist=Math.max(0,step._routeDistance-progress);
  const ins=maneuver(step,stepIndex);
  $('instructionIcon').textContent=ins.icon;
  $('instructionDistance').textContent=dist<12?'Jetzt':fmtDistance(dist);
  $('instructionText').textContent=ins.text;
  $('instructionRoad').textContent=ins.road;
  drawNextArrow(stepIndex);
  const left=remainingDistanceFromProgress(progress);
  const measured=state.speedSamples.length?state.speedSamples.reduce((a,b)=>a+b,0)/state.speedSamples.length:0;
  const speed=Math.max(3.5,measured||8);
  const seconds=left/speed;
  $('remainingDistance').textContent=fmtDistance(left);
  $('remainingTime').textContent=fmtTime(seconds);
  $('arrivalTime').textContent=new Date(Date.now()+seconds*1000).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
  speak(step,stepIndex,dist,ins,projection);
}
function onGps(position){const c=position.coords,now=performance.now(),raw={lat:c.latitude,lng:c.longitude,heading:Number.isFinite(c.heading)?c.heading:null,speed:Number.isFinite(c.speed)?c.speed:null,time:now};if(state.lastGps){const dt=(now-state.lastGps.time)/1000,calculated=dt>.25?distance(state.lastGps,raw)/dt:null,chosen=raw.speed!=null&&raw.speed>.3?raw.speed:calculated;if(Number.isFinite(chosen)&&chosen<45){state.speedSamples.push(chosen);if(state.speedSamples.length>8)state.speedSamples.shift()}}state.lastGps=raw;state.gps=raw;state.target=raw;if(!state.display)state.display={...raw,heading:raw.heading||0};$('gpsBadge').textContent=`GPS ±${Math.round(c.accuracy)} m`;if(!state.userMarker)state.userMarker=L.marker([raw.lat,raw.lng],{icon:vehicleIcon,zIndexOffset:1000}).addTo(map);if(!state.animating){state.animating=true;requestAnimationFrame(animate)}if(state.navigation)updateNavigation(raw)}
function animate(){if(state.display&&state.target&&state.userMarker){state.display.lat+=(state.target.lat-state.display.lat)*.09;state.display.lng+=(state.target.lng-state.display.lng)*.09;const desired=state.target.heading??bearing(state.display,state.target);state.display.heading=smoothAngle(state.display.heading||0,desired||0);state.userMarker.setLatLng([state.display.lat,state.display.lng]);const el=state.userMarker.getElement()?.querySelector('.vehicle');if(el)el.style.transform=`rotate(${state.display.heading}deg)`;if(state.navigation){const point=map.latLngToContainerPoint([state.display.lat,state.display.lng]),wanted=L.point(map.getSize().x*.5,map.getSize().y*.62);if(point.distanceTo(wanted)>95)map.panTo([state.display.lat,state.display.lng],{animate:true,duration:.45})}}requestAnimationFrame(animate)}
function startGps(){if(!navigator.geolocation){$('gpsBadge').textContent='GPS fehlt';return}state.watchId=navigator.geolocation.watchPosition(onGps,()=>{$('gpsBadge').textContent='GPS nicht verfügbar'},{enableHighAccuracy:true,maximumAge:500,timeout:15000})}

function startNavigation(){if(!state.route)return;state.navigation=true;state.spoken.clear();state.routeProgress=0;state.lastRouteIndex=0;state.lastManeuverDistance=null;state.lastManeuverKey=null;state.lastNavUpdate=0;document.body.classList.add('app-nav-active');hidden('planner',true);hidden('navigationTop',false);hidden('speed',false);hidden('navBar',false);requestAnimationFrame(()=>{map.invalidateSize();if(state.gps)map.setView([state.gps.lat,state.gps.lng],17);updateNavigation(state.gps||state.route.start)})}
function stopNavigation(){state.navigation=false;document.body.classList.remove('app-nav-active');clearRouteArrow();hidden('navigationTop',true);hidden('speed',true);hidden('navBar',true);hidden('planner',false);requestAnimationFrame(()=>{map.invalidateSize();if(state.routeLine)map.fitBounds(state.routeLine.getBounds(),{padding:[40,40]})})}

$('calculateButton').onclick=calculateRoute;
$('startButton').onclick=startNavigation;
$('stopButton').onclick=stopNavigation;
$('quickStopButton').onclick=stopNavigation;
$('locationButton').onclick=$('recenterButton').onclick=()=>state.gps&&map.setView([state.gps.lat,state.gps.lng],17);
$('overviewButton').onclick=()=>state.routeLine&&map.fitBounds(state.routeLine.getBounds(),{padding:[40,40]});
$('voiceButton').onclick=()=>{state.voice=!state.voice;$('voiceButton').style.opacity=state.voice?'1':'.45'};
$('gpsStartButton').onclick=async()=>{if(!state.gps)return alert('GPS ist noch nicht bereit');const label=await reverseGeocode(state.gps.lat,state.gps.lng);$('startInput').value=label;state.selected.start={lat:state.gps.lat,lng:state.gps.lng,label}};
$('menuButton').onclick=()=>{$('planner').classList.toggle('closed');requestAnimationFrame(()=>map.invalidateSize())};
document.querySelectorAll('.profile').forEach(btn=>btn.onclick=()=>{document.querySelectorAll('.profile').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.profile=btn.dataset.profile});
map.on('moveend zoomend',()=>{if(state.navigation&&state.route?.steps[state.currentStep])drawNextArrow(state.currentStep)});
window.addEventListener('resize',()=>requestAnimationFrame(()=>map.invalidateSize()));
setInterval(()=>{$('speedValue').textContent=Math.round((state.speedSamples.reduce((a,b)=>a+b,0)/(state.speedSamples.length||1))*3.6)},350);
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));
startGps();
