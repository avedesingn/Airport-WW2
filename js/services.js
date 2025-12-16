import { game, saveGame } from "./state.js";
import { SERVICE_KIND } from "./constants.js";
import { now, clamp } from "./utils.js";
import { pushLog } from "./ui.js";

/* Duraciones y costes (balance amable) */
export function serviceFuelMins(fuel){
  const need = 100 - (fuel ?? 0);
  return Math.max(1, Math.ceil(need / 20));
}
export function serviceFuelCost(fuel){
  const need = 100 - (fuel ?? 0);
  return Math.max(1, Math.ceil(need / 15));
}
export function serviceAmmoMins(ammo){
  const need = 100 - (ammo ?? 0);
  return Math.max(1, Math.ceil(need / 25));
}
export function serviceAmmoCost(ammo){
  const need = 100 - (ammo ?? 0);
  return Math.max(1, Math.ceil(need / 20));
}
export function serviceMaintMins(condition){
  const damage = clamp(100 - (condition ?? 100), 0, 100);
  return clamp(2 + Math.ceil(damage / 15), 2, 12);
}
export function serviceMaintCost(condition){
  const c = clamp(condition ?? 100, 0, 100);
  if(c >= 90) return 1;
  if(c >= 80) return 2;
  const damage = 100 - c;
  return clamp(2 + Math.ceil(damage / 18), 2, 8);
}

/* Crew */
export function busyCount(kind){
  return game.slots.filter(s => s.state==="SERVICE" && s.service?.kind===kind).length;
}
export function totalCrewForKind(kind){
  if(kind===SERVICE_KIND.FUEL) return game.crew.fuelers ?? 0;
  if(kind===SERVICE_KIND.MAINT) return game.crew.mechanics ?? 0;
  if(kind===SERVICE_KIND.AMMO) return game.crew.armorers ?? 0;
  return 0;
}
export function freeCrew(kind){
  return Math.max(0, totalCrewForKind(kind) - busyCount(kind));
}
export function queueCount(kind){
  return game.slots.filter(s => s.pendingService?.kind===kind).length;
}
function getQueue(kind){
  return game.slots
    .filter(s => s.pendingService?.kind===kind)
    .sort((a,b)=> (a.pendingService.queuedAt - b.pendingService.queuedAt));
}

/* Start/finish */
function startServiceImmediate(slot, kind, mins, cost, isFromQueue=false){
  slot.state = "SERVICE";
  slot.service = { kind, start: now(), end: now() + mins*60*1000, cost };
  if(isFromQueue) slot.pendingService = null;
}

export function tryStartNextFromQueue(kind){
  if(freeCrew(kind) <= 0) return;

  const q = getQueue(kind);
  if(q.length === 0) return;

  const slot = q[0];
  if(slot.state !== "READY" || slot.state==="MISSION" || slot.state==="LOST" || slot.state==="SERVICE"){
    return;
  }
  const ps = slot.pendingService;
  if(!ps) return;

  startServiceImmediate(slot, ps.kind, ps.mins, ps.cost, true);

  const label = (ps.kind==="FUEL") ? "repostaje" : (ps.kind==="AMMO") ? "munición" : "mantenimiento";
  pushLog(`▶️ Sale de cola: ${slot.callsign} inicia ${label} (${ps.mins} min).`);
}

export function cancelPending(slot){
  const ps = slot.pendingService;
  if(!ps) return;
  slot.pendingService = null;
  game.points += ps.cost;
  pushLog(`↩️ Cola cancelada: ${slot.callsign}. Reembolso +${ps.cost} pts.`);
}

export function startOrQueueService(slot, kind){
  if(slot.state === "MISSION" || slot.state === "LOST") return;
  if(slot.state === "SERVICE") { pushLog(`${slot.callsign} ya está en servicio.`); return; }
  if(slot.pendingService) { pushLog(`${slot.callsign} ya está en cola (${slot.pendingService.kind}).`); return; }

  let mins=0, cost=0, label="";
  if(kind==="FUEL"){
    if((slot.fuel ?? 0) >= 100){ pushLog(`${slot.callsign} ya tiene fuel 100/100.`); return; }
    mins = serviceFuelMins(slot.fuel);
    cost = serviceFuelCost(slot.fuel);
    label = "repostaje";
  }
  if(kind==="AMMO"){
    if((slot.ammo ?? 0) >= 100){ pushLog(`${slot.callsign} ya tiene munición 100/100.`); return; }
    mins = serviceAmmoMins(slot.ammo);
    cost = serviceAmmoCost(slot.ammo);
    label = "munición";
  }
  if(kind==="MAINT"){
    if((slot.condition ?? 0) >= 100){ pushLog(`${slot.callsign} ya está a 100/100.`); return; }
    mins = serviceMaintMins(slot.condition);
    cost = serviceMaintCost(slot.condition);
    label = "mantenimiento";
  }

  if(game.points < cost){
    pushLog(`No hay puntos para ${label} de ${slot.callsign}: faltan ${cost} pts.`);
    return;
  }

  // Paga al entrar (como pediste)
  if(freeCrew(kind) > 0){
    game.points -= cost;
    startServiceImmediate(slot, kind, mins, cost, false);
    pushLog(`🔧 ${slot.callsign} inicia ${label} (${mins} min) por ${cost} pts.`);
    saveGame();
    return;
  }

  game.points -= cost;
  slot.pendingService = { kind, queuedAt: now(), mins, cost };
  pushLog(`⏳ ${slot.callsign} entra en cola de ${label} (${mins} min). Reserva ${cost} pts.`);
  saveGame();
}

export function finishService(slot){
  const k = slot.service?.kind;
  if(k==="FUEL") slot.fuel = 100;
  if(k==="AMMO") slot.ammo = 100;
  if(k==="MAINT") slot.condition = 100;

  slot.service = null;
  slot.state = "READY";

  const label = (k==="FUEL") ? "repostaje" : (k==="AMMO") ? "munición" : "mantenimiento";
  pushLog(`✅ ${slot.callsign} ${label} completado.`);

  tryStartNextFromQueue(k);
  saveGame();
}
