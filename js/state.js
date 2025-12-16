import { KEY } from "./constants.js";
import { now, uid } from "./utils.js";

export let game = null;

export function defaultGame(){
  const pilots = [
    {id:uid(), name:"F/O Harris",   role:"Fighter", skill:1, fatigue:10, alive:true, missions:0, kills:0, rest:{active:false}},
    {id:uid(), name:"P/O Clarke",   role:"Fighter", skill:2, fatigue:5,  alive:true, missions:0, kills:0, rest:{active:false}},
    {id:uid(), name:"Sgt. Miller",  role:"Fighter", skill:1, fatigue:0,  alive:true, missions:0, kills:0, rest:{active:false}},
    {id:uid(), name:"F/Lt Benson",  role:"Fighter", skill:3, fatigue:25, alive:true, missions:0, kills:0, rest:{active:false}},
    {id:uid(), name:"P/O Shaw",     role:"Fighter", skill:2, fatigue:15, alive:true, missions:0, kills:0, rest:{active:false}},
    {id:uid(), name:"Sgt. Evans",   role:"Fighter", skill:1, fatigue:0,  alive:true, missions:0, kills:0, rest:{active:false}},
  ];

  const slots = Array.from({length:6}).map((_,i)=>({
    id:uid(),
    callsign:`Red-${i+1}`,
    model:"Spitfire Mk.I",
    ammo:100,
    fuel:100,
    condition:100,
    state:"READY",     // READY | MISSION | SERVICE | LOST
    service: null,     // {kind,start,end,cost}
    pendingService: null, // {kind, queuedAt, mins, cost}
    pilotId: (i < pilots.length) ? pilots[i].id : null,
    squadronId: i < 3 ? 1 : 2
  }));

  return {
    version:"1.0",
    createdAt: now(),
    lastTick: now(),
    points: 14,
    ui: { tab: "PLANES" },
    crew: { fuelers:1, mechanics:1, armorers:1 },
    pilots,
    slots,
    missions: [],

    // ✅ NUEVO: historial persistente de informes
    missionHistory: [],

    log: [{t: now(), msg:"Base RAF lista. v1.0: personal de tierra + colas + contratación (modular)."}]
  };
}

export function load(){
  try{
    const raw = localStorage.getItem(KEY);
    if(!raw) return null;
    const g = JSON.parse(raw);
    if(!g || g.version !== "1.0") return null;

    if(!g.ui) g.ui = { tab:"PLANES" };
    if(!g.ui.tab) g.ui.tab = "PLANES";

    if(!g.crew) g.crew = { fuelers:1, mechanics:1, armorers:1 };

    // ✅ NUEVO: asegurar array de informes
    if(!Array.isArray(g.missionHistory)) g.missionHistory = [];
    // saneo mínimo de informes
    g.missionHistory = g.missionHistory
      .filter(r => r && typeof r === "object" && r.id && r.missionId)
      .slice(0, 50);

    for(const p of (g.pilots ?? [])){
      if(typeof p.missions !== "number") p.missions = 0;
      if(typeof p.kills !== "number") p.kills = 0;
      if(typeof p.alive !== "boolean") p.alive = true;
      if(!p.role) p.role = "Fighter";
      if(!p.rest) p.rest = {active:false};
      if(typeof p.rest.active !== "boolean") p.rest.active = false;
    }
    for(const s of (g.slots ?? [])){
      if(!("pilotId" in s)) s.pilotId = null;
      if(!("state" in s)) s.state = "READY";
      if(!("service" in s)) s.service = null;
      if(!("pendingService" in s)) s.pendingService = null;
    }

    // ✅ por si en saves antiguos no existe missions/log
    if(!Array.isArray(g.missions)) g.missions = [];
    if(!Array.isArray(g.log)) g.log = [];

    return g;
  }catch(e){
    return null;
  }
}

export function initGame(){
  game = load() ?? defaultGame();
  return game;
}

export function saveGame(){
  localStorage.setItem(KEY, JSON.stringify(game));
}

export function hardReset(){
  localStorage.removeItem(KEY);
  game = defaultGame();
  saveGame();
  return game;
}

/* Accessors */
export function pilotById(id){ return game.pilots.find(p=>p.id===id); }
export function slotById(id){ return game.slots.find(s=>s.id===id); }
