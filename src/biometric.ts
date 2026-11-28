const BIO_CRED_PREFIX = 'cp_py26_bio_cred_';

function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function isPlatformBiometricAvailable(): Promise<boolean> {
  try {
    if (
      typeof window === 'undefined' ||
      !window.isSecureContext ||
      !('PublicKeyCredential' in window) ||
      typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function'
    ) {
      return false;
    }
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function hasEnrolledBiometric(empId: string): boolean {
  try {
    return Boolean(localStorage.getItem(`${BIO_CRED_PREFIX}${empId}`));
  } catch {
    return false;
  }
}

export function clearEnrolledBiometric(empId: string): void {
  try {
    localStorage.removeItem(`${BIO_CRED_PREFIX}${empId}`);
  } catch {
    // ignore
  }
}

export async function enrollDeviceBiometric(empId: string, empName: string): Promise<boolean> {
  const available = await isPlatformBiometricAvailable();
  if (!available) return false;

  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  const userIdBytes = new TextEncoder().encode(empId.slice(0, 64));

  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'CARL PETERS Asistencia' },
      user: {
        id: userIdBytes,
        name: empId,
        displayName: empName,
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },
        { alg: -257, type: 'public-key' },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 45000,
    },
  })) as PublicKeyCredential | null;

  if (!cred || !cred.rawId) return false;
  localStorage.setItem(`${BIO_CRED_PREFIX}${empId}`, toBase64Url(cred.rawId));
  return true;
}

export async function verifyDeviceBiometric(empId: string): Promise<'verified' | 'cancelled' | 'unavailable'> {
  const stored = localStorage.getItem(`${BIO_CRED_PREFIX}${empId}`);
  if (!stored) return 'unavailable';
  const available = await isPlatformBiometricAvailable();
  if (!available) return 'unavailable';

  try {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    const credIdBytes = fromBase64Url(stored);
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [
          {
            type: 'public-key',
            id: credIdBytes.buffer as ArrayBuffer,
            transports: ['internal'],
          },
        ],
        userVerification: 'required',
        timeout: 45000,
      },
    });
    return assertion ? 'verified' : 'cancelled';
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError' || name === 'AbortError') {
      return 'cancelled';
    }
    return 'unavailable';
  }
}
