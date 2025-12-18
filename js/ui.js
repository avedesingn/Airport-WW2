import { game, saveGame, hardReset, pilotById, slotById } from "./state.js";
import {
  MISSION_GEN_COST, BUY_PILOT_COST, BUY_PLANE_COST,
  HIRE_ARMORER_COST, HIRE_FUELER_COST, HIRE_MECHANIC_COST,
  SQUAD_COLORS, SQUAD_IDS
} from "./constants.js";
import { fmtClock, fmtTime, clamp } from "./utils.js";
import { fatigueState, pilotPlane, pilotResting, pilotInMission, startPilotRest } from "./pilots.js";
import {
  busyCount, freeCrew, queueCount, startOrQueueService, cancelPending,
  serviceFuelMins, serviceFuelCost, serviceAmmoMins, serviceAmmoCost, serviceMaintMins, serviceMaintCost
} from "./services.js";
import { generateMission, findEligibleSquads, assignMissionToSquad, canLaunch, missionRisk, spendForNewMission } from "./missions.js";

/* =========================
   PLANE IMAGES (by model)
========================= */
const PLANE_IMG_BY_MODEL = {
  "Spitfire Mk.I": "assets/planes/spitfire-mk1.png",
  // Futuro:
  // "Hurricane Mk.I": "assets/planes/hurricane-mk1.png",
};
const PLANE_IMG_FALLBACK = "assets/planes/spitfire-mk1.png";
function planeImgForModel(model){
  return PLANE_IMG_BY_MODEL[model] ?? PLANE_IMG_FALLBACK;
}

/* Render flags */
let needsSlotsRender = true;
let needsPilotsRender = true;

/* Log */
export function pushLog(msg){
  game.log.unshift({t: Date.now(), msg});
  game.log = game.log.slice(0, 200);
}

function isInteractingWithSelect(){
  const a = document.activeElement;
  return a && a.tagName === "SELECT";
}

function stateByValue(v){
  if(v >= 70) return {txt:"Alto", cls:"good"};
  if(v >= 45) return {txt:"Medio", cls:"warn"};
  if(v >= 20) return {txt:"Bajo", cls:"warn2"};
  return {txt:"Crítico", cls:"bad"};
}
function starString(kills){
  const k = kills ?? 0;
  let n = 0;
  if(k >= 20) n = 5;
  else if(k >= 10) n = 4;
  else if(k >= 5) n = 2;
  else if(k >= 1) n = 1;
  return n ? "★".repeat(n) : "";
}

/* Modal */
const modalMask = ()=>document.getElementById("modalMask");
const modalClose = ()=>document.getElementById("modalClose");
const modalTitle = ()=>document.getElementById("modalTitle");
const modalSubtitle = ()=>document.getElementById("modalSubtitle");
const modalBody = ()=>document.getElementById("modalBody");

let pendingAssignMissionId = null;

function openModal(){ modalMask().style.display="flex"; modalMask().setAttribute("aria-hidden","false"); }
function closeModal(){ pendingAssignMissionId=null; modalMask().style.display="none"; modalMask().setAttribute("aria-hidden","true"); }

function openSquadModal(mission){
  pendingAssignMissionId = mission.id;
  modalTitle().textContent = "Asignar escuadrón";
  modalSubtitle().textContent = `“${mission.name}” requiere mínimo ${mission.requiredPlanes}. Elige escuadrón:`;
  modalBody().innerHTML = "";

  const eligible = findEligibleSquads(mission.requiredPlanes);
  if(eligible.length === 0){
    const msg = document.createElement("div");
    msg.className="muted";
    msg.style.fontSize="12px";
    msg.textContent="No hay escuadrón válido (pilotos descansando, fatiga alta, fuel/ammo/condición insuficiente).";
    modalBody().appendChild(msg);
  } else {
    for(const sqId of eligible){
      const meta = SQUAD_COLORS[sqId] ?? SQUAD_COLORS[0];
      const ready = game.slots.filter(s => (s.squadronId ?? 0) === sqId && canLaunch(s).ok).length;

      const row = document.createElement("div");
      row.className="choice sqChoice";
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px">
          <span class="sqDot" style="background:${meta.color}"></span>
          <div>
            <div style="font-weight:700;font-size:13px">${meta.name} (SQ ${sqId})</div>
            <div class="muted" style="font-size:12px">Listos: <b>${ready}</b></div>
          </div>
        </div>
        <button class="primary">Asignar</button>
      `;
      row.addEventListener("click", ()=>{
        assignMissionToSquad(pendingAssignMissionId, sqId);
        saveGame();
        renderAll(true);
        closeModal();
      });
      modalBody().appendChild(row);
    }
  }
  openModal();
}

/* Shop */
function randomPilotName(){
  const a = ["P/O","F/O","Sgt.","F/Lt","Plt Off.","Cpl."];
  const b = ["Baker","Hughes","Turner","Scott","Morgan","Ward","Foster","Reed","Howard","Price","Collins","Parker"];
  return `${a[Math.floor(Math.random()*a.length)]} ${b[Math.floor(Math.random()*b.length)]}`;
}
function buyPilot(){
  if(game.points < BUY_PILOT_COST) return false;
  game.points -= BUY_PILOT_COST;
  const skill = [1,1,2,2,3][Math.floor(Math.random()*5)];
  const p = {
    id: crypto.randomUUID?.() ?? (Math.random().toString(16).slice(2)),
    name:randomPilotName(), role:"Fighter", skill, fatigue:Math.floor(Math.random()*16),
    alive:true, missions:0, kills:0, rest:{active:false}
  };
  game.pilots.push(p);
  pushLog(`✅ Reclutado: ${p.name} (Skill ${p.skill}). -${BUY_PILOT_COST} pts.`);
  needsPilotsRender = true;
  return true;
}
function buyPlane(){
  if(game.points < BUY_PLANE_COST) return false;
  game.points -= BUY_PLANE_COST;

  const callsign = `Red-${game.slots.length + 1}`;
  const s = {
    id: crypto.randomUUID?.() ?? (Math.random().toString(16).slice(2)),
    callsign,
    model:"Spitfire Mk.I",
    ammo:100,
    fuel:100,
    condition:100,
    state:"READY",
    service:null,
    pendingService:null,
    pilotId:null,
    squadronId: 0
  };
  game.slots.push(s);
  needsSlotsRender = true;
  pushLog(`✅ Nuevo avión adquirido: ${callsign}. -${BUY_PLANE_COST} pts.`);
  return true;
}
function hire(kind){
  if(kind==="FUEL"){
    if(game.points < HIRE_FUELER_COST) return false;
    game.points -= HIRE_FUELER_COST;
    game.crew.fuelers++;
    pushLog(`👷 Contratado Fueler. -${HIRE_FUELER_COST} pts. (Total: ${game.crew.fuelers})`);
    return true;
  }
  if(kind==="MAINT"){
    if(game.points < HIRE_MECHANIC_COST) return false;
    game.points -= HIRE_MECHANIC_COST;
    game.crew.mechanics++;
    pushLog(`🧰 Contratado Mecánico. -${HIRE_MECHANIC_COST} pts. (Total: ${game.crew.mechanics})`);
    return true;
  }
  if(kind==="AMMO"){
    if(game.points < HIRE_ARMORER_COST) return false;
    game.points -= HIRE_ARMORER_COST;
    game.crew.armorers++;
    pushLog(`🔫 Contratado Armero. -${HIRE_ARMORER_COST} pts. (Total: ${game.crew.armorers})`);
    return true;
  }
  return false;
}

function openShopModal(){
  modalTitle().textContent = "Reclutar / Comprar / Contratar";
  modalSubtitle().textContent = "Gasta puntos para ampliar la base: pilotos, aviones y personal de tierra.";
  modalBody().innerHTML = "";

  const crewInfo = document.createElement("div");
  crewInfo.className = "choice";
  crewInfo.innerHTML = `
    <div>
      <div style="font-weight:900">Personal actual</div>
      <div class="muted" style="font-size:12px">
        Fuelers: <b>${game.crew.fuelers}</b> (ocupados ${busyCount("FUEL")}) •
        Mecánicos: <b>${game.crew.mechanics}</b> (ocupados ${busyCount("MAINT")}) •
        Armeros: <b>${game.crew.armorers}</b> (ocupados ${busyCount("AMMO")})
      </div>
    </div>
    <span class="pill">Colas: ⛽ ${queueCount("FUEL")} • 🛠️ ${queueCount("MAINT")} • 🔫 ${queueCount("AMMO")}</span>
  `;
  modalBody().appendChild(crewInfo);

  const blocks = [
    { title:"Reclutar piloto", desc:"Crea una ficha de piloto (luego lo asignas a un avión libre).", cost: BUY_PILOT_COST, id:"buyPilotBtn",
      action: ()=>{ buyPilot(); saveGame(); renderAll(true); openShopModal(); } },
    { title:"Comprar avión", desc:"Añade un avión nuevo SIN piloto.", cost: BUY_PLANE_COST, id:"buyPlaneBtn",
      action: ()=>{ buyPlane(); saveGame(); renderAll(true); openShopModal(); } },
    { title:"Contratar Fueler (⛽)", desc:"Permite más repostajes simultáneos.", cost: HIRE_FUELER_COST, id:"hireFuelBtn",
      action: ()=>{ hire("FUEL"); saveGame(); renderAll(true); openShopModal(); } },
    { title:"Contratar Mecánico (🧰)", desc:"Permite más mantenimientos simultáneos.", cost: HIRE_MECHANIC_COST, id:"hireMechBtn",
      action: ()=>{ hire("MAINT"); saveGame(); renderAll(true); openShopModal(); } },
    { title:"Contratar Armero (🔫)", desc:"Permite más municionados simultáneos.", cost: HIRE_ARMORER_COST, id:"hireArmBtn",
      action: ()=>{ hire("AMMO"); saveGame(); renderAll(true); openShopModal(); } },
  ];

  for(const b of blocks){
    const c = document.createElement("div");
    c.className = "choice";
    c.innerHTML = `
      <div>
        <div style="font-weight:800">${b.title}</div>
        <div class="muted" style="font-size:12px">${b.desc}</div>
      </div>
      <div class="smallBtnRow">
        <span class="pill">Coste: <b>${b.cost}</b></span>
        <button class="primary" id="${b.id}" ${game.points < b.cost ? "disabled":""}>${b.title.startsWith("Contratar") ? "Contratar" : "Comprar"}</button>
      </div>
    `;
    modalBody().appendChild(c);
  }

  openModal();
  blocks.forEach(b=>{
    document.getElementById(b.id)?.addEventListener("click", b.action);
  });
}

/* Header render */
function renderHeader(){
  document.getElementById("points").textContent = Math.floor(game.points);
  document.getElementById("clock").textContent = fmtClock();
  document.getElementById("missionCostLabel").textContent = MISSION_GEN_COST;

  document.getElementById("btnNewMission").disabled = game.points < MISSION_GEN_COST;
  document.getElementById("pilotAliveCount").textContent = game.pilots.filter(p=>p.alive).length;
  document.getElementById("planeCount").textContent = game.slots.length;

  document.getElementById("fuelersLabel").textContent = `${busyCount("FUEL")}/${game.crew.fuelers}`;
  document.getElementById("mechanicsLabel").textContent = `${busyCount("MAINT")}/${game.crew.mechanics}`;
  document.getElementById("armorersLabel").textContent = `${busyCount("AMMO")}/${game.crew.armorers}`;

  document.getElementById("qFuel").textContent = queueCount("FUEL");
  document.getElementById("qMaint").textContent = queueCount("MAINT");
  document.getElementById("qAmmo").textContent = queueCount("AMMO");

  document.querySelectorAll(".tabBtn").forEach(b=>{
    b.classList.toggle("active", b.dataset.tab === game.ui.tab);
  });
  document.getElementById("tabPlanes").classList.toggle("active", game.ui.tab==="PLANES");
  document.getElementById("tabPilots").classList.toggle("active", game.ui.tab==="PILOTS");
}

/* Slot status */
function slotStatus(slot){
  if(slot.state==="READY" && slot.pendingService){
    const k = slot.pendingService.kind;
    if(k==="FUEL") return {txt:"En cola", cls:"warn"};
    if(k==="AMMO") return {txt:"En cola", cls:"warn"};
    if(k==="MAINT")return {txt:"En cola", cls:"warn2"};
  }
  if(slot.state==="READY")   return {txt:"Disponible", cls:"good"};
  if(slot.state==="MISSION") return {txt:"En misión", cls:"warn"};
  if(slot.state==="SERVICE"){
    const k = slot.service?.kind;
    if(k==="FUEL") return {txt:"Repostando", cls:"warn"};
    if(k==="AMMO") return {txt:"Municionando", cls:"warn"};
    if(k==="MAINT")return {txt:"Mantenimiento", cls:"warn2"};
    return {txt:"En servicio", cls:"warn"};
  }
  if(slot.state==="LOST")    return {txt:"Perdido", cls:"bad"};
  return {txt:"—", cls:""};
}

function slotNeeds(slot){
  return {
    fuel: (slot.fuel ?? 0) < 100,
    ammo: (slot.ammo ?? 0) < 100,
    maint:(slot.condition ?? 0) < 100
  };
}

/* =========================
   Render Slots (por escuadrón + en filas)
========================= */
function renderSlots(){
  const el = document.getElementById("slots");
  el.innerHTML = "";

  // agrupar por squad
  const bySquad = new Map();
  for(const s of game.slots){
    const sq = (s.squadronId ?? 0);
    if(!bySquad.has(sq)) bySquad.set(sq, []);
    bySquad.get(sq).push(s);
  }

  const squadIds = Array.from(bySquad.keys()).sort((a,b)=>a-b);

  for(const sqId of squadIds){
    const list = bySquad.get(sqId)
      .slice()
      .sort((a,b)=>String(a.callsign).localeCompare(String(b.callsign),"es"));

    const meta = SQUAD_COLORS[sqId] ?? SQUAD_COLORS[0];

    // stats de escuadrón
    const total = list.length;
    const ready = list.filter(s=>s.state==="READY").length;
    const inMission = list.filter(s=>s.state==="MISSION").length;
    const inService = list.filter(s=>s.state==="SERVICE").length;
    const queued = list.filter(s=>s.pendingService).length;
    const lost = list.filter(s=>s.state==="LOST").length;

    const squadBlock = document.createElement("div");
    squadBlock.className = "squadBlock";
    squadBlock.style.setProperty("--sq-color", meta.color);

    squadBlock.innerHTML = `
      <div class="squadHeader" style="--sq-color:${meta.color}">
        <div>
          <div class="squadTitle">${meta.name} — SQ ${sqId}</div>
          <div class="squadSub">
            Aviones: <b>${total}</b> • Listos: <b>${ready}</b> • En misión: <b>${inMission}</b> • Servicio: <b>${inService}</b> • Cola: <b>${queued}</b> • Perdidos: <b>${lost}</b>
          </div>
        </div>
        <div class="squadRight">
          <span class="sqBadge" style="border-color:${meta.color}; background:${meta.badge}; color:#eaf2ff;">SQ ${sqId}</span>
        </div>
      </div>
      <div class="squadList"></div>
    `;

    const squadList = squadBlock.querySelector(".squadList");

    for(const s of list){
      const p = pilotById(s.pilotId);
      const st = slotStatus(s);

      const fat = p ? fatigueState(p.fatigue ?? 0) : {txt:"—", cls:"bad"};
      const fuelState = stateByValue(s.fuel ?? 0);
      const condState = stateByValue(s.condition ?? 0);
      const ammoState = stateByValue(s.ammo ?? 0);

      const kills = p ? (p.kills ?? 0) : 0;
      const stars = p ? starString(kills) : "";

      const needs = slotNeeds(s);
      const needTags = [];
      if(s.state!=="LOST"){
        if(needs.fuel) needTags.push(`<span class="needTag">⛽ Necesita fuel</span>`);
        if(needs.ammo) needTags.push(`<span class="needTag">🔫 Necesita munición</span>`);
        if(needs.maint)needTags.push(`<span class="needTag">🛠️ Necesita reparación</span>`);
      }

      const serviceBlocked = (s.state==="MISSION" || s.state==="LOST" || s.state==="SERVICE");

      const removeAllowed = (s.state === "LOST") && (!p || !p.alive);
      const removeBtn = removeAllowed
        ? `<button class="danger" data-act="removeLost" data-id="${s.id}">Eliminar ficha</button>`
        : "";

      const fuelM = serviceFuelMins(s.fuel), fuelC = serviceFuelCost(s.fuel);
      const ammoM = serviceAmmoMins(s.ammo), ammoC = serviceAmmoCost(s.ammo);
      const mainM = serviceMaintMins(s.condition), mainC = serviceMaintCost(s.condition);

      // bloque de progreso servicio (si está en servicio)
      let svcBlock = "";
      if(s.state === "SERVICE" && s.service?.start && s.service?.end){
        const totalMs = s.service.end - s.service.start;
        const left = s.service.end - Date.now();
        const done = clamp(1 - (left/totalMs), 0, 1);
        const k = s.service.kind;
        const label = (k==="FUEL") ? "Repostaje" : (k==="AMMO") ? "Munición" : "Mantenimiento";
        svcBlock = `
          <div class="miniBarWrap">
            <div class="miniBarRow">
              <div class="muted">${label}</div>
              <div class="pill">⏱️ <span data-svc-time="${s.id}">${fmtTime(left)}</span></div>
            </div>
            <div class="bar"><i data-svc-bar="${s.id}" style="width:${Math.round(done*100)}%"></i></div>
            <div class="muted" style="font-size:11px;margin-top:6px">Coste: <b>${s.service.cost}</b> pts</div>
          </div>
        `;
      }

      // bloque de cola (si tiene pendiente)
      let pendingBlock = "";
      if(s.pendingService){
        const ps = s.pendingService;
        const label = (ps.kind==="FUEL") ? "Repostaje" : (ps.kind==="AMMO") ? "Munición" : "Mantenimiento";
        pendingBlock = `
          <div class="miniBarWrap">
            <div class="miniBarRow">
              <div class="muted">${label} (cola)</div>
              <div class="pill">Reserva: <b>${ps.cost}</b> pts</div>
            </div>
            <div class="muted" style="font-size:11px">
              En cola • Tiempo estimado: ${ps.mins} min • Cola actual: <b>${queueCount(ps.kind)}</b>
            </div>
            <div style="margin-top:8px">
              <button class="danger" data-act="cancelQueue" data-id="${s.id}">Cancelar cola</button>
            </div>
          </div>
        `;
      }

      const pilotText = p ? `${p.name} (Skill ${p.skill})` : "—";
      const imgSrc = planeImgForModel(s.model);

      const div = document.createElement("div");
      div.className = "slot";
      div.style.setProperty("--sq-color", meta.color);

      div.innerHTML = `
        <div class="slotRow">
          <img class="planeThumb" src="${imgSrc}" alt="${s.model}" loading="lazy"
            onerror="this.onerror=null;this.src='${PLANE_IMG_FALLBACK}'">

          <div class="slotMain">
            <div class="slotHeadLine">
              <div>
                <div class="slotName">${s.callsign}</div>
                <div class="slotMeta">
                  ${s.model} • Piloto: <b>${pilotText}</b><br>
                  Misiones: <b>${p ? (p.missions ?? 0) : "—"}</b> • Derribos: <b>${p ? kills : "—"}</b>
                  ${stars ? `<span class="stars"> ${stars}</span>` : ``}
                </div>
              </div>

              <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
                <div class="status ${st.cls}">${st.txt}</div>
              </div>
            </div>

            ${needTags.length ? `<div class="needsLine">${needTags.join("")}</div>` : ``}
          </div>

          <div class="slotActions">
            <button class="primary" data-act="svcFuel" data-id="${s.id}"
              ${((s.fuel??0)<100 && !serviceBlocked && !s.pendingService) ? "" : "disabled"}>
              ⛽ Repostar (${fuelM}m · ${fuelC})
            </button>

            <button class="primary" data-act="svcAmmo" data-id="${s.id}"
              ${((s.ammo??0)<100 && !serviceBlocked && !s.pendingService) ? "" : "disabled"}>
              🔫 Municionar (${ammoM}m · ${ammoC})
            </button>

            <button data-act="svcMaint" data-id="${s.id}"
              ${((s.condition??0)<100 && !serviceBlocked && !s.pendingService) ? "" : "disabled"}>
              🛠️ Mantenimiento (${mainM}m · ${mainC})
            </button>

            ${removeBtn}
          </div>
        </div>

        <details class="slotDetails" ${svcBlock || pendingBlock ? "open" : ""}>
          <summary>
            <span>Detalles</span>
            <span class="pill">Fatiga: <b ${p ? `data-fatigue-val="${p.id}"` : ""} class="${p ? `state ${fat.cls}` : ""}">${p ? Math.round(p.fatigue ?? 0) : "—"}</b></span>
          </summary>

          <div class="detailsBody">
            ${(svcBlock || pendingBlock) ? `<div>${svcBlock}${pendingBlock ? `<div class="hr"></div>${pendingBlock}` : ""}</div>` : ""}

            <div class="kv">
              <div>
                <div class="k">Escuadrón</div>
                <div class="v">
                  <select data-act="setSquad" data-id="${s.id}" ${serviceBlocked ? "disabled" : ""}>
                    ${SQUAD_IDS.map(n => `<option value="${n}" ${n===(s.squadronId??0)?"selected":""}>SQ ${n}</option>`).join("")}
                  </select>
                </div>
              </div>

              <div>
                <div class="k">Fatiga piloto</div>
                <div class="v">
                  <b ${p ? `data-fatigue-val="${p.id}"` : ""} class="${p ? `state ${fat.cls}` : ""}">${p ? Math.round(p.fatigue ?? 0) : "—"}</b>
                  ${p ? ` • <span data-fatigue-txt="${p.id}" class="state ${fat.cls}"><b>${fat.txt}</b></span>` : ``}
                  ${p && pilotResting(p) ? ` • <span class="pill tagRest">😴 descansando</span>` : ``}
                </div>
              </div>

              <div>
                <div class="k">Condición</div>
                <div class="v"><b class="state ${condState.cls}">${s.condition}</b>/100 • <span class="state ${condState.cls}"><b>${condState.txt}</b></span></div>
              </div>

              <div>
                <div class="k">Combustible</div>
                <div class="v"><b class="state ${fuelState.cls}">${s.fuel}</b>/100 • <span class="state ${fuelState.cls}"><b>${fuelState.txt}</b></span></div>
              </div>

              <div>
                <div class="k">Munición</div>
                <div class="v"><b class="state ${ammoState.cls}">${s.ammo}</b>/100 • <span class="state ${ammoState.cls}"><b>${ammoState.txt}</b></span></div>
              </div>

              <div>
                <div class="k">Listo para misión</div>
                <div class="v muted" style="font-size:11px">
                  ${(()=>{
                    const c = canLaunch(s);
                    return c.ok ? "Sí (si su SQ es elegido)" : ("No: " + c.why);
                  })()}
                </div>
              </div>
            </div>

            <div class="muted" style="font-size:11px">
              Libres: ⛽ <b>${freeCrew("FUEL")}</b> • 🔫 <b>${freeCrew("AMMO")}</b> • 🛠️ <b>${freeCrew("MAINT")}</b>
            </div>
          </div>
        </details>
      `;

      squadList.appendChild(div);
    }

    el.appendChild(squadBlock);
  }

  // acciones botones
  el.querySelectorAll("button[data-act]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      const s = slotById(id);
      if(!s) return;

      if(act==="svcFuel")  startOrQueueService(s, "FUEL");
      if(act==="svcAmmo")  startOrQueueService(s, "AMMO");
      if(act==="svcMaint") startOrQueueService(s, "MAINT");
      if(act==="cancelQueue"){ cancelPending(s); }

      if(act==="removeLost"){
        const p = pilotById(s.pilotId);
        if(!(s.state==="LOST" && (!p || !p.alive))){
          pushLog("No puedes eliminar esta ficha todavía (piloto vivo o avión no perdido).");
          return;
        }
        game.slots = game.slots.filter(x=>x.id !== s.id);
        needsSlotsRender = true;
        pushLog(`🗑️ Ficha eliminada: ${s.callsign}.`);
      }

      saveGame();
      renderAll(true);
    });
  });

  // selector de escuadrón
  el.querySelectorAll("select[data-act='setSquad']").forEach(sel=>{
    sel.addEventListener("change", ()=>{
      const s = slotById(sel.dataset.id);
      if(!s) return;
      s.squadronId = Number(sel.value);
      needsSlotsRender = true;
      pushLog(`${s.callsign} asignado a SQ ${s.squadronId}.`);
      saveGame();
      renderAll(true);
    });
  });
}

/* Render Pilots (sin tocar) */
function renderPilots(){
  const el = document.getElementById("pilots");
  el.innerHTML = "";

  const sorted = [...game.pilots].sort((a,b)=>{
    const aa = a.alive ? 0 : 1;
    const bb = b.alive ? 0 : 1;
    if(aa !== bb) return aa - bb;
    return String(a.name).localeCompare(String(b.name), "es");
  });

  const availablePlanes = () => game.slots
    .filter(s => s.state !== "LOST" && (s.pilotId == null) && s.state !== "MISSION")
    .sort((a,b)=>String(a.callsign).localeCompare(String(b.callsign),"es"));

  for(const p of sorted){
    const fat = fatigueState(p.fatigue ?? 0);
    const kills = p.kills ?? 0;
    const stars = starString(kills);

    const plane = pilotPlane(p);
    const inMission = !!(plane && plane.state === "MISSION");
    const planeText = plane ? `${plane.callsign} (SQ ${plane.squadronId ?? 0})` : "Sin avión";

    let restBlock = "";
    if(p.rest?.active && p.rest.start && p.rest.end){
      const total = p.rest.end - p.rest.start;
      const left = p.rest.end - Date.now();
      const done = clamp(1 - (left/total), 0, 1);
      restBlock = `
        <div class="miniBarWrap">
          <div class="miniBarRow">
            <div class="muted">Descanso</div>
            <div class="pill">⏱️ <span data-prest-time="${p.id}">${fmtTime(left)}</span></div>
          </div>
          <div class="bar"><i data-prest-bar="${p.id}" style="width:${Math.round(done*100)}%"></i></div>
        </div>
      `;
    }

    const div = document.createElement("div");
    div.className = "pilot";

    const deadTag = !p.alive ? `<span class="pill tagDead">✖️ KIA/MIA</span>` : "";
    const restTag = (p.rest?.active) ? `<span class="pill tagRest">😴 descansando</span>` : "";
    const missionTag = (inMission) ? `<span class="pill" style="border-color:#2d4a70;background:#152236;color:#d7e6ff;">✈️ en misión</span>` : "";

    const planes = availablePlanes();

    const canAssign = p.alive && planes.length > 0 && !(p.rest?.active) && !inMission;
    const canRest = p.alive && !(p.rest?.active) && !inMission;
    const canUnassign = plane && p.alive && plane.state!=="MISSION" && !(p.rest?.active);

    div.innerHTML = `
      <div class="pilotTop">
        <div>
          <div class="pilotName">${p.name}</div>
          <div class="pilotMeta">
            Rol: <b>${p.role}</b> • Skill <b>${p.skill}</b><br>
            Avión: <b>${planeText}</b><br>
            Misiones: <b>${p.missions ?? 0}</b> • Derribos: <b>${kills}</b>
            ${stars ? `<span class="stars"> ${stars}</span>` : ``}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          ${deadTag}
          ${missionTag}
          ${restTag}
          <div class="pill">
            Fatiga:
            <b class="state ${fat.cls}" data-fatigue-val="${p.id}">${Math.round(p.fatigue ?? 0)}</b>
            <span class="state ${fat.cls}" data-fatigue-txt="${p.id}">${fat.txt}</span>
          </div>
        </div>
      </div>

      ${restBlock ? `<div class="hr"></div>${restBlock}` : ``}

      <div class="hr"></div>

      <div class="kv">
        <div>
          <div class="k">Asignar a avión libre</div>
          <div class="v">
            <select data-act="assignPilot" data-pilot="${p.id}" ${canAssign ? "" : "disabled"}>
              <option value="">${canAssign ? "Selecciona avión…" : (inMission ? "En misión (bloqueado)" : "No disponible")}</option>
              ${planes.map(s=>`<option value="${s.id}">${s.callsign} (SQ ${s.squadronId ?? 0})</option>`).join("")}
            </select>
          </div>
        </div>
        <div>
          <div class="k">Acciones</div>
          <div class="v" style="display:flex;gap:8px;flex-wrap:wrap">
            <button data-act="pilotRest" data-pilot="${p.id}" ${canRest ? "" : "disabled"}>😴 Descansar</button>
            <button data-act="unassignPilot" data-pilot="${p.id}" ${canUnassign ? "" : "disabled"}>Liberar avión</button>
          </div>
        </div>
      </div>
    `;
    el.appendChild(div);
  }

  el.querySelectorAll("select[data-act='assignPilot']").forEach(sel=>{
    sel.addEventListener("change", ()=>{
      const pilotId = sel.dataset.pilot;
      const planeId = sel.value;
      if(!planeId) return;

      const p = pilotById(pilotId);
      const s = slotById(planeId);
      if(!p || !s) return;

      if(!p.alive){ pushLog("No puedes asignar un piloto muerto."); sel.value=""; return; }
      if(p.rest?.active){ pushLog("No puedes asignar un piloto mientras descansa."); sel.value=""; return; }
      if(pilotInMission(p)){ pushLog("No puedes gestionar un piloto mientras está en misión."); sel.value=""; return; }
      if(s.pilotId != null){ pushLog("Ese avión ya tiene piloto."); sel.value=""; return; }
      if(s.state === "MISSION"){ pushLog("No puedes asignar un avión en misión."); sel.value=""; return; }

      const prev = game.slots.find(x=>x.pilotId === p.id);
      if(prev){
        if(prev.state === "MISSION"){ pushLog("No puedes reasignar un piloto mientras su avión está en misión."); sel.value=""; return; }
        prev.pilotId = null;
      }

      s.pilotId = p.id;
      pushLog(`👨‍✈️ ${p.name} asignado a ${s.callsign}.`);
      needsSlotsRender = true;
      needsPilotsRender = true;

      saveGame();
      renderAll(true);
    });
  });

  el.querySelectorAll("button[data-act]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const act = btn.dataset.act;
      const pilotId = btn.dataset.pilot;
      const p = pilotById(pilotId);
      if(!p) return;

      if(act==="pilotRest"){
        startPilotRest(p);
        saveGame();
        renderAll(true);
        return;
      }

      if(act==="unassignPilot"){
        if(pilotInMission(p)){ pushLog("No puedes liberar un avión en misión."); return; }
        const s = pilotPlane(p);
        if(!s) return;
        if(p.rest?.active){ pushLog("No puedes gestionar mientras el piloto descansa."); return; }
        s.pilotId = null;
        pushLog(`🔓 ${p.name} queda sin avión (liberado ${s.callsign}).`);
        needsSlotsRender = true;
        needsPilotsRender = true;

        saveGame();
        renderAll(true);
      }
    });
  });
}

/* Missions render (sin tocar) */
function renderMissions(){
  const elActive = document.getElementById("missionsActive");
  const elPending = document.getElementById("missionsPending");
  const elHistory = document.getElementById("missionsHistory");

  elActive.innerHTML = "";
  elPending.innerHTML = "";
  elHistory.innerHTML = "";

  const active = game.missions.filter(m=>m.state==="ACTIVE");
  const pending = game.missions.filter(m=>m.state==="PENDING");
  const done = game.missions.filter(m=>m.state==="DONE");

  document.getElementById("activeCount").textContent = active.length;
  document.getElementById("pendingCount").textContent = pending.length;
  document.getElementById("historyCount").textContent = done.length;

  for(const m of active.sort((a,b)=>a.endAt-b.endAt)){
    const div = document.createElement("div");
    div.className = "mission";

    const total = m.durationMs;
    const left = m.endAt - Date.now();
    const donePct = clamp(1 - (left/total), 0, 1);

    const sqMeta = SQUAD_COLORS[m.assignedSquadronId ?? 0] ?? SQUAD_COLORS[0];
    div.style.borderColor = sqMeta.color;

    div.innerHTML = `
      <div class="missionHead">
        <div>
          <div class="mName">${m.name}</div>
          <div class="mSmall">
            SQ <b>${m.assignedSquadronId}</b> • Aviones: <b>${m.assignedSlotIds.length}</b> • Recompensa: ${m.rewardMin}-${m.rewardMax} pts
          </div>
        </div>
        <div class="pill">⏱️ ${fmtTime(left)}</div>
      </div>
      <div style="margin-top:10px" class="bar"><i style="width:${Math.round(donePct*100)}%"></i></div>
      <div class="two">
        <div class="muted" style="font-size:11px">Fatiga: ${m.fatigueMin}-${m.fatigueMax} • Riesgo base: ${Math.round(missionRisk(m.typeKey)*100)}%</div>
        <div class="muted" style="font-size:11px;text-align:right">Progreso: <b>${Math.round(donePct*100)}%</b></div>
      </div>
    `;
    elActive.appendChild(div);
  }

  for(const m of pending.sort((a,b)=>b.createdAt-a.createdAt)){
    const div = document.createElement("div");
    div.className = "mission";
    const eligible = findEligibleSquads(m.requiredPlanes);

    div.innerHTML = `
      <div class="missionHead">
        <div>
          <div class="mName">${m.name}</div>
          <div class="mSmall">
            Duración: ${Math.round(m.durationMs/60000)} min • Requiere: <b>${m.requiredPlanes}</b> • Recompensa: ${m.rewardMin}-${m.rewardMax}
          </div>
        </div>
        <div class="btns">
          <button class="primary" data-act="assignSquad" data-id="${m.id}" ${eligible.length? "" : "disabled"}>Asignar SQ…</button>
          <button class="danger" data-act="rejectMission" data-id="${m.id}">Rechazar</button>
        </div>
      </div>
      <div class="muted" style="margin-top:10px;font-size:11px">
        ${eligible.length
          ? `Escuadrones válidos: ${eligible.map(sqId => `<b>SQ ${sqId}</b>`).join(", ")}`
          : `No hay escuadrón válido (pilotos descansando, fatiga alta, fuel/ammo/condición insuficiente).`}
      </div>
    `;
    elPending.appendChild(div);
  }

  for(const m of done.sort((a,b)=>b.endAt-a.endAt).slice(0,10)){
    const div = document.createElement("div");
    div.className = "mission";
    const sqMeta = SQUAD_COLORS[m.assignedSquadronId ?? 0] ?? SQUAD_COLORS[0];
    div.style.borderColor = sqMeta.color;

    div.innerHTML = `
      <div class="missionHead">
        <div>
          <div class="mName">${m.name}</div>
          <div class="mSmall">Hecha • SQ <b>${m.assignedSquadronId}</b> • Aviones: <b>${m.assignedSlotIds.length}</b></div>
        </div>
        <span class="pill">✅</span>
      </div>
    `;
    elHistory.appendChild(div);
  }

  document.querySelectorAll("button[data-act='assignSquad']").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const m = game.missions.find(x=>x.id===btn.dataset.id);
      if(!m) return;
      openSquadModal(m);
    });
  });

  document.querySelectorAll("button[data-act='rejectMission']").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.dataset.id;
      const idx = game.missions.findIndex(x=>x.id===id && x.state==="PENDING");
      if(idx === -1) return;
      const name = game.missions[idx].name;
      game.missions.splice(idx,1);
      pushLog(`Misión rechazada: “${name}”.`);
      saveGame();
      renderAll(false);
    });
  });
}

/* Log render */
function renderLog(){
  const el = document.getElementById("log");
  el.innerHTML = "";
  for(const item of game.log){
    const d = new Date(item.t);
    const hh = String(d.getHours()).padStart(2,"0");
    const mm = String(d.getMinutes()).padStart(2,"0");
    const p = document.createElement("p");
    p.innerHTML = `<span class="mono muted">[${hh}:${mm}]</span> ${item.msg}`;
    el.appendChild(p);
  }
}

/* Progress UI updates */
function updateProgressUI(){
  for(const s of game.slots){
    if(s.state === "SERVICE" && s.service?.start && s.service?.end){
      const total = s.service.end - s.service.start;
      const left = s.service.end - Date.now();
      const done = clamp(1 - (left/total), 0, 1);
      const timeEl = document.querySelector(`[data-svc-time="${s.id}"]`);
      const barEl  = document.querySelector(`[data-svc-bar="${s.id}"]`);
      if(timeEl) timeEl.textContent = fmtTime(left);
      if(barEl) barEl.style.width = `${Math.round(done*100)}%`;
    }
  }

  for(const p of game.pilots){
    if(p.rest?.active && p.rest.start && p.rest.end){
      const total = p.rest.end - p.rest.start;
      const left = p.rest.end - Date.now();
      const done = clamp(1 - (left/total), 0, 1);
      const timeEl = document.querySelector(`[data-prest-time="${p.id}"]`);
      const barEl  = document.querySelector(`[data-prest-bar="${p.id}"]`);
      if(timeEl) timeEl.textContent = fmtTime(left);
      if(barEl) barEl.style.width = `${Math.round(done*100)}%`;
    }
  }
}

/* Fatigue UI updates (sin re-render completo, para no cerrar <select>) */
function updateFatigueUI(){
  for(const p of game.pilots){
    if(!p?.alive) continue;
    const fat = fatigueState(p.fatigue ?? 0);

    const vals = document.querySelectorAll(`[data-fatigue-val="${p.id}"]`);
    const txts = document.querySelectorAll(`[data-fatigue-txt="${p.id}"]`);

    vals.forEach(v=>{
      v.textContent = Math.round(p.fatigue ?? 0);
      v.className = `state ${fat.cls}`;
    });

    txts.forEach(t=>{
      t.textContent = fat.txt;
      t.className = `state ${fat.cls}`;
    });
  }
}

/* Public renderAll */
export function renderAll(forcePanel=false){
  renderHeader();
  renderMissions();
  renderLog();

  if(forcePanel){
    if(game.ui.tab==="PLANES"){ renderSlots(); needsSlotsRender=false; }
    else { renderPilots(); needsPilotsRender=false; }
  } else {
    if(!isInteractingWithSelect()){
      if(game.ui.tab==="PLANES"){
        if(needsSlotsRender){ renderSlots(); needsSlotsRender=false; }
      } else {
        if(needsPilotsRender){ renderPilots(); needsPilotsRender=false; }
      }
    }
  }

  updateProgressUI();
  updateFatigueUI();
}

/* Wire UI once */
export function wireUI(){
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("modalMask").addEventListener("click", (e)=>{ if(e.target===document.getElementById("modalMask")) closeModal(); });

  document.getElementById("btnShop").addEventListener("click", openShopModal);

  document.getElementById("btnSave").addEventListener("click", ()=>{
    saveGame();
    pushLog("Guardado.");
    renderAll(false);
  });

  document.getElementById("btnReset").addEventListener("click", ()=>{
    hardReset();
    pushLog("Reset realizado.");
    needsSlotsRender = true;
    needsPilotsRender = true;
    renderAll(true);
  });

  document.getElementById("btnNewMission").addEventListener("click", ()=>{
    if(!spendForNewMission()){
      pushLog("No tienes puntos suficientes para generar misión.");
      renderAll(false);
      return;
    }
    const m = generateMission();
    game.missions.unshift(m);
    pushLog(`Nueva misión: “${m.name}” (mín ${m.requiredPlanes}). Coste: -${MISSION_GEN_COST} pts.`);
    saveGame();
    renderAll(false);
  });

  document.querySelectorAll(".tabBtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const tab = btn.dataset.tab;
      if(tab === game.ui.tab) return;
      game.ui.tab = tab;
      needsSlotsRender = true;
      needsPilotsRender = true;
      saveGame();
      renderAll(true);
    });
  });
}
