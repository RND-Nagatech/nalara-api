import { Equals } from 'class-validator';

export class TeachingGuidePreferencesDto {
  @Equals(true, {message: 'Status tutorial harus bernilai true.'})
  tutorialSeen!: true;
}
