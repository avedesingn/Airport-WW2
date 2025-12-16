export const now = () => Date.now();
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const chance = (p) => Math.random() < p;

export function uid(){
  return Math.random().toString(16).slice(2) + "-" + Math.random().toString(16).slice(2);
}
export function randInt(a,b){
  return a + Math.floor(Math.random()*(b-a+1));
}

export function fmtTime(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  const mm = String(Math.floor(s/60)).padStart(2,"0");
  const ss = String(s%60).padStart(2,"0");
  return `${mm}:${ss}`;
}
export function fmtClock(){
  const d = new Date();
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  const ss = String(d.getSeconds()).padStart(2,"0");
  return `${hh}:${mm}:${ss}`;
}
