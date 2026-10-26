import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
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

export class ReportRecipientDto {
  @ApiProperty() @IsUUID('4') sessionId!:string;
  @ApiPropertyOptional({type:[String]}) @IsOptional() @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsUUID('4',{each:true}) targetIds?:string[];
}

export class BatchReportDto extends OmitType(ReportDto,['targetIds'] as const) {
  @ApiProperty({type:[ReportRecipientDto],minItems:1,maxItems:100})
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique((entry:ReportRecipientDto)=>entry?.sessionId)
  @ValidateNested({each:true}) @Type(()=>ReportRecipientDto) entries!:ReportRecipientDto[];
  @ApiProperty({enum:['draft','published']}) @IsIn(['draft','published']) status!:'draft'|'published';
}
