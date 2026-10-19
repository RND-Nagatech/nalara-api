import { IsBoolean } from 'class-validator';

export class TeachingGuidePreferencesDto {
  @IsBoolean({message: 'Pilihan tampilan panduan harus berupa boolean.'})
  dismissed!: boolean;
}
