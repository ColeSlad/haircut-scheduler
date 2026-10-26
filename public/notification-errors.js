export function notificationDiagnostic(job) {
  if (!['failed', 'unknown'].includes(job.state)) return { label: '', url: '', help: false };
  const code = String(job.error_code || '');
  if (/^[1-9]\d{0,7}$/.test(code)) return { label: `Provider error ${code}`, url: `https://www.twilio.com/docs/api/errors/${code}`, help: false,
    ...(code === '30034' ? { hint: 'The sending number needs approved US A2P 10DLC registration and must be linked to the registered messaging service.' } : {}) };
  const status = /^HTTP_([45]\d\d)$/.exec(code);
  if (status) return { label: `Twilio request failed (HTTP ${status[1]})`, url: '', help: true };
  return { label: job.state === 'failed' ? 'Twilio returned no diagnostic code' : '', url: '', help: job.state === 'failed' };
}
