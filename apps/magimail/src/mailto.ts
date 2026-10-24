export interface MailtoParams {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
}

/**
 * Parses a standard mailto: URI into structured parameters
 */
export function parseMailtoUri(uri: string): MailtoParams {
  if (!uri || !uri.toLowerCase().startsWith('mailto:')) {
    return {};
  }

  const raw = uri.substring(7); // remove "mailto:"
  const [recipientPart, queryPart] = raw.split('?');

  const params: MailtoParams = {};

  if (recipientPart) {
    params.to = decodeURIComponent(recipientPart.trim());
  }

  if (queryPart) {
    const searchParams = new URLSearchParams(queryPart);
    const to = searchParams.get('to');
    if (to) {
      params.to = params.to ? `${params.to},${to}` : to;
    }
    const cc = searchParams.get('cc');
    if (cc) params.cc = cc;
    const bcc = searchParams.get('bcc');
    if (bcc) params.bcc = bcc;
    const subject = searchParams.get('subject');
    if (subject) params.subject = subject;
    const body = searchParams.get('body');
    if (body) params.body = body;
  }

  return params;
}

/**
 * Formats a mailto URI or MailtoParams into a direct Gmail Compose web URL
 */
export function buildGmailComposeUrl(params: MailtoParams | string): string {
  const parsed = typeof params === 'string' ? parseMailtoUri(params) : params;
  const searchParams = new URLSearchParams({
    view: 'cm',
    fs: '1',
    tf: '1',
  });

  if (parsed.to) searchParams.set('to', parsed.to);
  if (parsed.cc) searchParams.set('cc', parsed.cc);
  if (parsed.bcc) searchParams.set('bcc', parsed.bcc);
  if (parsed.subject) searchParams.set('su', parsed.subject);
  if (parsed.body) searchParams.set('body', parsed.body);

  return `https://mail.google.com/mail/u/0/?${searchParams.toString()}`;
}
