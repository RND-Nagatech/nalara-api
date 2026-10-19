import { Equals, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class DeleteAccountDto {
  @Equals('HAPUS AKUN', {message: 'Konfirmasi penghapusan akun belum lengkap.'})
  confirmation!: string;

  @Equals(true, {message: 'Persetujuan dampak penghapusan akun wajib dicentang.'})
  acknowledged!: boolean;

  @ValidateIf((dto: DeleteAccountDto) => dto.password !== undefined || dto.idToken === undefined)
  @IsString({message: 'Kata sandi wajib diisi.'})
  @MinLength(1, {message: 'Kata sandi wajib diisi.'})
  @MaxLength(128)
  password?: string;

  @ValidateIf((dto: DeleteAccountDto) => dto.idToken !== undefined || dto.password === undefined)
  @IsString()
  @MinLength(100)
  @MaxLength(8192)
  idToken?: string;
}
