import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, Principal } from '../../common/api';
import { DashboardService } from './dashboard.service';
export { DashboardService } from './dashboard.service';
@ApiTags('Dashboard') @ApiBearerAuth() @Controller('dashboard') export class DashboardController {
  constructor(private readonly service:DashboardService) {}
  @Get() get(@Actor() a:Principal) { return this.service.get(a); }
}
@Module({controllers:[DashboardController],providers:[DashboardService]}) export class DashboardModule {}
