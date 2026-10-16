import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { normalizePhone } from '../auth/phone-number';
export class FamilyDto {
  @ApiProperty() @Transform(({value}) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(2,{message:'Nama Orang Tua minimal 2 karakter'}) @MaxLength(100) parentName!:string;
  @ApiProperty() @Transform(({value}) => normalizePhone(value) ?? value) @IsString() @Matches(/^\+628[1-9]\d{7,10}$/,{message:'Nomor HP Orang Tua tidak valid'}) parentPhone!:string;
  @ApiPropertyOptional({type:[String],description:'Anak-anak yang dikelompokkan ke Orang Tua ini.'}) @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsUUID('4',{each:true}) @IsOptional() studentIds?:string[];
}
export class UpdateFamilyDto extends FamilyDto {
  @ApiProperty({description:'Version dari GET keluarga.'}) @IsInt() @Min(0) version!:number;
}
