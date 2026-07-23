const $=id=>document.getElementById(id);
const state={map:null,gps:null,lastGps:null,display:null,target:null,userMarker:null,route:null,routeLine:null,routeArrowGroup:null,watchId:null,navigation:false,currentStep:0,voice:true,profile:'safe',speedSamples:[],spoken:new Set(),animating:false,autocompleteTimers:new Map(),selected:{start:null,destination:null},progressIndex:0,progressMeters:0,snapped:null,mapBearing:0,roundaboutMemory:null,displayMeters:null,lastFrameTime:0,lastVisualUpdate:0,cameraLocked:false,internalCameraMove:false};

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

function setMapBearing(value,blend=.16){
  if(!state.navigation||!state.cameraLocked)value=0;
  state.mapBearing=smoothAngle(state.mapBearing||0,value||0,blend);
  const root=document.getElementById('map');
  root.style.setProperty('--map-bearing',`${-state.mapBearing}deg`);
  root.style.setProperty('--vehicle-counter-bearing',`${state.mapBearing}deg`);
  root.classList.toggle('navigation-bearing',state.navigation&&state.cameraLocked);
}
function unlockCamera(){
  if(!state.navigation||!state.cameraLocked)return;
  state.cameraLocked=false;
  setMapBearing(0,1);
  document.getElementById('map').classList.remove('navigation-bearing');
  $('recenterButton')?.classList.add('camera-unlocked');
}
function lockCamera(){
  if(!state.navigation)return;
  state.cameraLocked=true;
  $('recenterButton')?.classList.remove('camera-unlocked');
  const p=state.display||state.snapped||state.gps;
  if(p){
    state.internalCameraMove=true;
    map.setView([p.lat,p.lng],Math.max(17,map.getZoom()),{animate:false});
    requestAnimationFrame(()=>state.internalCameraMove=false);
  }
}
function normalizedType(step){return String(step?.maneuver?.type||'').toLowerCase()}
function isRoundaboutStep(step){
  const type=normalizedType(step);
  return type.includes('roundabout')||type.includes('rotary')||type==='exit rotary';
}
function roundaboutInfo(meta){
  const list=state.route?.meta?.stepMeta||[];
  const idx=meta?.index??-1;
  if(idx<0)return null;
  let start=idx,end=idx,exit=null;
  while(start>0&&isRoundaboutStep(list[start-1].step))start--;
  while(end<list.length-1&&isRoundaboutStep(list[end+1].step))end++;
  for(let i=start;i<=Math.min(list.length-1,end+2);i++){
    const value=Number(list[i].step?.maneuver?.exit);
    if(Number.isFinite(value)&&value>0){exit=value;break}
  }
  // Some OSRM servers put the exit number on the step directly after the roundabout.
  if(!exit){
    for(let i=start;i<=Math.min(list.length-1,start+4);i++){
      const intersections=list[i].step?.intersections||[];
      const bearings=intersections[0]?.bearings;
      const entry=intersections[0]?.entry;
      if(Array.isArray(bearings)&&Array.isArray(entry)){
        const allowed=entry.filter(Boolean).length;
        if(allowed>1){exit=Math.max(1,allowed-1);break}
      }
    }
  }
  return{start,end,exit,entryMeters:list[start]?.meters??meta.meters,exitMeters:list[end]?.meters??meta.meters};
}
function actionable(step){
  const type=normalizedType(step),mod=String(step?.maneuver?.modifier||'').toLowerCase();
  if(['depart','arrive','notification','new name'].includes(type))return false;
  if(isRoundaboutStep(step))return true;
  return ['turn','fork','merge','end of road','uturn'].includes(type)||/left|right|uturn/.test(mod);
}
function nextManeuverMeta(){
  const list=state.route?.meta?.stepMeta||[];
  const candidate=list.find(m=>actionable(m.step)&&m.meters>state.progressMeters+7)||null;
  if(!candidate)return null;
  if(!isRoundaboutStep(candidate.step))return candidate;
  const info=roundaboutInfo(candidate);
  const base=list[info?.start??candidate.index]||candidate;
  return{...base,roundabout:info};
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

function pointAtRouteMeters(meters){
  const meta=state.route?.meta;
  if(!meta||meta.pts.length<2)return null;
  const m=Math.max(0,Math.min(meters,meta.total));
  let lo=0,hi=meta.cumulative.length-1;
  while(lo<hi-1){const mid=(lo+hi)>>1;if(meta.cumulative[mid]<=m)lo=mid;else hi=mid}
  const i=Math.min(lo,meta.pts.length-2),a=meta.pts[i],b=meta.pts[i+1];
  const span=Math.max(.01,meta.cumulative[i+1]-meta.cumulative[i]);
  const t=Math.max(0,Math.min(1,(m-meta.cumulative[i])/span));
  return{lat:a.lat+(b.lat-a.lat)*t,lng:a.lng+(b.lng-a.lng)*t,index:i,meters:m,heading:bearing(a,b)};
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

function decodePolyline6(encoded){
  const coords=[];
  let index=0,lat=0,lng=0;
  while(index<encoded.length){
    let result=0,shift=0,byte;
    do{byte=encoded.charCodeAt(index++)-63;result|=(byte&31)<<shift;shift+=5}while(byte>=32&&index<encoded.length);
    lat+=(result&1)?~(result>>1):(result>>1);
    result=0;shift=0;
    do{byte=encoded.charCodeAt(index++)-63;result|=(byte&31)<<shift;shift+=5}while(byte>=32&&index<encoded.length);
    lng+=(result&1)?~(result>>1):(result>>1);
    coords.push([lat/1e6,lng/1e6]);
  }
  return coords;
}
function valhallaManeuver(type){
  const table={
    1:['depart','straight'],2:['depart','right'],3:['depart','left'],
    4:['arrive','straight'],5:['arrive','right'],6:['arrive','left'],
    7:['turn','left'],8:['turn','right'],9:['turn','sharp left'],10:['turn','sharp right'],
    11:['turn','slight left'],12:['turn','slight right'],13:['continue','straight'],
    14:['uturn','right'],15:['uturn','left'],16:['on ramp','straight'],17:['on ramp','right'],18:['on ramp','left'],
    19:['off ramp','right'],20:['off ramp','left'],21:['fork','straight'],22:['fork','right'],23:['fork','left'],
    24:['merge','straight'],25:['roundabout','right'],26:['exit roundabout','right'],
    27:['notification','straight'],28:['notification','straight']
  };
  const [maneuverType,modifier]=table[Number(type)]||['continue','straight'];
  return{type:maneuverType,modifier};
}
function adaptValhallaRoute(data){
  const trip=data?.trip;
  if(!trip?.legs?.length)throw new Error(data?.error||data?.error_code||'Keine Mopedroute gefunden');
  const coords=[];
  const steps=[];
  let coordinateOffset=0;
  for(const leg of trip.legs){
    const legCoords=decodePolyline6(leg.shape||'');
    if(!legCoords.length)continue;
    if(coords.length&&legCoords.length&&coords.at(-1)[0]===legCoords[0][0]&&coords.at(-1)[1]===legCoords[0][1])legCoords.shift();
    const localOffset=coordinateOffset;
    coords.push(...legCoords);
    for(const item of leg.maneuvers||[]){
      const begin=Math.max(0,Math.min(coords.length-1,localOffset+Number(item.begin_shape_index||0)));
      const end=Math.max(begin,Math.min(coords.length-1,localOffset+Number(item.end_shape_index??item.begin_shape_index??0)));
      const mapped=valhallaManeuver(item.type);
      const exit=Number(item.roundabout_exit_count||item.roundabout_exit_number||0)||undefined;
      steps.push({
        distance:Number(item.length||0)*1000,
        duration:Number(item.time||0),
        name:(item.street_names||[])[0]||'',
        instruction:item.instruction||item.verbal_transition_alert_instruction||'',
        maneuver:{...mapped,location:[coords[begin][1],coords[begin][0]],exit},
        geometry:{coordinates:coords.slice(begin,end+1).map(([lat,lng])=>[lng,lat])},
        intersections:[]
      });
    }
    coordinateOffset=coords.length;
  }
  if(coords.length<2)throw new Error('Der Moped-Routingdienst hat keine sichtbare Route geliefert');
  const duration=Number(trip.summary?.time||trip.legs.reduce((sum,leg)=>sum+Number(leg.summary?.time||0),0));
  const distanceMeters=Number(trip.summary?.length||trip.legs.reduce((sum,leg)=>sum+Number(leg.summary?.length||0),0))*1000;
  return{
    distance:distanceMeters,
    duration,
    geometry:{coordinates:coords.map(([lat,lng])=>[lng,lat])},
    legs:[{steps}],
    provider:'valhalla-motor-scooter'
  };
}
function valhallaRouteUrl(a,b){
  const request={
    locations:[{lat:a.lat,lon:a.lng,type:'break'},{lat:b.lat,lon:b.lng,type:'break'}],
    costing:'motor_scooter',
    costing_options:{motor_scooter:{top_speed:45,use_primary:0.1,use_trails:0,shortest:false}},
    directions_options:{units:'kilometers',language:'de-DE',narrative:true}
  };
  return`https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(request))}`;
}
async function fetchRoute(a,b){
  const response=await fetch(valhallaRouteUrl(a,b),{
    headers:{'Accept':'application/json','X-Client-Id':'moped-navigator-github-pages'}
  });
  let data=null;
  try{data=await response.json()}catch{}
  if(!response.ok)throw new Error(data?.error||`Moped-Routingdienst nicht erreichbar (${response.status})`);
  return adaptValhallaRoute(data);
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
    state.route={...route,start,target,coords,steps:route.legs.flatMap(leg=>leg.steps||[])};state.route.meta=buildRouteMeta(state.route);state.currentStep=0;state.progressIndex=0;state.progressMeters=0;state.displayMeters=null;state.snapped=null;
    if(state.routeLine)map.removeLayer(state.routeLine);
    clearRouteArrow();
    state.routeLine=L.polyline(coords,{pane:'routePane',color:'#168eff',weight:9,opacity:1,lineCap:'round',lineJoin:'round'}).addTo(map).bringToFront();
    requestAnimationFrame(()=>{map.invalidateSize();map.fitBounds(state.routeLine.getBounds(),{padding:[45,45],animate:true});state.routeLine.bringToFront()});
    $('routeResult').innerHTML=`<div><small>Fahrzeit</small><strong>${fmtTime(route.duration)}</strong></div><div><small>Strecke</small><strong>${fmtDistance(route.distance)}</strong></div><div><small>Ankunft</small><strong>${new Date(Date.now()+route.duration*1000).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}</strong></div>`;
    hidden('routeResult',false);hidden('startButton',false);
  }catch(error){console.error(error);alert(error.message||'Route konnte nicht berechnet werden')}
  finally{$('calculateButton').disabled=false;$('calculateButton').textContent='Route berechnen'}
}

function maneuver(step,meta=null){
  const type=normalizedType(step),mod=String(step?.maneuver?.modifier||'').toLowerCase();
  const info=meta?.roundabout||null;
  const exit=Number(step?.maneuver?.exit)||info?.exit||null;
  let icon='↑',text='Geradeaus weiter';
  if(isRoundaboutStep(step)){
    icon='⟳';
    text=exit?`Im Kreisverkehr die ${exit}. Ausfahrt nehmen`:'In den Kreisverkehr einfahren und der Route folgen';
  }else if(type==='uturn'||mod==='uturn'){
    icon='↶';text='Wenden';
  }else if(mod.includes('slight left')){icon='↖';text='Leicht links halten';
  }else if(mod.includes('sharp left')){icon='↰';text='Scharf links abbiegen';
  }else if(mod.includes('left')){icon='←';text='Links abbiegen';
  }else if(mod.includes('slight right')){icon='↗';text='Leicht rechts halten';
  }else if(mod.includes('sharp right')){icon='↱';text='Scharf rechts abbiegen';
  }else if(mod.includes('right')){icon='→';text='Rechts abbiegen';
  }
  return{icon,text,road:step.name||'Straßenverlauf folgen'};
}
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
  const info=meta.roundabout;
  const maneuverMeters=info?.entryMeters??meta.meters;
  const distanceToTurn=maneuverMeters-state.progressMeters;
  if(distanceToTurn<3||distanceToTurn>1200)return;
  const isRound=Boolean(info)||isRoundaboutStep(meta.step);
  const before=isRound?70:48;
  const after=isRound?Math.max(125,(info?.exitMeters??maneuverMeters)-maneuverMeters+95):68;
  const start=Math.max(state.progressMeters,maneuverMeters-before);
  const end=Math.min(state.route.meta.total,maneuverMeters+after);
  const points=sliceRouteByMeters(start,end);
  if(points.length<2)return;
  const latlngs=points.map(p=>[p.lat,p.lng]);
  const group=L.layerGroup().addTo(map);
  L.polyline(latlngs,{pane:'arrowPane',color:'#17243b',weight:18,opacity:.85,lineCap:'round',lineJoin:'round',interactive:false}).addTo(group);
  L.polyline(latlngs,{pane:'arrowPane',color:'#fff',weight:10,opacity:1,lineCap:'round',lineJoin:'round',interactive:false}).addTo(group);
  const tip=points.at(-1),prev=points.at(-2),angle=bearing(prev,tip);
  const icon=L.divIcon({className:'turn-arrow-head-wrap',iconSize:[38,38],iconAnchor:[19,19],html:`<div class="turn-arrow-head" style="transform:rotate(${angle}deg)"><svg viewBox="0 0 38 38" aria-hidden="true"><path d="M19 2 L35 32 L19 25 L3 32 Z" fill="#fff" stroke="#17243b" stroke-width="3" stroke-linejoin="round"/></svg></div>`});
  L.marker([tip.lat,tip.lng],{pane:'arrowPane',icon,interactive:false,zIndexOffset:2500}).addTo(group);
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
  const maneuverMeters=next.roundabout?.entryMeters??next.meters;
  const dist=Math.max(0,maneuverMeters-state.progressMeters),ins=maneuver(next.step,next);
  $('instructionIcon').textContent=ins.icon;$('instructionDistance').textContent=dist<12?'Jetzt':fmtDistance(dist);$('instructionText').textContent=ins.text;$('instructionRoad').textContent=ins.road;
  drawNextArrow(next);
  const left=remainingDistance(),speed=Math.max(5,state.speedSamples.at(-1)||8),seconds=left/speed;
  $('remainingDistance').textContent=fmtDistance(left);$('remainingTime').textContent=fmtTime(seconds);$('arrivalTime').textContent=new Date(Date.now()+seconds*1000).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
  if(snapped.d<55)speak(next.step,dist,ins);
}

function onGps(position){
  const c=position.coords,now=performance.now(),raw={lat:c.latitude,lng:c.longitude,heading:Number.isFinite(c.heading)?c.heading:null,speed:Number.isFinite(c.speed)?c.speed:null,time:now};
  let chosen=null;
  if(state.lastGps){
    const dt=(now-state.lastGps.time)/1000,calculated=dt>.25?distance(state.lastGps,raw)/dt:null;
    chosen=raw.speed!=null&&raw.speed>.3?raw.speed:calculated;
    if(Number.isFinite(chosen)&&chosen<45){state.speedSamples.push(chosen);if(state.speedSamples.length>8)state.speedSamples.shift()}
  }
  state.lastGps=raw;state.gps=raw;
  const snapped=state.navigation&&state.route?snapToRoute(raw):null;
  state.target=snapped?{...raw,lat:snapped.lat,lng:snapped.lng,heading:snapped.heading,meters:snapped.meters}:raw;
  if(snapped&&state.displayMeters==null)state.displayMeters=snapped.meters;
  if(!state.display)state.display={...state.target,heading:state.target.heading||0};
  $('gpsBadge').textContent=`GPS ±${Math.round(c.accuracy)} m`;
  if(!state.userMarker)state.userMarker=L.marker([state.display.lat,state.display.lng],{icon:vehicleIcon,zIndexOffset:1000}).addTo(map);
  if(!state.animating){state.animating=true;state.lastFrameTime=now;requestAnimationFrame(animate)}
  if(state.navigation)updateNavigation(raw)
}
function animate(now){
  const dt=Math.min(.05,Math.max(.001,((now||performance.now())-(state.lastFrameTime||now||performance.now()))/1000));
  state.lastFrameTime=now||performance.now();
  if(state.display&&state.target&&state.userMarker){
    if(state.navigation&&state.route&&Number.isFinite(state.target.meters)){
      const avgSpeed=state.speedSamples.length?state.speedSamples.reduce((a,b)=>a+b,0)/state.speedSamples.length:0;
      const age=Math.min(2.2,Math.max(0,(performance.now()-state.target.time)/1000));
      const predicted=Math.min(state.route.meta.total,state.target.meters+Math.min(32,avgSpeed*age));
      if(state.displayMeters==null)state.displayMeters=state.target.meters;
      const moveAlpha=1-Math.exp(-dt/0.22);
      state.displayMeters+=(predicted-state.displayMeters)*moveAlpha;
      if(state.displayMeters<state.progressMeters-3)state.displayMeters=state.progressMeters;
      const routed=pointAtRouteMeters(state.displayMeters);
      if(routed){
        state.display.lat=routed.lat;state.display.lng=routed.lng;
        const turnAlpha=1-Math.exp(-dt/0.16);
        state.display.heading=smoothAngle(state.display.heading||routed.heading,routed.heading,turnAlpha);
      }
    }else{
      const moveAlpha=1-Math.exp(-dt/0.20);
      state.display.lat+=(state.target.lat-state.display.lat)*moveAlpha;
      state.display.lng+=(state.target.lng-state.display.lng)*moveAlpha;
      const desired=state.target.heading??bearing(state.display,state.target),turnAlpha=1-Math.exp(-dt/0.16);
      state.display.heading=smoothAngle(state.display.heading||0,desired||0,turnAlpha);
    }
    state.userMarker.setLatLng([state.display.lat,state.display.lng]);
    const el=state.userMarker.getElement()?.querySelector('.vehicle');
    if(el)el.style.transform=`rotate(${state.display.heading||0}deg)`;
    if(state.navigation){
      const bearingAlpha=1-Math.exp(-dt/0.14);
      setMapBearing(state.display.heading||0,bearingAlpha);
      if(state.cameraLocked){
        const point=map.latLngToContainerPoint([state.display.lat,state.display.lng]);
        const wanted=L.point(map.getSize().x*.5,map.getSize().y*.5);
        const delta=point.subtract(wanted);
        if(delta.distanceTo(L.point(0,0))>.35){
          state.internalCameraMove=true;
          map.panBy(delta.multiplyBy(Math.min(1,1-Math.exp(-dt/0.085))),{animate:false});
          requestAnimationFrame(()=>state.internalCameraMove=false);
        }
      }
      if(now-state.lastVisualUpdate>70){
        state.lastVisualUpdate=now;
        if(Number.isFinite(state.displayMeters)){
          state.progressMeters=Math.max(state.progressMeters,state.displayMeters);
          const p=pointAtRouteMeters(state.progressMeters);if(p)state.progressIndex=Math.max(state.progressIndex,p.index);
          updateRemainingRoute();drawNextArrow(nextManeuverMeta());
        }
      }
    }else setMapBearing(0,1-Math.exp(-dt/0.18));
  }
  requestAnimationFrame(animate);
}
function startGps(){if(!navigator.geolocation){$('gpsBadge').textContent='GPS fehlt';return}state.watchId=navigator.geolocation.watchPosition(onGps,()=>{$('gpsBadge').textContent='GPS nicht verfügbar'},{enableHighAccuracy:true,maximumAge:500,timeout:15000})}

function startNavigation(){if(!state.route)return;state.navigation=true;state.cameraLocked=true;state.mapBearing=0;state.spoken.clear();state.progressIndex=0;state.progressMeters=0;state.displayMeters=null;state.snapped=null;document.body.classList.add('app-nav-active');hidden('planner',true);hidden('navigationTop',false);hidden('speed',false);hidden('navBar',false);requestAnimationFrame(()=>{map.invalidateSize(true);setTimeout(()=>map.invalidateSize(true),120);if(state.gps)map.setView([state.gps.lat,state.gps.lng],17,{animate:false});updateNavigation(state.gps||state.route.start)})}
function stopNavigation(){state.navigation=false;state.cameraLocked=false;state.displayMeters=null;setMapBearing(0,1);document.body.classList.remove('app-nav-active');clearRouteArrow();if(state.routeLine&&state.route)state.routeLine.setLatLngs(state.route.coords);hidden('navigationTop',true);hidden('speed',true);hidden('navBar',true);hidden('planner',false);requestAnimationFrame(()=>{map.invalidateSize();if(state.routeLine)map.fitBounds(state.routeLine.getBounds(),{padding:[40,40]})})}

$('calculateButton').onclick=calculateRoute;
$('startButton').onclick=startNavigation;
$('stopButton').onclick=stopNavigation;
$('quickStopButton').onclick=stopNavigation;
$('locationButton').onclick=()=>{const p=state.snapped||state.gps;if(p)map.setView([p.lat,p.lng],17,{animate:false})};
$('recenterButton').onclick=()=>{lockCamera()};
$('overviewButton').onclick=()=>{unlockCamera();state.routeLine&&map.fitBounds(state.routeLine.getBounds(),{padding:[40,40]})};
$('voiceButton').onclick=()=>{state.voice=!state.voice;$('voiceButton').style.opacity=state.voice?'1':'.45'};
$('gpsStartButton').onclick=async()=>{if(!state.gps)return alert('GPS ist noch nicht bereit');const label=await reverseGeocode(state.gps.lat,state.gps.lng);$('startInput').value=label;state.selected.start={lat:state.gps.lat,lng:state.gps.lng,label}};
$('menuButton').onclick=()=>{$('planner').classList.toggle('closed');requestAnimationFrame(()=>map.invalidateSize())};
document.querySelectorAll('.profile').forEach(btn=>btn.onclick=()=>{document.querySelectorAll('.profile').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.profile=btn.dataset.profile});
map.on('dragstart',()=>{if(state.navigation&&!state.internalCameraMove)unlockCamera()});
map.on('zoomstart',event=>{if(state.navigation&&!state.internalCameraMove&&event.originalEvent)unlockCamera()});
map.on('moveend zoomend',()=>{if(state.navigation)drawNextArrow(nextManeuverMeta())});
const refreshMapSize=()=>requestAnimationFrame(()=>{map.invalidateSize(true);setTimeout(()=>{map.invalidateSize(true);if(state.navigation&&state.snapped)map.panTo([state.snapped.lat,state.snapped.lng],{animate:false});drawNextArrow(nextManeuverMeta())},120)});
window.addEventListener('resize',refreshMapSize);
window.addEventListener('orientationchange',()=>setTimeout(refreshMapSize,180));
if(window.visualViewport)window.visualViewport.addEventListener('resize',refreshMapSize);
setInterval(()=>{$('speedValue').textContent=Math.round((state.speedSamples.reduce((a,b)=>a+b,0)/(state.speedSamples.length||1))*3.6)},350);
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));
startGps();
