import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { normalizePhone } from '../auth/phone-number';

export const TEACHER_TIMEZONES = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'] as const;

export class UpdateTeacherTimezoneDto {
  @ApiProperty({enum: TEACHER_TIMEZONES, example: 'Asia/Makassar'})
  @IsString()
  @IsIn(TEACHER_TIMEZONES, {message: 'Pilih zona waktu WIB, WITA, atau WIT.'})
  timezone!: string;
}

export class UpdateTeacherPhoneDto {
  @ApiProperty({example: '081234567890', description: 'Nomor HP Indonesia: 08…, 628…, atau +628….'})
  @Transform(({value}) => normalizePhone(value) ?? value)
  @IsString({message: 'Nomor HP wajib diisi'})
  @MaxLength(32, {message: 'Nomor HP maksimal 32 karakter'})
  @Matches(/^\+628[1-9]\d{7,10}$/, {message: 'Nomor HP Indonesia tidak valid'})
  phone!: string;
}
