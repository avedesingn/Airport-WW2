import { game, saveGame, slotById, pilotById } from "./state.js";
import { MISSION_GEN_COST, MIN_AMMO_TO_LAUNCH, MIN_COND_TO_LAUNCH, MIN_FUEL_TO_LAUNCH } from "./constants.js";
import { now, clamp, chance, randInt } from "./utils.js";
import { pilotResting } from "./pilots.js";
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

/* =========================
   REPORT / LORE HELPERS
========================= */
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

function outcomeLabel(outcome){
  return outcome==="SUCCESS" ? "Misión completada con éxito."
       : outcome==="PARTIAL" ? "Resultado parcial. Objetivo cumplido de forma limitada."
       : outcome==="ABORT" ? "Misión abortada. Regreso anticipado (RTB)."
       : "Misión fallida.";
}

function buildBriefing(m){
  const zones = ["Dover", "Canterbury", "Thames Estuary", "Folkestone", "Maidstone", "Ashford", "Manston", "Ramsgate"];
  const weather = ["bruma baja", "cielo roto", "nubes en capas", "buena visibilidad", "llovizna", "capa baja densa", "turbulencia moderada"];
  const threats = ["Bf 109", "Bf 110", "Ju 88", "He 111", "formación numerosa", "contactos aislados", "incursión a baja cota"];

  const zone = m.zone || pick(zones);
  const meteo = m.weather || pick(weather);
  const threat = m.threat || pick(threats);

  const kind = m.typeKey || "PATROL";
  const kindLine =
    kind==="INTERCEPT" ? "Interceptación urgente." :
    kind==="SCRAMBLE" ? "Scramble inmediato." :
    kind==="ESCORT" ? "Escolta asignada." :
    "Patrulla CAP.";

  return [
    `📍 Sector: ${zone}.`,
    `🛰️ Orden: ${kindLine}`,
    `☁️ Meteo: ${meteo}.`,
    `⚠️ Amenaza estimada: ${threat}.`,
  ].join("\n");
}

function buildDebrief(report){
  const s = report.stats || {};
  const lineKills = (s.kills ?? 0) > 0 ? `Derribos confirmados: ${s.kills}.` : "Sin derribos confirmados.";
  const lineLosses = (s.losses ?? 0) > 0 ? `Pérdidas: ${s.losses} (${(s.lossCauses && s.lossCauses.length) ? s.lossCauses.join(", ") : "—"}).` : "Sin pérdidas.";
  const lineDmg = (s.damageTotal ?? 0) > 0 ? `Daño total registrado: ${s.damageTotal}%.` : "Daños mínimos.";
  const lineFuel = (s.fuelUsed == null) ? "" : `Fuel consumido: ${s.fuelUsed}%.`;
  const lineAmmo = (s.ammoUsed == null) ? "" : `Munición consumida: ${s.ammoUsed}%.`;
  const linePts  = (s.pointsDelta == null) ? "" : `Puntos obtenidos: +${s.pointsDelta}.`;

  return [
    outcomeLabel(report.outcome),
    lineKills,
    lineLosses,
    lineDmg,
    lineFuel,
    lineAmmo,
    linePts
  ].filter(Boolean).join("\n");
}

function finalizeMissionReport(m, outcome, details){
  game.missionHistory = game.missionHistory || [];

  const createdAt = now();
  const startedAt = m.startAt || m.createdAt || createdAt;

  const report = {
    id: `R${createdAt}_${m.id}`,
    missionId: m.id,
    title: m.name || "Misión",
    squadId: m.assignedSquadronId ?? null,
    outcome,
    createdAt,
    startedAt,
    endedAt: createdAt,
    briefing: m.briefing || buildBriefing(m),
    events: details.events || [],
    stats: {
      kills: details.kills ?? 0,
      losses: details.losses ?? 0,
      lossCauses: details.lossCauses ?? [],
      damageTotal: details.damageTotal ?? 0,
      fuelUsed: details.fuelUsed ?? null,
      ammoUsed: details.ammoUsed ?? null,
      pointsDelta: details.pointsDelta ?? 0,
    },
  };

  report.debrief = buildDebrief(report);

  game.missionHistory.unshift(report);
  game.missionHistory = game.missionHistory.slice(0, 50);
}

/* =========================
   MISSION GENERATION
   ✅ NUEVO: si pasas ctx (localidad+objetivo), la misión queda dirigida
========================= */
export function generateMission(ctx = null){
  const types = [
    {key:"PATROL",    name:"Patrulla costera", baseMin:2, baseMax:4, reward:[10,16], fatigue:[6,12]},
    {key:"INTERCEPT", name:"Intercepción",     baseMin:2, baseMax:5, reward:[12,20], fatigue:[10,18]},
    {key:"ESCORT",    name:"Escolta corta",    baseMin:3, baseMax:5, reward:[11,18], fatigue:[8,16]},
    {key:"SCRAMBLE",  name:"Alerta rápida",    baseMin:2, baseMax:4, reward:[11,19], fatigue:[10,18]},
  ];

  const pickType = types[Math.floor(Math.random()*types.length)];
  const durMin = pickType.baseMin + Math.floor(Math.random()*(pickType.baseMax-pickType.baseMin+1));
  const durationMs = durMin * 60 * 1000;
  const requiredPlanes = [3,4,5][Math.floor(Math.random()*3)];

  // ✅ campaña dirigida
  const localityId  = ctx?.localityId ?? null;
  const objectiveId = ctx?.objectiveId ?? null;
  const L = localityId ? (game.campaign?.localities?.[localityId] ?? null) : null;
  const obj = (L && objectiveId) ? (L.objectives ?? []).find(o=>o.id===objectiveId) : null;

  const def = (L?.airDefenseLevel ?? "MED");
  let riskBonus = 0;
  let rewardBonus = 0;
  if(def==="LOW"){ riskBonus=-0.01; rewardBonus=0; }
  else if(def==="MED"){ riskBonus=0.00; rewardBonus=0; }
  else if(def==="HIGH"){ riskBonus=+0.03; rewardBonus=+1; }
  else if(def==="VERY_HIGH"){ riskBonus=+0.06; rewardBonus=+2; }

  const mission = {
    id: crypto.randomUUID?.() ?? (Math.random().toString(16).slice(2)),
    typeKey: pickType.key,
    name: pickType.name,
    createdAt: now(),
    startAt: null,
    endAt: null,
    durationMs,
    rewardMin: pickType.reward[0] + rewardBonus,
    rewardMax: pickType.reward[1] + rewardBonus,
    fatigueMin: pickType.fatigue[0],
    fatigueMax: pickType.fatigue[1],
    requiredPlanes,
    assignedSquadronId: null,
    assignedSlotIds: [],
    state: "PENDING",

    zone: null,
    weather: null,
    threat: null,
    briefing: null,
    events: [],

    // ✅ link campaña
    localityId,
    objectiveId,
    objectiveType: obj?.type ?? null,
    defenseLevel: def,
    riskBonus
  };

  const locName = L?.name ?? null;
  const objName = obj?.name ?? null;
  const objType = obj?.type ?? null;

  const kindLine =
    mission.typeKey==="INTERCEPT" ? "Interceptación urgente." :
    mission.typeKey==="SCRAMBLE" ? "Scramble inmediato." :
    mission.typeKey==="ESCORT" ? "Escolta asignada." :
    "Patrulla CAP.";

  // Si hay selección de campaña, briefing “dirigido”; si no, usa el briefing clásico.
  mission.briefing = (locName || objName)
    ? [
        locName ? `🗺️ Localidad: ${locName}.` : null,
        objName ? `🎯 Objetivo: ${objName}${objType ? ` (${objType})` : ""}.` : null,
        `🛰️ Orden: ${kindLine}`,
        `🛡️ Defensa estimada: ${def}.`
      ].filter(Boolean).join("\n")
    : buildBriefing(mission);

  return mission;
}

export function missionRisk(typeKey, bonus=0){
  let base = 0.12;
  if(typeKey==="INTERCEPT") base = 0.20;
  if(typeKey==="SCRAMBLE")  base = 0.16;
  if(typeKey==="ESCORT")    base = 0.12;
  if(typeKey==="PATROL")    base = 0.08;
  return clamp(base + (bonus ?? 0), 0.01, 0.95);
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
  const base = missionRisk(mission.typeKey, mission.riskBonus ?? 0);
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

  const events = [];
  const lossCauses = [];
  let damageTotal = 0;

  const fuelSpent = fuelCostForMission(m.typeKey);
  const ammoSpent = ammoCostForMission(m.typeKey);

  events.push(`Despegue completado. Escuadrón SQ ${m.assignedSquadronId}.`);
  events.push(`Consumo estimado por aparato: Fuel -${fuelSpent}% • Ammo -${ammoSpent}%.`);

  for(const slotId of m.assignedSlotIds){
    const s = slotById(slotId);
    if(!s) continue;
    const p = pilotById(s.pilotId);
    const pilotName = p ? p.name : "Piloto desconocido";

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
      events.push(`Derribo confirmado: ${pilotName} (★).`);
    }

    const out = resolveSlotOutcome(s, p, m);
    if(out.damage > 0){
      damagedCount++;
      damageTotal += out.damage;
      events.push(`${s.callsign} vuelve con daños (${out.damage}%).`);
    }

    if(out.lostPlane){
      lostCount++;
      s.state = "LOST";
      s.condition = 0; s.fuel = 0; s.ammo = 0;
      s.service = null;
      s.pendingService = null;

      const why = (out.lossReason==="COMBAT") ? "eliminado en combate"
                : (out.lossReason==="ACCIDENT") ? "accidente mecánico"
                : (out.lossReason==="FUEL") ? "falta de combustible"
                : "causa desconocida";

      lossCauses.push(out.lossReason || "UNKNOWN");

      if(p){
        if(out.pilotDown){
          p.alive = false;
          pushLog(`✖️ ${s.callsign} no regresa: ${why}. ${pilotName} KIA/MIA.`);
          events.push(`✖️ ${s.callsign} perdido (${why}). ${pilotName} KIA/MIA.`);
        } else {
          p.fatigue = clamp((p.fatigue ?? 0) + 20, 0, 100);
          pushLog(`⚠️ ${s.callsign} perdido: ${why}. ${pilotName} vuelve (rescate).`);
          events.push(`⚠️ ${s.callsign} perdido (${why}). ${pilotName} rescatado.`);
        }
      } else {
        pushLog(`✖️ ${s.callsign} perdido: ${why}.`);
        events.push(`✖️ ${s.callsign} perdido (${why}).`);
      }
      continue;
    }

    s.state = "READY";
    s.service = null;
  }

  if(lostCount > 0){
    reward = Math.max(1, Math.floor(reward * (1 - 0.20*lostCount)));
    events.push(`Penalización por pérdidas aplicada. Recompensa ajustada.`);
  }

  game.points += reward;
  m.state = "DONE";

  const extra = [];
  if(totalKills>0) extra.push(`Derribos +${totalKills}`);
  if(damagedCount>0) extra.push(`Daños: ${damagedCount}`);
  if(lostCount>0) extra.push(`Pérdidas: ${lostCount}`);

  pushLog(`Misión completada: +${reward} pts. Fuel -${fuelSpent} • Ammo -${ammoSpent}.${extra.length ? " ("+extra.join(" • ")+")" : ""}`);

  finalizeMissionReport(m, "SUCCESS", {
    kills: totalKills,
    losses: lostCount,
    lossCauses,
    damageTotal: clamp(Math.round(damageTotal), 0, 999),
    fuelUsed: fuelSpent,
    ammoUsed: ammoSpent,
    pointsDelta: reward,
    events
  });

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
