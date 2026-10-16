import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
export class ReportDto {
  @ApiProperty() @Transform(({value}) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(2) @MaxLength(200) topic!:string;
  @ApiProperty() @Transform(({value}) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(2) @MaxLength(5000) summary!:string;
  @ApiPropertyOptional({type:[String]}) @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsUUID('4',{each:true}) @IsOptional() targetIds?:string[];
  @ApiPropertyOptional() @IsString() @MaxLength(3000) @IsOptional() observations?:string;
  @ApiPropertyOptional() @IsString() @MaxLength(3000) @IsOptional() difficulties?:string;
  @ApiPropertyOptional() @IsString() @MaxLength(3000) @IsOptional() homework?:string;
  @ApiPropertyOptional() @IsString() @MaxLength(3000) @IsOptional() recommendation?:string;
  @ApiProperty({enum:['teacher','student','shared']}) @IsIn(['teacher','student','shared']) visibility!:'teacher'|'student'|'shared';
}
export class UpdateReportDto extends PartialType(ReportDto) {}
