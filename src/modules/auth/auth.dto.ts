import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MaxLength, MinLength, Validate, ValidateIf, ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { Transform } from 'class-transformer';
import { normalizePhone } from './phone-number';
class PasswordDto {
  @ApiProperty({minLength: 1, maxLength:128}) @IsString({message:'Kata sandi wajib diisi'}) @MinLength(1, {message:'Kata sandi wajib diisi'}) @MaxLength(128, {message:'Kata sandi maksimal 128 karakter'}) password!: string;
}
class StrongPasswordDto {
  @ApiProperty({minLength:8, maxLength:128, description:'Minimal 8 karakter, huruf besar, huruf kecil, angka, dan simbol.'})
  @IsString({message:'Kata sandi wajib diisi'})
  @MinLength(8, {message:'Kata sandi minimal 8 karakter'})
  @MaxLength(128, {message:'Kata sandi maksimal 128 karakter'})
  @Matches(/^(?=[\s\S]*[A-Z])(?=[\s\S]*[a-z])(?=[\s\S]*\d)(?=[\s\S]*[^\p{L}\p{N}\s])[\s\S]*$/u, {message:'Kata sandi harus mengandung huruf besar, huruf kecil, angka, dan simbol'})
  password!: string;
}
@ValidatorConstraint({name:'passwordConfirmationMatches', async:false})
class PasswordConfirmationMatches implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    return typeof value === 'string' && value === (args.object as {password?:unknown}).password;
  }
  defaultMessage() { return 'Ulangi kata sandi harus sama dengan kata sandi'; }
}
export class LoginDto extends PasswordDto {
  @ApiPropertyOptional({description: 'Gunakan tepat satu identitas: email atau phone.'})
  @ValidateIf((dto: LoginDto) => dto.email !== undefined || dto.phone === undefined)
  @Transform(({value}) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail({}, {message:'Email tidak valid'}) @MaxLength(254, {message:'Email maksimal 254 karakter'}) email?: string;
  @ApiPropertyOptional({example: '081234567890', description: 'Nomor HP Indonesia; 08…, 628…, atau +628….'})
  @ValidateIf((dto: LoginDto) => dto.phone !== undefined || dto.email === undefined)
  @Transform(({value}) => normalizePhone(value) ?? value)
  @IsString({message:'Nomor HP wajib diisi'}) @MaxLength(32, {message:'Nomor HP maksimal 32 karakter'}) @Matches(/^\+628[1-9]\d{7,10}$/, {message: 'Nomor HP Indonesia tidak valid'}) phone?: string;
}
export class RegisterDto extends StrongPasswordDto {
  @ApiProperty() @Transform(({value}) => typeof value === 'string' ? value.trim().toLowerCase() : value) @IsEmail({}, {message:'Email tidak valid'}) @MaxLength(254, {message:'Email maksimal 254 karakter'}) email!: string;
  @ApiProperty({example: '081234567890'}) @Transform(({value}) => normalizePhone(value) ?? value) @IsString({message:'Nomor HP wajib diisi'}) @MaxLength(32, {message:'Nomor HP maksimal 32 karakter'}) @Matches(/^\+628[1-9]\d{7,10}$/, {message: 'Nomor HP Indonesia tidak valid'}) phone!: string;
  @ApiProperty() @Transform(({value}) => typeof value === 'string' ? value.trim() : value) @IsString({message:'Nama Guru wajib diisi'}) @MinLength(2, {message:'Nama Guru minimal 2 karakter'}) @MaxLength(100, {message:'Nama Guru maksimal 100 karakter'}) name!: string;
  @ApiProperty({description:'Harus sama persis dengan password.'}) @IsString({message:'Ulangi kata sandi wajib diisi'}) @MaxLength(128, {message:'Ulangi kata sandi maksimal 128 karakter'}) @Validate(PasswordConfirmationMatches) passwordConfirmation!: string;
}
export class RefreshDto { @ApiProperty() @IsString() @MinLength(40) @MaxLength(100) refreshToken!: string; }
export class GoogleLoginDto {
  @ApiProperty({description: 'Firebase ID token yang didapat setelah Google Sign-In di client.'})
  @IsString() @MinLength(100) @MaxLength(8192) idToken!: string;
}
export class ForgotDto {
  @ApiProperty() @Transform(({value}) => typeof value === 'string' ? value.trim().toLowerCase() : value) @IsEmail({}) @MaxLength(254) email!: string;
}
export class VerifyResetOtpDto {
  @ApiProperty() @Transform(({value}) => typeof value === 'string' ? value.trim().toLowerCase() : value) @IsEmail({}) @MaxLength(254) email!: string;
  @ApiProperty({example: '123456'}) @IsString() @Matches(/^\d{6}$/, {message: 'OTP harus terdiri dari 6 angka'}) otp!: string;
}
export class ResetDto {
  @ApiProperty() @IsString() @MinLength(40) @MaxLength(100) resetToken!: string;
  @ApiProperty({minLength:8, maxLength:128}) @IsString({message:'Kata sandi wajib diisi'}) @MinLength(8, {message:'Kata sandi minimal 8 karakter'}) @MaxLength(128, {message:'Kata sandi maksimal 128 karakter'}) @Matches(/^(?=[\s\S]*[A-Z])(?=[\s\S]*[a-z])(?=[\s\S]*\d)(?=[\s\S]*[^\p{L}\p{N}\s])[\s\S]*$/u, {message:'Kata sandi harus mengandung huruf besar, huruf kecil, angka, dan simbol'}) newPassword!: string;
}
