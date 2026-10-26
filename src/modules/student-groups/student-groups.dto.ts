import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';

export class StudentGroupDto {
  @ApiProperty() @Transform(({value}) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @ApiProperty({type: [String], minItems: 1, maxItems: 100})
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique() @IsUUID('4', {each: true}) studentIds!: string[];
}
export class StudentGroupVersionDto {
  @ApiProperty() @IsInt() @Min(0) version!: number;
}
export class UpdateStudentGroupDto extends StudentGroupDto {
  @ApiProperty() @IsInt() @Min(0) version!: number;
}
