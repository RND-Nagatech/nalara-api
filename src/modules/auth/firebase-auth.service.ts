import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp,
} from 'firebase-admin/app';
import type { App } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';

@Injectable()
export class FirebaseAuthService {
  private auth?: ReturnType<typeof getAuth>;

  constructor(private readonly config: ConfigService) {}

  private getAuthClient() {
    if (this.auth) return this.auth;

    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    if (!projectId) {
      throw new ServiceUnavailableException(
        'Login Google belum dikonfigurasi di server.',
      );
    }

    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = this.config.get<string>('FIREBASE_PRIVATE_KEY');
    const credential =
      clientEmail && privateKey
        ? cert({
            projectId,
            clientEmail,
            privateKey: privateKey.replace(/\\n/g, '\n'),
          })
        : applicationDefault();

    const app = getApps().length
      ? getApp()
      : initializeApp({credential, projectId});
    this.auth = getAuth(app);
    return this.auth;
  }

  getAdminApp(): App {
    this.getAuthClient();
    return getApp();
  }

  async verifyIdToken(idToken: string): Promise<DecodedIdToken> {
    let auth: ReturnType<typeof getAuth>;
    try {
      auth = this.getAuthClient();
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        'Verifikasi login Google belum tersedia di server.',
      );
    }

    try {
      return await auth.verifyIdToken(idToken);
    } catch {
      throw new UnauthorizedException(
        'Token Google tidak valid atau sudah kedaluwarsa.',
      );
    }
  }
}
