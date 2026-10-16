import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
export class StudentDto {
  @ApiProperty() @Transform(({value}) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @ApiPropertyOptional() @IsString() @MaxLength(50) @IsOptional() grade?: string;
  @ApiPropertyOptional() @IsString() @MaxLength(2000) @IsOptional() notes?: string;
  @ApiPropertyOptional({nullable:true}) @ValidateIf((_,value)=>value!==undefined && value!==null) @IsUUID('4') familyId?: string | null;
}
export class UpdateStudentDto extends PartialType(StudentDto) {
  @ApiPropertyOptional({enum:['active','archived']}) @IsIn(['active','archived']) @IsOptional() status?: 'active' | 'archived';
}
