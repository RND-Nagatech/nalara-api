import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Database } from '../../database/database.module';
import { SchedulesService } from './schedules.service';

@Injectable()
export class ScheduleRepeatWorker implements OnModuleInit,OnModuleDestroy {
  private readonly logger=new Logger(ScheduleRepeatWorker.name);
  private timer?:ReturnType<typeof setInterval>;
  private running?:Promise<void>;
  private stopped=false;
  constructor(private readonly db:Database,private readonly schedules:SchedulesService) {}
  onModuleInit() {this.timer=setInterval(()=>void this.run(),15*60_000);this.timer.unref();void this.run();}
  run() {
    if(this.stopped) return Promise.resolve();
    return this.running??=this.scan().catch(()=>{this.logger.warn({event:'schedule.repeat.scan_failed'});}).finally(()=>{this.running=undefined;});
  }
  private async scan() {
    const rows=await this.db.collection('schedules').find({status:'scheduled',recurrenceComplete:false,repeatEnd:{$exists:true},nextExpansionAt:{$lte:new Date()}}).sort({nextExpansionAt:1,_id:1}).limit(25).lean();
    const seen=new Set<string>();
    for(const row of rows) {
      if(this.stopped) break;
      const key=`${row.workspaceId}:${row.groupId??row._id}`;
      if(seen.has(key)) continue;
      seen.add(key);
      try {await this.schedules.expandRepeat(row._id);} catch {this.logger.warn({event:'schedule.repeat.expansion_failed'});}
    }
  }
  async onModuleDestroy() {
    this.stopped=true;if(this.timer)clearInterval(this.timer);
    if(!this.running)return;
    let timeout:ReturnType<typeof setTimeout>|undefined;
    await Promise.race([this.running,new Promise<void>(resolve=>{timeout=setTimeout(resolve,10_000);})]).finally(()=>{if(timeout)clearTimeout(timeout);});
  }
}
