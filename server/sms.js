import { HttpError } from './scheduling.js';

export function normalizeAdminPhone(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\+?[\d\s().-]+$/.test(value.trim())) throw new HttpError(400, 'Enter a valid phone number with its country code.');
  const digits = value.replace(/\D/g, '');
  const phone = value.trim().startsWith('+') ? `+${digits}` : digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith('1') ? `+${digits}` : '';
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new HttpError(400, 'Enter a valid phone number with its country code.');
  return phone;
}

export function createTwilioVerify({ accountSid = process.env.TWILIO_ACCOUNT_SID || '', authToken = process.env.TWILIO_AUTH_TOKEN || '', serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID || '', fetchImpl = fetch } = {}) {
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || !authToken || !/^VA[0-9a-f]{32}$/i.test(serviceSid)) return null;
  async function request(path, values, checking = false) {
    let response;
    let result;
    try {
      response = await fetchImpl(`https://verify.twilio.com/v2/Services/${serviceSid}/${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values).toString(),
      });
      result = await response.json();
    } catch { throw new HttpError(503, 'SMS sign-in is temporarily unavailable. Please try again later.'); }
    if (checking && response.status === 404) return false;
    if (response.status === 429) throw new HttpError(429, 'Too many code attempts. Please wait before trying again.');
    if (!response.ok) throw new HttpError(503, 'SMS sign-in is temporarily unavailable. Please try again later.');
    if (checking) return result.status === 'approved';
    if (result.status !== 'pending' || !/^VE[0-9a-f]{32}$/i.test(result.sid)) throw new HttpError(503, 'Unable to send a sign-in code. Please try again later.');
    return result.sid;
  }
  return {
    identity: `${accountSid}:${serviceSid}`,
    send: (phone) => request('Verifications', { To: phone, Channel: 'sms' }),
    check: (verificationSid, code) => request('VerificationCheck', { VerificationSid: verificationSid, Code: code }, true),
  };
}
