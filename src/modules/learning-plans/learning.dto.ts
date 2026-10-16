import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type, Transform } from 'class-transformer';
export class TargetDto {
  @ApiProperty() @Transform(({value}) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(2) @MaxLength(200) title!:string;
  @ApiPropertyOptional() @IsString() @MaxLength(3000) @IsOptional() description?:string;
  @ApiPropertyOptional() @IsString() @MaxLength(1000) @IsOptional() successCriteria?:string;
  @ApiPropertyOptional({enum:['low','normal','high']}) @IsIn(['low','normal','high']) @IsOptional() priority?:'low'|'normal'|'high';
}
export class PlanDto {
  @ApiProperty() @IsUUID('4') studentId!:string;
  @ApiProperty() @IsUUID('4') subjectId!:string;
  @ApiProperty() @Transform(({value}) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(2) @MaxLength(200) title!:string;
  @ApiProperty() @IsISO8601({strict:true}) startAt!:string;
  @ApiProperty() @IsISO8601({strict:true}) endAt!:string;
  @ApiPropertyOptional({type:[TargetDto],description:'Initial targets created atomically with the plan. More can be added later.'}) @IsArray() @ArrayMaxSize(100) @ValidateNested({each:true}) @Type(()=>TargetDto) @IsOptional() targets?:TargetDto[];
}
export class UpdateTargetDto extends PartialType(TargetDto) {
  @ApiPropertyOptional({enum:['active','archived','cancelled']}) @IsIn(['active','archived','cancelled']) @IsOptional() status?:'active'|'archived'|'cancelled';
}
export class ProgressDto {
  @ApiProperty({minimum:0,maximum:100}) @IsInt() @Min(0) @Max(100) progress!:number;
  @ApiProperty({minimum:0,description:'Version returned by GET target; conflict returns 409'}) @IsInt() @Min(0) version!:number;
  @ApiPropertyOptional() @IsString() @MaxLength(3000) @IsOptional() note?:string;
  @ApiPropertyOptional() @IsUUID('4') @IsOptional() sessionId?:string;
  @ApiProperty({enum:['teacher','student','shared']}) @IsIn(['teacher','student','shared']) visibility!:'teacher'|'student'|'shared';
}
