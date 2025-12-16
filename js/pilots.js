import { game, saveGame, pilotById } from "./state.js";
import { now, clamp } from "./utils.js";
import { pushLog } from "./ui.js";

export function pilotPlane(p){
  if(!p) return null;
  return game.slots.find(s => s.pilotId === p.id) ?? null;
}
export function pilotResting(p){ return !!(p?.rest?.active); }
export function pilotInMission(p){
  const pl = pilotPlane(p);
  return !!(pl && pl.state === "MISSION");
}

export function restMinsForFatigue(f){
  return clamp(2 + Math.ceil((f ?? 0)/12), 2, 10);
}
export function fatigueState(f){
  if(f < 30) return {txt:"Fresco", cls:"good"};
  if(f < 55) return {txt:"Cansado", cls:"warn"};
  if(f < 75) return {txt:"Muy cansado", cls:"warn2"};
  return {txt:"Agotado", cls:"bad"};
}

export function startPilotRest(p){
  if(!p || !p.alive) return;
  if(p.rest?.active) { pushLog(`${p.name} ya está descansando.`); return; }
  if(pilotInMission(p)){ pushLog(`${p.name} está en misión: no puede descansar.`); return; }

  const mins = restMinsForFatigue(p.fatigue ?? 0);
  p.rest = { active:true, start: now(), end: now() + mins*60*1000, mins };
  pushLog(`😴 ${p.name} inicia descanso (${mins} min).`);
  saveGame();
}

export function finishPilotRest(p){
  p.rest.active = false;
  delete p.rest.start; delete p.rest.end; delete p.rest.mins;
  pushLog(`✅ ${p.name} termina descanso.`);
  saveGame();
}

export function passiveFatigueRecovery(dtMs){
  const dtMin = dtMs / 60000;

  for(const p of game.pilots){
    if(!p.alive) continue;
    const rest = pilotResting(p);
    const pl = pilotPlane(p);
    const inMission = pl && pl.state === "MISSION";

    let rate = 0.25;
    if(!inMission) rate = 0.6;
    if(rest) rate = 1.8;

    p.fatigue = clamp((p.fatigue ?? 0) - rate*dtMin, 0, 100);
  }
}
