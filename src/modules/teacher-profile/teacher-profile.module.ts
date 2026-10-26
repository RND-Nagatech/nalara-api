import { Body, Controller, Module, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor } from '../../common/api';
import type { Principal } from '../../common/api';
import { UpdateTeacherPhoneDto, UpdateTeacherTimezoneDto } from './teacher-profile.dto';
import { TeacherProfileService } from './teacher-profile.service';

@ApiTags('Profile')
@ApiBearerAuth()
@Controller('me')
export class TeacherProfileController {
  constructor(private readonly service: TeacherProfileService) {}
  @Patch('timezone') updateTimezone(@Actor() actor: Principal, @Body() dto: UpdateTeacherTimezoneDto) {
    return this.service.updateTimezone(actor, dto.timezone);
  }
  @Patch('phone') updatePhone(@Actor() actor: Principal, @Body() dto: UpdateTeacherPhoneDto) {
    return this.service.updatePhone(actor, dto.phone);
  }
}

@Module({controllers: [TeacherProfileController], providers: [TeacherProfileService]})
export class TeacherProfileModule {}
