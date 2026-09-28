import { isNativeVideoRequest, SUPPORTED_VIDEO_SECONDS } from './generation-policy.js';
import { rewriteVideoDurationBody } from './generation-request.js';

/**
 * Transport evidence only, not proof that a generated video used an image.
 * The locally captured frontend maps content_blocks_v2 to messages[].content_block
 * and writes uploadResult.ImageUri to attachment.image.uri before sending.
 * Only that structured attachment path counts; prompts, previews and local
 * attachment identifiers cannot stand in for uploaded image references.
 * Unknown request shapes fail closed until their upload binding is understood.
 */
function hasReferenceImageAttachments(body, expectedCount) {
  if (typeof body !== 'string' || body.length > 1024 * 1024) return false;
  try {
    const root = JSON.parse(body);
    if (!Array.isArray(root?.messages) || root.messages.length > 128) return false;
    let count = 0;
    for (const message of root.messages) {
      const blocks = message?.content_block;
      if (!Array.isArray(blocks) || blocks.length > 128) return false;
      for (const block of blocks) {
        const attachments = block?.content?.attachment_block?.attachments;
        if (attachments === undefined) continue;
        if (!Array.isArray(attachments) || attachments.length > 128) return false;
        for (const attachment of attachments) {
          if (attachment?.image === undefined) continue;
          const uri = attachment.image?.uri;
          if (typeof uri !== 'string' || !uri.trim() || uri.length > 2048
              || /[\u0000-\u0020\u007f]/.test(uri)
              || /^(?:blob:|data:|file:|local_blob_)/i.test(uri)) return false;
          if (++count > expectedCount) return false;
        }
      }
    }
    return count === expectedCount;
  } catch { return false; }
}

/** One browser submission may forward at most one completion request.
 * Reserving happens synchronously, BEFORE network I/O; a failed continue is
 * uncertain and must never reset the reservation or trigger a second send.
 * This verifies transport parameters, not entitlement or server acceptance.
 */
export function createGenerationWireGate({ seconds, model, isActive, sessionVerified, referenceImageCount = 0 }) {
  if (!SUPPORTED_VIDEO_SECONDS.includes(Number(seconds))) throw new TypeError('Unsupported duration');
  if (!Number.isSafeInteger(referenceImageCount) || referenceImageCount < 0) throw new TypeError('Invalid reference image count');
  const expectedModel = model || (Number(seconds) === 15 ? 'seedance_v2.0' : 'seedance_v2.5');
  let rewrite = Number(seconds) === 30;
  let forwarded = 0;
  let blocked = 0;
  let lastReason = null;
  const reject = reason => {
    blocked++;
    lastReason = reason;
    return { action: 'abort', reason };
  };
  return {
    inspect(request) {
      let url;
      try { url = new URL(request.url()); } catch { return reject('invalid_url'); }
      if (!/^\/chat\/completion(?:\/|$)/.test(url.pathname)) return { action: 'unrelated' };
      if (url.origin !== 'https://www.dola.com' || url.username || url.password
          || url.pathname !== '/chat/completion' || request.method() !== 'POST') return reject('invalid_endpoint');
      if (!isActive() || !sessionVerified()) return reject('inactive_session');
      if (forwarded) return reject('duplicate_submission');
      let body = request.postData() || '';
      let matches = isNativeVideoRequest(body, seconds, expectedModel);
      // 30 秒允许用页面上的更短载体取签，再把最终提交体改成目标时长。
      // 这条路径由设置显式开启；签名参数与 body 的兼容性由上游验证，wire
      // gate 只负责保证最终送出的 body 是目标模型/时长并且只发送一次。
      // 10/20 已下线，[20,30] 里的 20 随之移除。
      if (rewrite && !matches) {
        const rewritten = rewriteVideoDurationBody(body, { seconds, targetModel: expectedModel });
        if (rewritten?.changed) body = rewritten.body;
        matches = isNativeVideoRequest(body, seconds, expectedModel);
      }
      // 15s must be checked too: a plain chat or another model is not a video.
      if (!matches) return reject('request_mismatch');
      if (referenceImageCount && !hasReferenceImageAttachments(body, referenceImageCount)) {
        return reject('reference_images_unconfirmed');
      }
      forwarded++;
      return { action: 'forward', body };
    },
    // An explicitly selected upstream composite option already carries the
    // target duration. Keep validating it, but do not rewrite its parameters.
    setRewrite(value) { rewrite = Number(seconds) === 30 && Boolean(value); },
    snapshot: () => ({ forwarded, blocked, lastReason }),
  };
}
