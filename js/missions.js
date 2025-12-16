import { game, saveGame, slotById, pilotById } from "./state.js";
import { MISSION_GEN_COST, MIN_AMMO_TO_LAUNCH, MIN_COND_TO_LAUNCH, MIN_FUEL_TO_LAUNCH } from "./constants.js";
import { now, clamp, chance, randInt } from "./utils.js";
import { pilotResting, pilotPlane } from "./pilots.js";
import { pushLog } from "./ui.js";

export function canLaunch(slot){
  if(slot.state!=="READY") return {ok:false, why:"No disponible"};
  const p = pilotById(slot.pilotId);
  if(!p || !p.alive) return {ok:false, why:"Sin piloto"};
  if(pilotResting(p)) return {ok:false, why:"Piloto descansando"};
  if((p.fatigue ?? 0) >= 85) return {ok:false, why:"Piloto agotado"};
  if((slot.fuel ?? 0) < MIN_FUEL_TO_LAUNCH) return {ok:false, why:"Sin combustible"};
  if((slot.condition ?? 0) < MIN_COND_TO_LAUNCH) return {ok:false, why:"Condición crítica"};
  if((slot.ammo ?? 0) < MIN_AMMO_TO_LAUNCH) return {ok:false, why:"Sin munición"};
  return {ok:true, why:""};
}

export function generateMission(){
  const types = [
    {key:"PATROL",    name:"Patrulla costera", baseMin:2, baseMax:4, reward:[10,16], fatigue:[6,12]},
    {key:"INTERCEPT", name:"Intercepción",     baseMin:2, baseMax:5, reward:[12,20], fatigue:[10,18]},
    {key:"ESCORT",    name:"Escolta corta",    baseMin:3, baseMax:5, reward:[11,18], fatigue:[8,16]},
    {key:"SCRAMBLE",  name:"Alerta rápida",    baseMin:2, baseMax:4, reward:[11,19], fatigue:[10,18]},
  ];
  const pick = types[Math.floor(Math.random()*types.length)];
  const durMin = pick.baseMin + Math.floor(Math.random()*(pick.baseMax-pick.baseMin+1));
  const durationMs = durMin * 60 * 1000;
  const requiredPlanes = [3,4,5][Math.floor(Math.random()*3)];

  return {
    id: crypto.randomUUID?.() ?? (Math.random().toString(16).slice(2)),
    typeKey: pick.key,
    name: pick.name,
    createdAt: now(),
    startAt: null,
    endAt: null,
    durationMs,
    rewardMin: pick.reward[0],
    rewardMax: pick.reward[1],
    fatigueMin: pick.fatigue[0],
    fatigueMax: pick.fatigue[1],
    requiredPlanes,
    assignedSquadronId: null,
    assignedSlotIds: [],
    state: "PENDING"
  };
}

export function missionRisk(typeKey){
  if(typeKey==="INTERCEPT") return 0.20;
  if(typeKey==="SCRAMBLE")  return 0.16;
  if(typeKey==="ESCORT")    return 0.12;
  if(typeKey==="PATROL")    return 0.08;
  return 0.12;
}
function baseKillChanceForMission(typeKey){
  if(typeKey==="INTERCEPT") return 0.30;
  if(typeKey==="SCRAMBLE")  return 0.24;
  if(typeKey==="ESCORT")    return 0.10;
  if(typeKey==="PATROL")    return 0.08;
  return 0.12;
}
function rollKillsForPilot(pilot, mission){
  if(!pilot || !pilot.alive) return 0;
  if(pilot.role !== "Fighter") return 0;

  const base = baseKillChanceForMission(mission.typeKey);
  const skillBonus = 0.06 * (pilot.skill ?? 1);
  const fatiguePenalty = clamp((pilot.fatigue ?? 0) / 220, 0, 0.35);
  const chanceP = clamp(base + skillBonus - fatiguePenalty, 0.02, 0.65);
  return chance(chanceP) ? 1 : 0;
}
function computeRiskForSlot(slot, pilot, mission){
  const base = missionRisk(mission.typeKey);
  const fat = clamp((pilot?.fatigue ?? 0) / 160, 0, 0.55);
  const skill = clamp((pilot?.skill ?? 1) * 0.05, 0, 0.18);
  const condPenalty = clamp((60 - (slot.condition ?? 100)) / 200, 0, 0.25);
  return clamp(base + fat + condPenalty - skill, 0.03, 0.90);
}
function fuelCostForMission(typeKey){
  if(typeKey==="INTERCEPT") return randInt(22, 32);
  if(typeKey==="SCRAMBLE")  return randInt(18, 28);
  if(typeKey==="ESCORT")    return randInt(20, 30);
  if(typeKey==="PATROL")    return randInt(16, 26);
  return randInt(18, 28);
}
function ammoCostForMission(typeKey){
  if(typeKey==="INTERCEPT") return randInt(22, 38);
  if(typeKey==="SCRAMBLE")  return randInt(18, 34);
  if(typeKey==="ESCORT")    return randInt(10, 22);
  if(typeKey==="PATROL")    return randInt(6, 16);
  return randInt(12, 26);
}

export function readySlotsInSquad(sqId){
  return game.slots.filter(s => (s.squadronId ?? 0) === sqId && canLaunch(s).ok);
}
export function findEligibleSquads(requiredPlanes){
  return [0,1,2,3,4].filter(sqId => readySlotsInSquad(sqId).length >= requiredPlanes);
}

function resolveSlotOutcome(slot, pilot, mission){
  const risk = computeRiskForSlot(slot, pilot, mission);

  let damage = 0;
  if(chance(risk)){
    damage = randInt(6, 28) + (risk > 0.45 ? randInt(0, 14) : 0);
    slot.condition = clamp((slot.condition ?? 100) - damage, 0, 100);
  }

  let lostPlane = false;
  let pilotDown = false;
  let lossReason = null;

  const lowFuel = (slot.fuel ?? 0) <= 10;
  if(lowFuel && chance(clamp(0.04 + risk*0.10, 0.04, 0.18))){
    lostPlane = true; lossReason = "FUEL";
  }
  if(!lostPlane){
    const combatChance = clamp(risk * 0.10, 0.01, 0.14);
    if(chance(combatChance)){ lostPlane = true; lossReason = "COMBAT"; }
  }
  if(!lostPlane){
    const accidentChance = clamp(risk * 0.06, 0.005, 0.10);
    if(chance(accidentChance)){ lostPlane = true; lossReason = "ACCIDENT"; }
  }

  if(lostPlane){
    const survBonus = clamp((pilot?.skill ?? 1) * 0.08, 0.08, 0.24);
    const survive = chance(clamp(0.45 + survBonus, 0.45, 0.75));
    pilotDown = !survive;
  }

  return { damage, lostPlane, pilotDown, risk, lossReason };
}

export function completeMission(m){
  let reward = randInt(m.rewardMin, m.rewardMax);
  let totalKills = 0;
  let lostCount = 0;
  let damagedCount = 0;

  const fuelSpent = fuelCostForMission(m.typeKey);
  const ammoSpent = ammoCostForMission(m.typeKey);

  for(const slotId of m.assignedSlotIds){
    const s = slotById(slotId);
    if(!s) continue;
    const p = pilotById(s.pilotId);

    s.fuel = clamp((s.fuel ?? 0) - fuelSpent, 0, 100);
    s.ammo = clamp((s.ammo ?? 0) - ammoSpent, 0, 100);

    if(p && p.alive) p.missions = (p.missions ?? 0) + 1;

    const fat = randInt(m.fatigueMin, m.fatigueMax);
    if(p && p.alive){
      const skillReduction = clamp((p.skill ?? 1)*2, 0, 8);
      p.fatigue = clamp((p.fatigue ?? 0) + Math.max(0, fat - skillReduction), 0, 100);
    }

    const k = (p && p.alive) ? rollKillsForPilot(p, m) : 0;
    if(p && p.alive && k > 0){
      p.kills = (p.kills ?? 0) + k;
      totalKills += k;
    }

    const out = resolveSlotOutcome(s, p, m);
    if(out.damage > 0) damagedCount++;

    if(out.lostPlane){
      lostCount++;
      s.state = "LOST";
      s.condition = 0; s.fuel = 0; s.ammo = 0;
      s.service = null;
      s.pendingService = null;

      const pilotName = p ? p.name : "Piloto desconocido";
      const why = (out.lossReason==="COMBAT") ? "eliminado en combate"
                : (out.lossReason==="ACCIDENT") ? "accidente mecánico"
                : (out.lossReason==="FUEL") ? "falta de combustible"
                : "causa desconocida";

      if(p){
        if(out.pilotDown){
          p.alive = false;
          pushLog(`✖️ ${s.callsign} no regresa: ${why}. ${pilotName} KIA/MIA.`);
        } else {
          p.fatigue = clamp((p.fatigue ?? 0) + 20, 0, 100);
          pushLog(`⚠️ ${s.callsign} perdido: ${why}. ${pilotName} vuelve (rescate).`);
        }
      } else {
        pushLog(`✖️ ${s.callsign} perdido: ${why}.`);
      }
      continue;
    }

    s.state = "READY";
    s.service = null;
  }

  if(lostCount > 0){
    reward = Math.max(1, Math.floor(reward * (1 - 0.20*lostCount)));
  }

  game.points += reward;
  m.state = "DONE";

  const extra = [];
  if(totalKills>0) extra.push(`Derribos +${totalKills}`);
  if(damagedCount>0) extra.push(`Daños: ${damagedCount}`);
  if(lostCount>0) extra.push(`Pérdidas: ${lostCount}`);

  pushLog(`Misión completada: +${reward} pts. Fuel -${fuelSpent} • Ammo -${ammoSpent}.${extra.length ? " ("+extra.join(" • ")+")" : ""}`);
  saveGame();
}

export function assignMissionToSquad(missionId, squadId){
  const m = game.missions.find(x=>x.id===missionId);
  if(!m || m.state!=="PENDING") return;

  const ready = readySlotsInSquad(squadId);
  if(ready.length < m.requiredPlanes){
    pushLog(`SQ ${squadId} no cumple el mínimo (${m.requiredPlanes}).`);
    return;
  }

  const chosen = ready.slice(0, m.requiredPlanes);
  for(const s of chosen){
    s.state = "MISSION";
    s.service = null;
    if(s.pendingService){
      game.points += s.pendingService.cost;
      s.pendingService = null;
      pushLog(`↩️ ${s.callsign}: cola cancelada por despegue (reembolso).`);
    }
  }

  m.assignedSquadronId = squadId;
  m.assignedSlotIds = chosen.map(s=>s.id);
  m.startAt = now();
  m.endAt = m.startAt + m.durationMs;
  m.state = "ACTIVE";

  pushLog(`SQ ${squadId} despega (${m.requiredPlanes}): “${m.name}”.`);
  saveGame();
}

export function spendForNewMission(){
  if(game.points < MISSION_GEN_COST) return false;
  game.points -= MISSION_GEN_COST;
  return true;
}
