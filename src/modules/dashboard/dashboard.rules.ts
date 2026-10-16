/** Convert local calendar boundaries independently, including DST transitions. */
export function dashboardDayWindow(now:Date, timezone:string) {
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const parts=(date:Date) => Object.fromEntries(formatter.formatToParts(date).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
  const local=parts(now);
  const midnight=(year:number,month:number,day:number) => {
    const wall=Date.UTC(year,month-1,day);
    let utc=wall;
    for (let attempt=0;attempt<4;attempt++) {
      const at=parts(new Date(utc));
      const offset=Date.UTC(at.year,at.month-1,at.day,at.hour,at.minute,at.second)-utc;
      const next=wall-offset;
      if (next===utc) break;
      utc=next;
    }
    return new Date(utc);
  };
  const tomorrow=new Date(Date.UTC(local.year,local.month-1,local.day+1));
  return {
    from:midnight(local.year,local.month,local.day),
    to:midnight(tomorrow.getUTCFullYear(),tomorrow.getUTCMonth()+1,tomorrow.getUTCDate()),
    localDate:`${local.year}-${String(local.month).padStart(2,'0')}-${String(local.day).padStart(2,'0')}`,
  };
}

export const dashboardPreviewLimit=3;
