import { BadRequestException, ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import sharp from 'sharp';
import type { Principal } from '../../common/api';
import { Database } from '../../database/database.module';
import { LogoStorage, MAX_LOGO_BYTES } from '../../storage/logo-storage.service';

export interface LogoUpload {buffer: Buffer; size: number; mimetype: string;}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export async function normalizeLogo(file?: LogoUpload): Promise<Buffer> {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) throw new BadRequestException('Pilih logo PNG atau JPEG terlebih dahulu.');
  if (file.buffer.length > MAX_LOGO_BYTES || file.size !== file.buffer.length) throw new BadRequestException('Ukuran logo maksimal 2 MB.');
  const png = file.buffer.subarray(0, 8).equals(pngSignature);
  const jpeg = file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff;
  if ((!png && !jpeg) || file.mimetype !== (png ? 'image/png' : 'image/jpeg')) throw new BadRequestException('Logo harus berupa gambar PNG atau JPEG yang valid.');
  try {
    const image = sharp(file.buffer, {limitInputPixels: 4_194_304, failOn: 'warning'});
    const meta = await image.metadata();
    if (!['png', 'jpeg'].includes(meta.format ?? '') || (meta.pages ?? 1) > 1) throw new Error('Unsupported image');
    // Re-encode actual decoded pixels; strip EXIF/other metadata and bound PDF memory.
    return await image.rotate().resize(512, 512, {fit: 'inside', withoutEnlargement: true})
      .png({compressionLevel: 9}).timeout({seconds: 3}).toBuffer();
  } catch {
    throw new BadRequestException('Logo tidak dapat dibaca. Gunakan PNG/JPEG tidak rusak, maksimal 4 megapiksel.');
  }
}

@Injectable()
export class BrandingLogoService {
  private readonly logger = new Logger(BrandingLogoService.name);
  constructor(private readonly db: Database, private readonly storage: LogoStorage) {}
  private async lock(actor: Principal, session: ClientSession) {
    const admitted = await this.db.collection('workspaces').updateOne({_id: actor.workspaceId, ownerId: actor._id,
      deletionRequestedAt: {$exists: false}}, {$inc: {scheduleVersion: 1}}, {session});
    if (admitted.matchedCount !== 1) throw new ForbiddenException('Akun tidak dapat mengubah identitas laporan.');
  }
  private async removeQuietly(workspaceId: string, key?: string) {
    if (!key) return;
    try {await this.storage.remove(workspaceId, key);}
    catch {this.logger.warn({event: 'branding.logo.cleanup_pending', workspaceId}, 'Private obsolete logo cleanup requires attention');}
  }
  async read(actor: Principal) {
    const row = await this.db.collection('tutorPreferences').findOne({workspaceId: actor.workspaceId}).select('logoKey').lean();
    if (!row?.logoKey) return null;
    try {return {version: row.logoKey, bytes: await this.storage.read(actor.workspaceId, row.logoKey)};}
    catch {throw new ServiceUnavailableException('Logo tersimpan belum dapat dibaca. Muat ulang atau unggah logo kembali.');}
  }
  async current(actor: Principal) {
    const logo = await this.read(actor);
    return {logo: logo ? {version: logo.version, mimeType: 'image/png', contentBase64: logo.bytes.toString('base64')} : null};
  }
  async upload(actor: Principal, file?: LogoUpload) {
    const bytes = await normalizeLogo(file);
    let key: string;
    try {key = await this.storage.write(actor.workspaceId, bytes);}
    catch {throw new ServiceUnavailableException('Logo belum dapat disimpan. Periksa penyimpanan server lalu coba lagi.');}
    let oldKey: string | undefined;
    try {
      oldKey = await this.db.connection.transaction(async session => {
        await this.lock(actor, session);
        const old = await this.db.collection('tutorPreferences').findOne({workspaceId: actor.workspaceId}).session(session).lean();
        await this.db.collection('tutorPreferences').findOneAndUpdate({workspaceId: actor.workspaceId},
          {$set: {logoKey: key}, $setOnInsert: {workspaceId: actor.workspaceId}},
          {session, upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true}).lean();
        return old?.logoKey;
      });
    } catch (error) {await this.removeQuietly(actor.workspaceId, key); throw error;}
    await this.removeQuietly(actor.workspaceId, oldKey);
    return {logo: {version: key, mimeType: 'image/png', contentBase64: bytes.toString('base64')}};
  }
  async remove(actor: Principal) {
    const oldKey = await this.db.connection.transaction(async session => {
      await this.lock(actor, session);
      const old = await this.db.collection('tutorPreferences').findOne({workspaceId: actor.workspaceId}).session(session).lean();
      await this.db.collection('tutorPreferences').updateOne({workspaceId: actor.workspaceId}, {$unset: {logoKey: 1}}, {session});
      return old?.logoKey;
    });
    await this.removeQuietly(actor.workspaceId, oldKey);
    return {logo: null};
  }
}
