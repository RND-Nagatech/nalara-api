import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type AvatarAudience = 'teacher' | 'student';
type AvatarAsset = { avatarId: string; label: string; role: 'teacher' | 'student' | 'adult'; file: string };
export const avatarAssetsRoot = resolve(__dirname, '../../../assets/nalara_avatar_assets');
const manifest: AvatarAsset[] = JSON.parse(readFileSync(resolve(avatarAssetsRoot, 'manifest.json'), 'utf8'));
// Only catalogued, fixed relative files may ever be served. Never use a client path.
export const avatarAssets = Object.freeze(manifest.filter(entry =>
  /^(student|adult|teacher)_[a-z0-9_]+$/.test(entry.avatarId) &&
  ['teacher', 'student', 'adult'].includes(entry.role) &&
  entry.file === `${entry.role}/${entry.avatarId}.webp`,
));
export function avatarOptions(audience: AvatarAudience) {
  return avatarAssets.filter(entry => audience === 'teacher' ? entry.role === 'teacher' : entry.role !== 'teacher')
    .map(entry => ({ avatarId: entry.avatarId, label: entry.role === 'adult' ? entry.label.replace('Orang tua', 'Dewasa') : entry.label, category: entry.role,
      imagePath: `/api/v1/avatars/${entry.avatarId}/image` }));
}
export function allowedAvatar(audience: AvatarAudience, avatarId: string | null) {
  return avatarId === null || avatarOptions(audience).some(entry => entry.avatarId === avatarId);
}
