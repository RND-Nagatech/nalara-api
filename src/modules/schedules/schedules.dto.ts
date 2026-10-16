import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsIn, IsInt, IsISO8601, IsOptional, IsTimeZone, IsUUID, Max, Min } from 'class-validator';
export class ScheduleDto {
  @ApiProperty() @IsUUID('4') studentId!:string;
  @ApiProperty() @IsUUID('4') subjectId!:string;
  @ApiProperty({format:'date-time'}) @IsISO8601({strict:true}) startAt!:string;
  @ApiProperty({format:'date-time'}) @IsISO8601({strict:true}) endAt!:string;
  @ApiProperty({default:'Asia/Jakarta'}) @IsTimeZone() timezone!:string;
  @ApiPropertyOptional({enum:['none','weekly']}) @IsIn(['none','weekly']) @IsOptional() recurrence?:'none'|'weekly';
  @ApiPropertyOptional({minimum:1,maximum:52}) @IsInt() @Min(1) @Max(52) @IsOptional() repeatCount?:number;
}
export class UpdateScheduleDto extends PartialType(ScheduleDto) {
  @ApiPropertyOptional({enum:['scheduled','cancelled']}) @IsIn(['scheduled','cancelled']) @IsOptional() status?:'scheduled'|'cancelled';
}
export class AttendanceDto { @ApiProperty({enum:['present','excused','absent','cancelled']}) @IsIn(['present','excused','absent','cancelled']) attendance!:'present'|'excused'|'absent'|'cancelled'; }
export class UpdateSessionDto {
  @ApiPropertyOptional() @IsISO8601({strict:true}) @IsOptional() startAt?:string;
  @ApiPropertyOptional() @IsISO8601({strict:true}) @IsOptional() endAt?:string;
  @ApiPropertyOptional({enum:['scheduled','cancelled']}) @IsIn(['scheduled','cancelled']) @IsOptional() status?:'scheduled'|'cancelled';
}
