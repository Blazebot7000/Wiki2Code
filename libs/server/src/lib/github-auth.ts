export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'connected'; token: string; scope?: string }
  | { status: 'expired' | 'denied' | 'error'; message: string };

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export async function startDeviceFlow(
  clientId: string,
  scope = 'repo read:user read:org',
): Promise<DeviceCodeResponse> {
  const response = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Wiki2Code',
    },
    body: JSON.stringify({ client_id: clientId, scope }),
  });

  const body = (await response.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.device_code || !body.user_code) {
    throw new Error(
      body.error_description ??
        body.error ??
        'GitHub rejected the device authorization request. Check the OAuth App client ID.',
    );
  }

  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri ?? 'https://github.com/login/device',
    expiresIn: body.expires_in ?? 900,
    interval: body.interval ?? 5,
  };
}

export async function pollDeviceFlow(
  clientId: string,
  deviceCode: string,
): Promise<DevicePollResult> {
  const response = await fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Wiki2Code',
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  const body = (await response.json()) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (body.access_token) {
    return { status: 'connected', token: body.access_token, scope: body.scope };
  }

  switch (body.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'slow_down' };
    case 'expired_token':
      return { status: 'expired', message: 'The device code expired. Start again.' };
    case 'access_denied':
      return { status: 'denied', message: 'Authorization was denied.' };
    default:
      return {
        status: 'error',
        message:
          body.error_description ?? body.error ?? 'GitHub authorization failed.',
      };
  }
}
