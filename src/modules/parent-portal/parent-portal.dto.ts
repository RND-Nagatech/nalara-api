import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { ListQuery } from '../../common/query.dto';

export class ParentDashboardQuery {
  @ApiPropertyOptional() @IsUUID('4') @IsOptional() studentId?: string;
}

export class ParentStudentListQuery extends ListQuery {
  @ApiPropertyOptional({ default: 5, maximum: 100 }) limit = 5;
}

export class RescheduleAvailabilityQuery {
  @ApiProperty({ format: 'date-time' }) @IsISO8601({ strict: true }) from!: string;
  @ApiProperty({ format: 'date-time' }) @IsISO8601({ strict: true }) to!: string;
}

export class ParentAvailabilityDto extends RescheduleAvailabilityQuery {
  @ApiProperty() @IsUUID('4') sessionId!: string;
}

export class ParentRescheduleDto {
  @ApiProperty() @IsUUID('4') sessionId!: string;
  @ApiProperty({ format: 'date-time' }) @IsISO8601({ strict: true }) startAt!: string;
  @ApiProperty({ format: 'date-time' }) @IsISO8601({ strict: true }) endAt!: string;
  @ApiProperty() @IsString() @MaxLength(500) reason!: string;
}

export class ReviewRescheduleDto {
  @ApiProperty({ enum: ['approved', 'rejected', 'proposed'] }) @IsIn(['approved', 'rejected', 'proposed']) status!: 'approved' | 'rejected' | 'proposed';
  @ApiPropertyOptional({ format: 'date-time' }) @ValidateIf((dto: ReviewRescheduleDto) => dto.status === 'proposed' || dto.proposedStartAt !== undefined) @IsISO8601({ strict: true }) proposedStartAt?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @ValidateIf((dto: ReviewRescheduleDto) => dto.status === 'proposed' || dto.proposedEndAt !== undefined) @IsISO8601({ strict: true }) proposedEndAt?: string;
  @ApiPropertyOptional() @IsString() @MaxLength(500) @IsOptional() note?: string;
}

export class RespondRescheduleDto {
  @ApiProperty({ enum: ['accept', 'decline'] }) @IsIn(['accept', 'decline']) action!: 'accept' | 'decline';
}
