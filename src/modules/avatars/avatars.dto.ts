import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, ValidateIf } from 'class-validator';

export class UpdateAvatarDto {
  @ApiProperty({ type: String, nullable: true, description: 'ID katalog; null untuk kembali ke inisial.' })
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: 'Pilih karakter profil yang tersedia.' })
  @MaxLength(80, { message: 'Karakter profil tidak valid.' })
  avatarId!: string | null;
}
