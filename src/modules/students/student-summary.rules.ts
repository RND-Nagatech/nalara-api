/** Calendar boundaries are resolved independently, never by adding 24h in UTC. */
export function studentSummaryWindow(now:Date,timezone:string) {
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const parts=(date:Date)=>Object.fromEntries(formatter.formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  const local=parts(now),today=new Date(Date.UTC(local.year,local.month-1,local.day));
  const calendar=(offset:number)=>new Date(Date.UTC(local.year,local.month-1,local.day+offset));
  const midnight=(day:Date)=>{
    const wall=day.getTime(); let utc=wall;
    for(let attempt=0;attempt<4;attempt++) {
      const at=parts(new Date(utc));
      const next=wall-(Date.UTC(at.year,at.month-1,at.day,at.hour,at.minute,at.second)-utc);
      if(next===utc) break;
      utc=next;
    }
    return new Date(utc);
  };
  const mondayOffset=-((today.getUTCDay()+6)%7);
  return {
    weekStart:midnight(calendar(mondayOffset)),weekEnd:midnight(calendar(mondayOffset+7)),
    weekStartDate:calendar(mondayOffset).toISOString().slice(0,10),weekEndDate:calendar(mondayOffset+6).toISOString().slice(0,10),
    days:Array.from({length:7},(_,index)=>({
      date:calendar(index-6).toISOString().slice(0,10),
      at:index===6 ? now : new Date(midnight(calendar(index-5)).getTime()-1),
    })),
  };
}
