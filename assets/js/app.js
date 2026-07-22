const $=id=>document.getElementById(id);
const state={map:null,gps:null,lastGps:null,display:null,target:null,userMarker:null,route:null,routeLine:null,routeArrowGroup:null,watchId:null,navigation:false,currentStep:0,voice:true,profile:'safe',speedSamples:[],spoken:new Set(),animating:false,autocompleteTimers:new Map(),selected:{start:null,destination:null},progressIndex:0,progressMeters:0,snapped:null};

const map=L.map('map',{zoomControl:false,preferCanvas:true}).setView([51.756,14.335],13);state.map=map;
map.createPane('routePane');map.getPane('routePane').classList.add('leaflet-route-pane');
map.createPane('arrowPane');map.getPane('arrowPane').classList.add('leaflet-arrow-pane');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
const vehicleIcon=L.divIcon({className:'',iconSize:[40,40],iconAnchor:[20,20],html:'<div class="vehicle"><svg viewBox="0 0 48 48"><path d="M24 4 40 42 24 33 8 42 24 4Z" fill="#168eff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg></div>'});


const hidden=(id,value)=>$(id).classList.toggle('hidden',value);
const distance=(a,b)=>{const R=6371000,p1=a.lat*Math.PI/180,p2=b.lat*Math.PI/180,dp=(b.lat-a.lat)*Math.PI/180,dl=(b.lng-a.lng)*Math.PI/180;const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))};
const fmtDistance=m=>m>=1000?`${(m/1000).toFixed(m>=10000?0:1).replace('.',',')} km`:`${Math.max(0,Math.round(m/10)*10)} m`;
const fmtTime=s=>{const h=Math.floor(s/3600),m=Math.max(1,Math.round((s%3600)/60));return h?`${h} h ${m} min`:`${m} min`};
const bearing=(a,b)=>{const p1=a.lat*Math.PI/180,p2=b.lat*Math.PI/180,dl=(b.lng-a.lng)*Math.PI/180;return(Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI+360)%360};
const smoothAngle=(a,b,f=.16)=>a+((((b-a)+540)%360)-180)*f;
const toXY=(p,refLat)=>{const k=Math.PI/180,R=6371000;return{x:p.lng*k*R*Math.cos(refLat*k),y:p.lat*k*R}};
function projectToSegment(pos,a,b){
  const ref=(pos.lat+a.lat+b.lat)/3,p=toXY(pos,ref),p1=toXY(a,ref),p2=toXY(b,ref);
  const vx=p2.x-p1.x,vy=p2.y-p1.y,wx=p.x-p1.x,wy=p.y-p1.y,len2=vx*vx+vy*vy;
  const t=len2?Math.max(0,Math.min(1,(wx*vx+wy*vy)/len2)):0;
  const x=p1.x+t*vx,y=p1.y+t*vy,dx=p.x-x,dy=p.y-y;
  return{t,d:Math.hypot(dx,dy),lat:a.lat+(b.lat-a.lat)*t,lng:a.lng+(b.lng-a.lng)*t};
}
function buildRouteMeta(route){
  const pts=route.coords.map(([lat,lng])=>({lat,lng}));
  const cumulative=[0];
  for(let i=1;i<pts.length;i++)cumulative[i]=cumulative[i-1]+distance(pts[i-1],pts[i]);
  const stepMeta=route.steps.map((step,index)=>{
    const a=anchor(step);let routeIndex=0,best=Infinity;
    if(a){for(let i=0;i<pts.length;i++){const d=distance(a,pts[i]);if(d<best){best=d;routeIndex=i}}}
    return{step,index,routeIndex,meters:cumulative[routeIndex]||0};
  });
  return{pts,cumulative,stepMeta,total:cumulative.at(-1)||0};
}
function snapToRoute(pos){
  const meta=state.route?.meta;if(!meta||meta.pts.length<2)return{lat:pos.lat,lng:pos.lng,index:0,meters:0,d:Infinity,heading:pos.heading||0};
  const start=Math.max(0,state.progressIndex-35),end=Math.min(meta.pts.length-2,state.progressIndex+220);
  let best={d:Infinity,index:state.progressIndex,t:0,lat:pos.lat,lng:pos.lng};
  for(let i=start;i<=end;i++){
    const p=projectToSegment(pos,meta.pts[i],meta.pts[i+1]);
    const meters=meta.cumulative[i]+p.t*(meta.cumulative[i+1]-meta.cumulative[i]);
    if(p.d<best.d)best={...p,index:i,meters};
  }
  // Never jump far backwards because of GPS noise or parallel roads.
  if(best.meters+35<state.progressMeters){
    const i=Math.min(state.progressIndex,meta.pts.length-2),a=meta.pts[i],b=meta.pts[i+1];
    return{lat:a.lat,lng:a.lng,index:i,meters:state.progressMeters,d:best.d,heading:bearing(a,b)};
  }
  best.heading=bearing(meta.pts[best.index],meta.pts[Math.min(best.index+1,meta.pts.length-1)]);
  return best;
}
function actionable(step){
  const type=step?.maneuver?.type||'',mod=step?.maneuver?.modifier||'';
  if(['depart','arrive','notification','new name'].includes(type))return false;
  return ['turn','continue','fork','merge','end of road','roundabout','rotary','roundabout turn','exit roundabout','exit rotary','uturn'].includes(type)||/left|right|uturn/.test(mod);
}
function nextManeuverMeta(){
  const list=state.route?.meta?.stepMeta||[];
  return list.find(m=>actionable(m.step)&&m.meters>state.progressMeters+7)||null;
}
function sliceRouteByMeters(fromMeters,toMeters){
  const meta=state.route.meta,points=[];
  const addPointAt=(meters)=>{
    let i=0;while(i<meta.cumulative.length-2&&meta.cumulative[i+1]<meters)i++;
    const span=Math.max(1,meta.cumulative[i+1]-meta.cumulative[i]),t=Math.max(0,Math.min(1,(meters-meta.cumulative[i])/span));
    const a=meta.pts[i],b=meta.pts[i+1];return{lat:a.lat+(b.lat-a.lat)*t,lng:a.lng+(b.lng-a.lng)*t};
  };
  points.push(addPointAt(fromMeters));
  for(let i=1;i<meta.pts.length-1;i++)if(meta.cumulative[i]>fromMeters&&meta.cumulative[i]<toMeters)points.push(meta.pts[i]);
  points.push(addPointAt(Math.min(toMeters,meta.total)));
  return points;
}
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
    state.route={...route,start,target,coords,steps:route.legs.flatMap(leg=>leg.steps||[])};state.route.meta=buildRouteMeta(state.route);state.currentStep=0;state.progressIndex=0;state.progressMeters=0;state.snapped=null;
    if(state.routeLine)map.removeLayer(state.routeLine);
    clearRouteArrow();
    state.routeLine=L.polyline(coords,{pane:'routePane',color:'#168eff',weight:9,opacity:1,lineCap:'round',lineJoin:'round'}).addTo(map).bringToFront();
    requestAnimationFrame(()=>{map.invalidateSize();map.fitBounds(state.routeLine.getBounds(),{padding:[45,45],animate:true});state.routeLine.bringToFront()});
    $('routeResult').innerHTML=`<div><small>Fahrzeit</small><strong>${fmtTime(route.duration)}</strong></div><div><small>Strecke</small><strong>${fmtDistance(route.distance)}</strong></div><div><small>Ankunft</small><strong>${new Date(Date.now()+route.duration*1000).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}</strong></div>`;
    hidden('routeResult',false);hidden('startButton',false);
  }catch(error){console.error(error);alert(error.message||'Route konnte nicht berechnet werden')}
  finally{$('calculateButton').disabled=false;$('calculateButton').textContent='Route berechnen'}
}

function maneuver(step){const type=step.maneuver?.type||'',mod=step.maneuver?.modifier||'',exit=step.maneuver?.exit;let icon='↑',text='Geradeaus weiter';if(type==='roundabout'||type==='rotary'){icon='⟳';text=exit?`Im Kreisverkehr die ${exit}. Ausfahrt nehmen`:'In den Kreisverkehr einfahren'}else if(type==='uturn'||mod==='uturn'){icon='↶';text='Wenden'}else if(mod.includes('slight left')){icon='↖';text='Leicht links halten'}else if(mod.includes('sharp left')){icon='↰';text='Scharf links abbiegen'}else if(mod.includes('left')){icon='←';text='Links abbiegen'}else if(mod.includes('slight right')){icon='↗';text='Leicht rechts halten'}else if(mod.includes('sharp right')){icon='↱';text='Scharf rechts abbiegen'}else if(mod.includes('right')){icon='→';text='Rechts abbiegen'}return{icon,text,road:step.name||'Straßenverlauf folgen'}}
function anchor(step){const p=step.maneuver?.location;return p?{lat:p[1],lng:p[0]}:null}
function nearestRouteIndex(pos){return snapToRoute(pos).index}
function remainingDistance(){return Math.max(0,(state.route?.meta?.total||0)-state.progressMeters)}
function clearRouteArrow(){if(state.routeArrowGroup){map.removeLayer(state.routeArrowGroup);state.routeArrowGroup=null}}
function updateRemainingRoute(){
  if(!state.routeLine||!state.route?.meta)return;
  const pts=sliceRouteByMeters(state.progressMeters,state.route.meta.total).map(p=>[p.lat,p.lng]);
  if(pts.length>=2)state.routeLine.setLatLngs(pts);
}
function drawNextArrow(meta){
  clearRouteArrow();
  if(!meta||!state.navigation)return;
  const distanceToTurn=meta.meters-state.progressMeters;
  if(distanceToTurn<3||distanceToTurn>900)return;
  const type=meta.step.maneuver?.type||'';
  const isRound=/roundabout|rotary/.test(type);
  const before=isRound?55:42,after=isRound?95:58;
  const start=Math.max(state.progressMeters,meta.meters-before),end=Math.min(state.route.meta.total,meta.meters+after);
  const points=sliceRouteByMeters(start,end);
  if(points.length<2)return;

  const latlngs=points.map(p=>[p.lat,p.lng]);
  const group=L.layerGroup().addTo(map);
  // dark outline keeps the arrow visible on bright map tiles
  L.polyline(latlngs,{pane:'arrowPane',color:'#1d2a47',weight:15,opacity:.72,lineCap:'round',lineJoin:'round',interactive:false}).addTo(group);
  L.polyline(latlngs,{pane:'arrowPane',color:'#fff',weight:9,opacity:1,lineCap:'round',lineJoin:'round',interactive:false}).addTo(group);

  const tip=points.at(-1),prev=points.at(-2),angle=bearing(prev,tip);
  const icon=L.divIcon({className:'turn-arrow-head-wrap',iconSize:[34,34],iconAnchor:[17,17],html:`<div class="turn-arrow-head" style="transform:rotate(${angle}deg)"><svg viewBox="0 0 34 34" aria-hidden="true"><path d="M17 2 L31 28 L17 22 L3 28 Z" fill="#fff" stroke="#1d2a47" stroke-width="2.7" stroke-linejoin="round"/></svg></div>`});
  L.marker([tip.lat,tip.lng],{pane:'arrowPane',icon,interactive:false,zIndexOffset:2000}).addTo(group);
  state.routeArrowGroup=group;
}
function speak(step,dist,ins){if(!state.voice||!('speechSynthesis'in window)||!actionable(step))return;const thresholds=[5000,1000,500,250,100,50,10];for(const t of thresholds){const key=`${state.currentStep}-${t}`;if(dist<=t&&!state.spoken.has(key)){state.spoken.add(key);const prefix=t===10?'Jetzt':`In ${fmtDistance(t)}`;const utter=new SpeechSynthesisUtterance(`${prefix} ${ins.text}${ins.road?` in ${ins.road}`:''}`);utter.lang='de-DE';speechSynthesis.cancel();speechSynthesis.speak(utter);break}}}
function updateNavigation(pos){
  if(!state.navigation||!state.route)return;
  const snapped=snapToRoute(pos);state.snapped=snapped;
  if(snapped.d<85){state.progressMeters=Math.max(state.progressMeters,snapped.meters);state.progressIndex=Math.max(state.progressIndex,snapped.index)}
  updateRemainingRoute();
  const next=nextManeuverMeta();
  if(!next){clearRouteArrow();return}
  state.currentStep=next.index;
  const dist=Math.max(0,next.meters-state.progressMeters),ins=maneuver(next.step);
  $('instructionIcon').textContent=ins.icon;$('instructionDistance').textContent=dist<12?'Jetzt':fmtDistance(dist);$('instructionText').textContent=ins.text;$('instructionRoad').textContent=ins.road;
  drawNextArrow(next);
  const left=remainingDistance(),speed=Math.max(5,state.speedSamples.at(-1)||8),seconds=left/speed;
  $('remainingDistance').textContent=fmtDistance(left);$('remainingTime').textContent=fmtTime(seconds);$('arrivalTime').textContent=new Date(Date.now()+seconds*1000).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
  if(snapped.d<55)speak(next.step,dist,ins);
}

function onGps(position){const c=position.coords,now=performance.now(),raw={lat:c.latitude,lng:c.longitude,heading:Number.isFinite(c.heading)?c.heading:null,speed:Number.isFinite(c.speed)?c.speed:null,time:now};if(state.lastGps){const dt=(now-state.lastGps.time)/1000,calculated=dt>.25?distance(state.lastGps,raw)/dt:null,chosen=raw.speed!=null&&raw.speed>.3?raw.speed:calculated;if(Number.isFinite(chosen)&&chosen<45){state.speedSamples.push(chosen);if(state.speedSamples.length>8)state.speedSamples.shift()}}state.lastGps=raw;state.gps=raw;const snapped=state.navigation&&state.route?snapToRoute(raw):null;state.target=snapped?{...raw,lat:snapped.lat,lng:snapped.lng,heading:snapped.heading}:raw;if(!state.display)state.display={...raw,heading:raw.heading||0};$('gpsBadge').textContent=`GPS ±${Math.round(c.accuracy)} m`;if(!state.userMarker)state.userMarker=L.marker([raw.lat,raw.lng],{icon:vehicleIcon,zIndexOffset:1000}).addTo(map);if(!state.animating){state.animating=true;requestAnimationFrame(animate)}if(state.navigation)updateNavigation(raw)}
function animate(){if(state.display&&state.target&&state.userMarker){state.display.lat+=(state.target.lat-state.display.lat)*.09;state.display.lng+=(state.target.lng-state.display.lng)*.09;const desired=state.target.heading??bearing(state.display,state.target);state.display.heading=smoothAngle(state.display.heading||0,desired||0);state.userMarker.setLatLng([state.display.lat,state.display.lng]);const el=state.userMarker.getElement()?.querySelector('.vehicle');if(el)el.style.transform=`rotate(${state.display.heading}deg)`;if(state.navigation){const point=map.latLngToContainerPoint([state.display.lat,state.display.lng]),wanted=L.point(map.getSize().x*.5,map.getSize().y*.62);if(point.distanceTo(wanted)>95)map.panTo([state.display.lat,state.display.lng],{animate:true,duration:.45})}}requestAnimationFrame(animate)}
function startGps(){if(!navigator.geolocation){$('gpsBadge').textContent='GPS fehlt';return}state.watchId=navigator.geolocation.watchPosition(onGps,()=>{$('gpsBadge').textContent='GPS nicht verfügbar'},{enableHighAccuracy:true,maximumAge:500,timeout:15000})}

function startNavigation(){if(!state.route)return;state.navigation=true;state.spoken.clear();state.progressIndex=0;state.progressMeters=0;state.snapped=null;document.body.classList.add('app-nav-active');hidden('planner',true);hidden('navigationTop',false);hidden('speed',false);hidden('navBar',false);requestAnimationFrame(()=>{map.invalidateSize();if(state.gps)map.setView([state.gps.lat,state.gps.lng],17);updateNavigation(state.gps||state.route.start)})}
function stopNavigation(){state.navigation=false;document.body.classList.remove('app-nav-active');clearRouteArrow();if(state.routeLine&&state.route)state.routeLine.setLatLngs(state.route.coords);hidden('navigationTop',true);hidden('speed',true);hidden('navBar',true);hidden('planner',false);requestAnimationFrame(()=>{map.invalidateSize();if(state.routeLine)map.fitBounds(state.routeLine.getBounds(),{padding:[40,40]})})}

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
map.on('moveend zoomend',()=>{if(state.navigation)drawNextArrow(nextManeuverMeta())});
window.addEventListener('resize',()=>requestAnimationFrame(()=>map.invalidateSize()));
setInterval(()=>{$('speedValue').textContent=Math.round((state.speedSamples.reduce((a,b)=>a+b,0)/(state.speedSamples.length||1))*3.6)},350);
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));
startGps();
