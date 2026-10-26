import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsTimeZone, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
export class ScheduleDto {
  @ApiPropertyOptional({description:'Legacy single-student input; do not combine with studentIds'}) @IsUUID('4') @IsOptional() studentId?:string;
  @ApiPropertyOptional({type:[String],minItems:1,maxItems:100}) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique() @IsUUID('4',{each:true}) @IsOptional() studentIds?:string[];
  @ApiProperty() @IsUUID('4') subjectId!:string;
  @ApiProperty({format:'date-time'}) @IsISO8601({strict:true}) startAt!:string;
  @ApiProperty({format:'date-time'}) @IsISO8601({strict:true}) endAt!:string;
  @ApiProperty({default:'Asia/Jakarta'}) @IsTimeZone() timezone!:string;
  @ApiPropertyOptional({enum:['none','weekly']}) @IsIn(['none','weekly']) @IsOptional() recurrence?:'none'|'weekly';
  @ApiPropertyOptional({minimum:1,maximum:52}) @IsInt() @Min(1) @Max(52) @IsOptional() repeatCount?:number;
  @ApiPropertyOptional({type:[Number]}) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ArrayUnique() @IsInt({each:true}) @Min(1,{each:true}) @Max(7,{each:true}) @IsOptional() repeatDays?:number[];
  @ApiPropertyOptional({enum:['never','count','until']}) @IsIn(['never','count','until']) @IsOptional() repeatEnd?:'never'|'count'|'until';
  @ApiPropertyOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsOptional() repeatUntil?:string;
}
export class RepeatScheduleDto {
  @ApiProperty() @IsISO8601({strict:true}) startAt!:string;
  @ApiProperty() @IsISO8601({strict:true}) endAt!:string;
  @ApiProperty() @IsTimeZone() timezone!:string;
  @ApiProperty({type:[Number]}) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ArrayUnique() @IsInt({each:true}) @Min(1,{each:true}) @Max(7,{each:true}) repeatDays!:number[];
  @ApiProperty({enum:['never','count','until']}) @IsIn(['never','count','until']) repeatEnd!:'never'|'count'|'until';
  @ApiPropertyOptional() @IsInt() @Min(1) @Max(52) @IsOptional() repeatCount?:number;
  @ApiPropertyOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsOptional() repeatUntil?:string;
}
export class UpdateScheduleDto extends PartialType(ScheduleDto) {
  @ApiPropertyOptional({enum:['scheduled','cancelled']}) @IsIn(['scheduled','cancelled']) @IsOptional() status?:'scheduled'|'cancelled';
  @ApiPropertyOptional({minLength:3,maxLength:500}) @Transform(({value})=>typeof value==='string'?value.trim():value)
  @ValidateIf(o=>o.status==='cancelled'||o.cancellationReason!==undefined) @IsString() @MinLength(3) @MaxLength(500) cancellationReason?:string;
}
export class AttendanceDto {
  @ApiProperty({enum:['present','excused','absent','cancelled']}) @IsIn(['present','excused','absent','cancelled']) attendance!:'present'|'excused'|'absent'|'cancelled';
  @ApiPropertyOptional({minLength:3,maxLength:500}) @Transform(({value})=>typeof value==='string'?value.trim():value)
  @ValidateIf(o=>o.attendance==='cancelled'||o.cancellationReason!==undefined) @IsString() @MinLength(3) @MaxLength(500) cancellationReason?:string;
}
export class AttendanceEntryDto extends AttendanceDto {
  @ApiProperty() @IsUUID('4') sessionId!:string;
}
export class BatchAttendanceDto {
  @ApiProperty({type:[AttendanceEntryDto],minItems:1,maxItems:100}) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique((entry:AttendanceEntryDto|null)=>entry?.sessionId) @ValidateNested({each:true}) @Type(()=>AttendanceEntryDto) entries!:AttendanceEntryDto[];
}
export class UpdateSessionDto {
  @ApiPropertyOptional() @IsISO8601({strict:true}) @IsOptional() startAt?:string;
  @ApiPropertyOptional() @IsISO8601({strict:true}) @IsOptional() endAt?:string;
  @ApiPropertyOptional({enum:['scheduled','cancelled']}) @IsIn(['scheduled','cancelled']) @IsOptional() status?:'scheduled'|'cancelled';
  @ApiPropertyOptional({enum:['one','following']}) @IsIn(['one','following']) @IsOptional() scope?:'one'|'following';
  @ApiPropertyOptional({minLength:3,maxLength:500}) @Transform(({value})=>typeof value==='string'?value.trim():value)
  @ValidateIf(o=>o.status==='cancelled'||o.cancellationReason!==undefined) @IsString() @MinLength(3) @MaxLength(500) cancellationReason?:string;
}
