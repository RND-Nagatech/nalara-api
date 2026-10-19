import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Actor, IdPipe, Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { ScopedService } from '../../common/scoped.service';
import { NotificationDelivery } from './delivery.service';
import { NotificationDevicesService } from './notification-devices.service';
import { NotificationDeviceDto } from './notifications.dto';
import { NotificationEventsService } from './notification-events.service';
import { NotificationScheduler } from './notification-scheduler.service';
import { NotificationAudienceService } from './notification-audience.service';
import { NotificationDeliveryWorker } from './notification-delivery-worker.service';
import { AuthModule } from '../auth/auth.module';
@Injectable() export class NotificationsService {
  constructor(private readonly scope:ScopedService,private readonly delivery:NotificationDelivery) {}
  list(a:Principal,q:ListQuery) { return this.scope.list('notifications',a,q,{$or:[{recipientAccountId:{$exists:false}},{recipientAccountId:a._id}]}); }
  async read(a:Principal,id:string) { await this.scope.get('notifications',id,a); return this.scope.db.collection('notifications').findOneAndUpdate({_id:id,workspaceId:a.workspaceId,$or:[{recipientAccountId:{$exists:false}},{recipientAccountId:a._id}]},{$set:{readAt:new Date()}},{returnDocument: 'after'}).lean(); }
  async readAll(a:Principal) { const result=await this.scope.db.collection('notifications').updateMany({workspaceId:a.workspaceId,$or:[{recipientAccountId:{$exists:false}},{recipientAccountId:a._id}],readAt:{$exists:false}},{$set:{readAt:new Date()}}); return {updated:result.modifiedCount}; }
  async retry(a:Principal,id:string) {
    const record = await this.scope.get('notifications',id,a);
    if (record.deliveryStatus === 'failed' || record.deliveryStatus === 'pending') {
      await this.scope.db.connection.transaction(async session => {
        const result = await this.scope.db.collection('notifications').updateOne({_id:id,workspaceId:a.workspaceId,deliveryStatus:record.deliveryStatus},{$set:{deliveryStatus:'pending',...(record.deliveryStatus==='failed'?{deliveryAttempts:0}:{})},$unset:{deliveryNextAttemptAt:1}},{session});
        if (result.matchedCount) await this.scope.audit(a,'notification.delivery.retry_requested',id,session);
      });
    }
    await this.delivery.deliver(id);
    return this.scope.get('notifications',id,a);
  }
}
@ApiTags('Notifications') @ApiBearerAuth() @Controller('notifications') export class NotificationsController {
  constructor(private readonly service:NotificationsService,private readonly devices:NotificationDevicesService) {}
  @Get() list(@Actor() a:Principal,@Query() q:ListQuery) { return this.service.list(a,q); }
  @Patch(':id/read') read(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.service.read(a,id); }
  @Post('read-all') @HttpCode(200) readAll(@Actor() a:Principal) { return this.service.readAll(a); }
  @Post('devices') @HttpCode(200) registerDevice(@Actor() a:Principal,@Body() dto:NotificationDeviceDto) { return this.devices.register(a,'teacher',dto); }
  @Delete('devices') @HttpCode(200) unregisterDevice(@Actor() a:Principal,@Body() dto:NotificationDeviceDto) { return this.devices.unregister(a,dto); }
  @Post(':id/retry') @HttpCode(200) @Throttle({default:{limit:5,ttl:60_000}}) retry(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.service.retry(a,id); }
}
@Module({imports:[AuthModule],controllers:[NotificationsController],providers:[NotificationsService,NotificationDelivery,NotificationDevicesService,NotificationEventsService,NotificationScheduler,NotificationAudienceService,NotificationDeliveryWorker],exports:[NotificationDelivery,NotificationDevicesService,NotificationEventsService]}) export class NotificationsModule {}
