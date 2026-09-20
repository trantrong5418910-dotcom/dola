/** Server-only media URLs and upstream payloads must never enter user JSON. */
export function publicTask(task) {
  const result = {};
  for (const key of [
    'id', 'status', 'statusText', 'stage', 'error', 'notice', 'createdAt',
    'finishedAt', 'prompt', 'ratio', 'seconds', 'durationSec', 'forceSeconds',
    'isUnwatermarked', 'archived', 'unwatermarkNote', 'done', 'refunded',
    'balance', 'bytes',
  ]) {
    const value = task[key];
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
      if (value !== undefined) result[key] = value;
    }
  }
  result.mediaReady = task.status === 'succeeded' && Boolean(task.url);
  return result;
}
