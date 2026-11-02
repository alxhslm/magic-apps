import { describe, expect, it } from 'vitest';
import { extractVerificationCode } from '../src/verification-code.js';

interface CorpusTestCase {
  name: string;
  subject?: string;
  snippet?: string;
  from?: string;
  expected: {
    code: string;
    service?: string;
  } | null;
}

const CORPUS: CorpusTestCase[] = [
  // --- Real-world major service patterns ---
  {
    name: 'UNiDAYS passcode with leading digits in subject',
    subject: '575720 is your UNiDAYS passcode',
    snippet: 'ONE-TIME PASSCODE 575720 Here is your passcode. It will expire in 5 minutes.',
    from: 'UNiDAYS <no-reply@auth.myunidays.com>',
    expected: { code: '575720', service: 'UNiDAYS' },
  },
  {
    name: 'X (Twitter) verification code in subject',
    subject: '124616 is your X verification code',
    snippet: 'Confirm your email address to complete your X account setup.',
    from: 'X <info@x.com>',
    expected: { code: '124616', service: 'X' },
  },
  {
    name: 'Checkatrade one-time code in subject and snippet',
    subject: 'Your Checkatrade one-time verification code is 103983',
    snippet: 'Use this code to login to your account: 103983 This code will expire in 5 minutes.',
    from: 'Checkatrade <noreply@service.checkatrade.com>',
    expected: { code: '103983', service: 'Checkatrade' },
  },
  {
    name: 'Sony sign-in verification code in snippet',
    subject: 'Your Sony Sign-in Verification Code',
    snippet: '612451 is your verification code for your Sony account.',
    from: 'Sony <sony@email02.account.sony.com>',
    expected: { code: '612451', service: 'Sony' },
  },
  {
    name: 'DrawNames 5-digit code in subject',
    subject: 'Your code is: 13912',
    snippet: 'Here is your code to view the gift exchange.',
    from: '"drawnames.co.uk" <drawnames@drawnames.co.uk>',
    expected: { code: '13912', service: 'drawnames.co.uk' },
  },
  {
    name: 'Calm padded preheader with zero-width characters and colon',
    subject: 'Email verification code',
    snippet:
      'Your verification code: \u034F\u200B\uFEFF Verify your email address Enter this code when you’re ready: 054328 This code will expire in 5 days.',
    from: 'Calm <hello@breathe.calm.com>',
    expected: { code: '054328', service: 'Calm' },
  },
  {
    name: 'Rippling verification code formatted with markdown asterisks',
    subject: 'Your Rippling verification code',
    snippet:
      'Use the code below to verify your email in the next 15 minutes. Do not share this security code with anyone; the Rippling team will never ask you for it. *975713*',
    from: 'Rippling <no-reply@rippling.com>',
    expected: { code: '975713', service: 'Rippling' },
  },
  {
    name: 'Expedia secure sign in code',
    subject: '249652 is your secure sign in code',
    snippet: 'Use this code to sign in to your Expedia account.',
    from: 'Expedia <do-not-reply@accounts.expedia.com>',
    expected: { code: '249652', service: 'Expedia' },
  },
  {
    name: 'Luma hyphenated sign-in code in subject',
    subject: '139191 is your Luma sign-in code',
    snippet: 'Never share this code or enter it anywhere other than luma.com',
    from: 'Luma <support@luma.com>',
    expected: { code: '139191', service: 'Luma' },
  },
  {
    name: 'OpenRouter verification code',
    subject: '612753 is your verification code',
    snippet: 'Enter this code to sign in to OpenRouter.',
    from: 'OpenRouter <notifications@openrouter.ai>',
    expected: { code: '612753', service: 'OpenRouter' },
  },
  {
    name: 'American Express SafeKey transaction code ignoring card ending',
    subject: 'Your SafeKey Verification Code',
    snippet:
      'Your SafeKey Verification Code MR J DOE Account ending: 12345 Your verification code for transaction is:502828 Here is what you should know',
    from: 'American Express <AmericanExpress@welcome.americanexpress.com>',
    expected: { code: '502828', service: 'American Express' },
  },
  {
    name: 'GitHub device verification code in snippet',
    subject: '[GitHub] Please verify your device',
    snippet: 'Verification code: 849201. This code will expire in 10 minutes.',
    from: 'GitHub <noreply@github.com>',
    expected: { code: '849201', service: 'GitHub' },
  },
  {
    name: 'Google prefixed code G-XXXXXX in subject',
    subject: 'G-123456 is your Google verification code',
    snippet: "Don't share this code with anyone.",
    from: 'Google <no-reply@accounts.google.com>',
    expected: { code: 'G-123456', service: 'Google' },
  },
  {
    name: 'Slack confirmation code with leading bracket and hyphen',
    subject: '491823 - Slack confirmation code',
    snippet: 'Enter this confirmation code in Slack to sign in.',
    from: 'Slack <no-reply@slack.com>',
    expected: { code: '491823', service: 'Slack' },
  },
  {
    name: 'Amazon OTP code',
    subject: 'Amazon password assistance',
    snippet: 'To authenticate, please enter the following One-Time Password (OTP): 629104',
    from: 'Amazon.com <account-update@amazon.com>',
    expected: { code: '629104', service: 'Amazon.com' },
  },
  {
    name: 'Microsoft security code',
    subject: 'Microsoft account security code',
    snippet:
      "Security code: 839102. If you didn't request this code, you can safely ignore this email.",
    from: 'Microsoft account team <account-security-noreply@accountprotection.microsoft.com>',
    expected: { code: '839102', service: 'Microsoft account team' },
  },
  {
    name: 'Steam Guard alphanumeric token',
    subject: 'Your Steam account: Access from new web or mobile device',
    snippet: 'Here is the Steam Guard code you need to login: 7V2N9',
    from: 'Steam Support <noreply@steampowered.com>',
    expected: { code: '7V2N9', service: 'Steam Support' },
  },
  {
    name: 'Stripe hyphenated verification code',
    subject: 'Your Stripe verification code is 492-184',
    snippet: 'Use 492-184 to complete your login.',
    from: 'Stripe <support@stripe.com>',
    expected: { code: '492184', service: 'Stripe' },
  },
  {
    name: 'Discord verification code',
    subject: 'Discord Login Verification Code',
    snippet: 'Hey there! Your Discord verification code is: 381940',
    from: 'Discord <noreply@discord.com>',
    expected: { code: '381940', service: 'Discord' },
  },
  {
    name: 'Uber 4-digit PIN',
    subject: 'Your Uber code is 4912',
    snippet: 'Never share this code with anyone. Uber employees will never ask for it.',
    from: 'Uber <uber@uber.com>',
    expected: { code: '4912', service: 'Uber' },
  },
  {
    name: 'Apple Account verification code',
    subject: 'Your Apple Account verification code',
    snippet: "Your Apple Account verification code is: 582910. Don't share it with anyone.",
    from: 'Apple <appleid@id.apple.com>',
    expected: { code: '582910', service: 'Apple' },
  },
  {
    name: 'PayPal security code',
    subject: 'PayPal: Your security code is 840192',
    snippet: 'Enter this code to confirm your phone number.',
    from: 'PayPal <service@paypal.co.uk>',
    expected: { code: '840192', service: 'PayPal' },
  },
  {
    name: 'Notion space-separated code',
    subject: '194 821 is your temporary Notion login code',
    snippet: 'This code expires in 15 minutes.',
    from: 'Notion <team@m.notion.so>',
    expected: { code: '194821', service: 'Notion' },
  },
  {
    name: 'Airbnb verification code',
    subject: '492019 is your Airbnb verification code',
    snippet: 'Enter this code to finish logging in to Airbnb.',
    from: 'Airbnb <automated@airbnb.com>',
    expected: { code: '492019', service: 'Airbnb' },
  },

  // --- Adversarial negatives (must return null) ---
  {
    name: 'LinkedIn device notification advising to check authenticator app (no OTP in email)',
    subject: 'Please verify your new device',
    snippet:
      'We noticed you recently tried to sign in. You can finish signing in by inputting the code generated by your authenticator app.',
    from: 'LinkedIn <security-noreply@linkedin.com>',
    expected: null,
  },
  {
    name: 'Email verification magic link with URL (no OTP digits)',
    subject: 'Verify your email address',
    snippet:
      'Please click the button below to verify your email address. https://example.com/email/verify/84371/4047ae4ad40fe6ae',
    from: 'Support <hello@example.com>',
    expected: null,
  },
  {
    name: 'Sign-in notification with date and time (no OTP digits)',
    subject: 'goodreads.com: Sign-in',
    snippet:
      'Someone signed-in to your account. When: Nov 02, 2026 03:20 PM GMT Device: Google Chrome macOS Near: Wandsworth, UK',
    from: '"goodreads.com" <account-update@goodreads.com>',
    expected: null,
  },
  {
    name: 'Order confirmation with order number, year and total',
    subject: 'Your order confirmation #948201',
    snippet:
      'Thanks for your purchase in 2026! Order total: $42.00. Order #948201 has been dispatched.',
    from: 'Store <orders@store.com>',
    expected: null,
  },
  {
    name: 'Package tracking number update',
    subject: 'Your package is on its way!',
    snippet: 'USPS Tracking: 9400 1000 0000 0000 1234 56. Estimated delivery: May 12.',
    from: 'USPS <tracking@usps.com>',
    expected: null,
  },
  {
    name: 'Payment receipt with card ending and invoice ID',
    subject: 'Invoice INV-2026-84920',
    snippet: 'Paid £120.00 on 24 Oct 2026. Account ending: 4920. Reference #84920.',
    from: 'Billing <billing@service.com>',
    expected: null,
  },
  {
    name: 'Calendar invitation with time and year',
    subject: 'Accepted: Project sync @ Tue 20 Oct 2026 10:00 - 10:30',
    snippet: 'Jane Doe has accepted this invitation for 2026.',
    from: 'Calendar <calendar-notification@google.com>',
    expected: null,
  },
  {
    name: '1Password sign-in notification',
    subject: 'New 1Password sign-in alert',
    snippet: 'Your 1Password account was signed in from a new browser on 2026-10-08 at 15:44 GMT.',
    from: '1Password <hello@1password.com>',
    expected: null,
  },
];

describe('verification code corpus', () => {
  for (const tc of CORPUS) {
    it(tc.name, () => {
      const result = extractVerificationCode(tc.subject, tc.snippet, tc.from);
      expect(result).toEqual(tc.expected);
    });
  }
});
