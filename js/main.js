import { initGame, game, saveGame } from "./state.js";
import { wireUI, renderAll } from "./ui.js";
import { finishService, tryStartNextFromQueue } from "./services.js";
import { finishPilotRest, passiveFatigueRecovery } from "./pilots.js";
import { completeMission } from "./missions.js";

function tick(){
  const t = Date.now();
  const dt = t - game.lastTick;
  game.lastTick = t;

  // servicios terminados
  for(const s of game.slots){
    if(s.state==="SERVICE" && s.service?.end && t >= s.service.end){
      finishService(s);
    }
  }

  // descansos terminados
  for(const p of game.pilots){
    if(p.rest?.active && p.rest.end && t >= p.rest.end){
      finishPilotRest(p);
    }
  }

  // misiones terminadas
  for(const m of game.missions.filter(x=>x.state==="ACTIVE")){
    if(t >= m.endAt){
      completeMission(m);
    }
  }

  // arranques desde cola
  tryStartNextFromQueue("FUEL");
  tryStartNextFromQueue("MAINT");
  tryStartNextFromQueue("AMMO");

  // fatiga
  passiveFatigueRecovery(dt);

  // render
  renderAll(false);

  // autosave cada 10s aprox
  if(Math.floor(t/10000) !== Math.floor((t-dt)/10000)){
    saveGame();
  }
}

initGame();
wireUI();
renderAll(true);
setInterval(tick, 1000);
