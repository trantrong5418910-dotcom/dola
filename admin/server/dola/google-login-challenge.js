// Detect the presence/type of a challenge only. Never read or solve its contents.
export function classifyGoogleChallenge({ pathname = '', text = '', captchaVisible = false } = {}) {
  if (captchaVisible || /recaptcha|captcha|输入.{0,8}(?:图片|图像|字符)|enter the (?:characters|text) (?:you see|shown)|确认您不是机器人|prove you.re not a robot/i.test(text)) return 'captcha';
  if (/\/signin\/rejected/.test(pathname)
      || /browser or app may not be secure|此浏览器或应用可能不安全|浏览器.{0,8}不安全|安全性较低/i.test(text)) return 'browser_blocked';
  if (/\/challenge\/(?!pwd(?:\/|$))|\/signup|\/recovery/.test(pathname)
      || /couldn.t sign you in|无法登录|验证您|verify it.s you|verify your identity|2-step verification|两步验证/i.test(text)) return 'security';
  return null;
}

export async function detectGoogleChallenge(page, text) {
  // A legacy image CAPTCHA can appear on the ordinary identifier page.
  // Visibility matters: hidden reCAPTCHA scripts/frames alone are not challenges.
  const candidates = page.locator([
    'input[name="ca"]', 'input[name="captcha"]', 'input#ca',
    'input[name="recaptcha_response_field"]', 'input[autocomplete="one-time-code"]',
    'img[src*="/Captcha"]', 'img#captchaimg',
    'iframe[src*="/recaptcha/"]', 'iframe[title*="reCAPTCHA"]',
  ].join(','));
  let captchaVisible = false;
  for (let index = 0, count = await candidates.count(); index < count; index++) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible()) {
      // An OTP is an identity challenge, not an image CAPTCHA.
      if (await candidate.getAttribute('autocomplete') === 'one-time-code') return 'security';
      captchaVisible = true; break;
    }
  }
  return classifyGoogleChallenge({ pathname: new URL(page.url()).pathname, text, captchaVisible });
}
