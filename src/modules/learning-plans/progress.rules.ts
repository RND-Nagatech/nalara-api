import { Target } from '../../database/entities';
export function progressFromTotals(sum:number,count:number) {
  return count ? Math.round(sum/count) : null;
}
// Canonical aggregation rule. Clients display this server result rather than independently calculating.
export function aggregateProgress(targets: Pick<Target,'status'|'progress'>[]) {
  const included=targets.filter(t=>t.status!=='archived' && t.status!=='cancelled');
  return {targetCount:included.length, progress:progressFromTotals(included.reduce((sum,t)=>sum+(t.status==='completed'?100:t.progress),0),included.length)};
}
