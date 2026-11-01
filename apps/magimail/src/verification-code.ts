/**
 * Extraction of one-time verification codes (OTPs) from email subjects and snippets.
 */

export interface ExtractedVerificationCode {
  /** The extracted verification code (e.g. "849201" or "G-123456"). */
  code: string;
  /** Service or sender name if identifiable (e.g. "GitHub", "Google", "Stripe"). */
  service?: string;
}

/** Trigger terms that indicate an email is conveying a one-time verification code. */
const VERIFICATION_CONTEXT_REGEX =
  /\b(?:verification\s+code|security\s+code|confirmation\s+code|login\s+code|access\s+code|auth(?:entication)?\s+code|one[- ]time\s+(?:passcode|password|code)|passcode|otp|pin|verify\s+your\s+(?:account|identity|email)|to\s+verify\s+your|use\s+(?:this\s+)?code|your\s+code\s+is|enter\s+code|(?:is\s+your|your)\s+(?:[A-Za-z0-9]+\s+)?code)\b/i;

/** Phrases that indicate the code is right after. */
const CODE_AFTER_REGEX =
  /(?:verification\s+code|security\s+code|confirmation\s+code|login\s+code|access\s+code|auth(?:entication)?\s+code|one[- ]time\s+(?:passcode|password|code)|passcode|otp|pin|your\s+code|code)(?:\s+is|\s*:|\s*[-–—]|\s+to\s+verify)?\s*[:\s#]*([A-Z]{1,3}-[0-9]{4,8}|[0-9]{3,4}[-\s][0-9]{3,4}|[0-9]{4,8}|[A-Z0-9]{5,8})\b/i;

/** Phrases that indicate the code is right before (e.g. "849201 is your GitHub verification code"). */
const CODE_BEFORE_REGEX =
  /\b([A-Z]{1,3}-[0-9]{4,8}|[0-9]{3,4}[-\s][0-9]{3,4}|[0-9]{4,8}|[A-Z0-9]{5,8})\b\s+(?:is\s+your|is\s+the|is\s+a)\s+(?:[A-Za-z0-9\s]*\s+)?(?:verification|security|confirmation|login|access|auth|passcode|otp|code)/i;

/** Prefixed codes like G-123456. */
const PREFIXED_CODE_REGEX = /\b([A-Z]{1,3}-[0-9]{4,8})\b/;

/** Extract sender or service name from an email's "From" field. */
export function extractServiceName(from?: string): string | undefined {
  if (!from) return undefined;
  const trimmed = from.trim();
  if (!trimmed) return undefined;

  // e.g. "GitHub" <noreply@github.com> or GitHub <noreply@github.com>
  const nameMatch = /^"?([^"<]+)"?\s*</.exec(trimmed);
  if (nameMatch && nameMatch[1]) {
    const name = nameMatch[1].trim();
    if (name && !name.includes('@')) {
      return name;
    }
  }

  // Extract from domain: noreply@github.com -> GitHub
  const emailMatch = /@([a-zA-Z0-9.-]+)\.([a-zA-Z]{2,})/.exec(trimmed);
  if (emailMatch && emailMatch[1]) {
    const parts = emailMatch[1].split('.');
    const domainPart = parts.length > 1 ? parts[parts.length - 2] : parts[0];
    if (domainPart && domainPart.length > 2) {
      return domainPart.charAt(0).toUpperCase() + domainPart.slice(1);
    }
  }

  return undefined;
}

function cleanCandidateCode(raw: string): string | null {
  const cleaned = raw.trim();

  // If it's a prefixed code like G-123456, keep as is
  if (/^[A-Z]{1,3}-[0-9]{4,8}$/.test(cleaned)) {
    return cleaned;
  }

  // Normalize hyphen or space separated digit codes: 123-456 or 123 456 -> 123456
  const normalizedDigits = cleaned.replace(/[-\s]/g, '');
  if (/^[0-9]{4,8}$/.test(normalizedDigits)) {
    // False positive guard: standalone current/recent years when 4 digits
    if (normalizedDigits.length === 4) {
      const num = parseInt(normalizedDigits, 10);
      if (num >= 2000 && num <= 2035) {
        return null;
      }
    }
    return normalizedDigits;
  }

  // Alphanumeric code (5-8 uppercase/digits, must contain at least one digit and one letter)
  if (/^[A-Z0-9]{5,8}$/.test(cleaned)) {
    const hasDigit = /[0-9]/.test(cleaned);
    const hasLetter = /[A-Z]/.test(cleaned);
    if (hasDigit && hasLetter) {
      return cleaned;
    }
  }

  return null;
}

function isDisqualified(text: string, matchIndex: number, matchLength: number): boolean {
  // Check currency prefix
  if (matchIndex > 0) {
    const prevChar = text[matchIndex - 1];
    if (prevChar === '$' || prevChar === '€' || prevChar === '£' || prevChar === '¥') {
      return true;
    }
  }

  // Check currency suffix or units
  const after = text.slice(matchIndex + matchLength, matchIndex + matchLength + 10);
  if (/^\s*(?:USD|EUR|GBP|AUD|CAD|JPY|cents?|dollars?|km|miles?|px|pt)\b/i.test(after)) {
    return true;
  }

  // Check phone number syntax like (123) 456-7890
  const surround = text.slice(Math.max(0, matchIndex - 5), matchIndex + matchLength + 10);
  if (/\b\d{3}[-.)]\s*\d{3}[-.]\d{4}\b/.test(surround)) {
    return true;
  }

  // Check time format: 12:34
  if (matchIndex > 0 && text[matchIndex - 1] === ':') {
    return true;
  }
  if (matchIndex + matchLength < text.length && text[matchIndex + matchLength] === ':') {
    return true;
  }

  return false;
}

/**
 * Extracts a one-time verification code from an email's subject, snippet, and sender.
 */
export function extractVerificationCode(
  subject?: string,
  snippet?: string,
  from?: string,
): ExtractedVerificationCode | null {
  const subj = subject ?? '';
  const snip = snippet ?? '';
  const combined = `${subj} ${snip}`.trim();

  // Guard: email must contain verification context
  if (!VERIFICATION_CONTEXT_REGEX.test(combined)) {
    return null;
  }

  const service = extractServiceName(from);

  // 1. Check subject first (higher precision, less noise)
  if (subj) {
    // Check CODE_BEFORE_REGEX in subject (e.g. "849201 is your GitHub verification code")
    const beforeMatch = CODE_BEFORE_REGEX.exec(subj);
    if (beforeMatch && beforeMatch[1]) {
      const code = cleanCandidateCode(beforeMatch[1]);
      if (code && !isDisqualified(subj, beforeMatch.index, beforeMatch[1].length)) {
        return { code, service };
      }
    }

    // Check CODE_AFTER_REGEX in subject (e.g. "Your verification code: 849201")
    const afterMatch = CODE_AFTER_REGEX.exec(subj);
    if (afterMatch && afterMatch[1]) {
      const code = cleanCandidateCode(afterMatch[1]);
      if (code && !isDisqualified(subj, afterMatch.index, afterMatch[1].length)) {
        return { code, service };
      }
    }

    // Check PREFIXED_CODE_REGEX in subject (e.g. "G-123456")
    const prefixMatch = PREFIXED_CODE_REGEX.exec(subj);
    if (prefixMatch && prefixMatch[1]) {
      const code = cleanCandidateCode(prefixMatch[1]);
      if (code && !isDisqualified(subj, prefixMatch.index, prefixMatch[1].length)) {
        return { code, service };
      }
    }

    // Direct standalone code at the beginning of the subject if the subject is a verification email
    // e.g. "491823 - Slack confirmation" or "[491823] verification code"
    const leadingCodeMatch = /^\[?([0-9]{4,8}|[0-9]{3,4}[-\s][0-9]{3,4})\]?\b/.exec(subj);
    if (leadingCodeMatch && leadingCodeMatch[1]) {
      const code = cleanCandidateCode(leadingCodeMatch[1]);
      if (code && !isDisqualified(subj, 0, leadingCodeMatch[1].length)) {
        return { code, service };
      }
    }
  }

  // 2. Check snippet
  if (snip) {
    const afterMatch = CODE_AFTER_REGEX.exec(snip);
    if (afterMatch && afterMatch[1]) {
      const code = cleanCandidateCode(afterMatch[1]);
      if (code && !isDisqualified(snip, afterMatch.index, afterMatch[1].length)) {
        return { code, service };
      }
    }

    const beforeMatch = CODE_BEFORE_REGEX.exec(snip);
    if (beforeMatch && beforeMatch[1]) {
      const code = cleanCandidateCode(beforeMatch[1]);
      if (code && !isDisqualified(snip, beforeMatch.index, beforeMatch[1].length)) {
        return { code, service };
      }
    }

    const prefixMatch = PREFIXED_CODE_REGEX.exec(snip);
    if (prefixMatch && prefixMatch[1]) {
      const code = cleanCandidateCode(prefixMatch[1]);
      if (code && !isDisqualified(snip, prefixMatch.index, prefixMatch[1].length)) {
        return { code, service };
      }
    }
  }

  return null;
}
