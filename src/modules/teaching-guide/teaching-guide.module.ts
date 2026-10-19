import { Body, Controller, Get, Header, Module, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, Principal } from '../../common/api';
import { TeachingGuidePreferencesDto } from './teaching-guide.dto';
import { TeachingGuideService } from './teaching-guide.service';

@ApiTags('Teaching guide')
@ApiBearerAuth()
@Controller('teaching-guide')
export class TeachingGuideController {
  constructor(private readonly service: TeachingGuideService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Actor() actor: Principal) { return this.service.get(actor); }

  @Patch('preferences')
  preferences(@Actor() actor: Principal, @Body() dto: TeachingGuidePreferencesDto) {
    return this.service.preferences(actor, dto.dismissed);
  }
}

@Module({controllers: [TeachingGuideController], providers: [TeachingGuideService]})
export class TeachingGuideModule {}
