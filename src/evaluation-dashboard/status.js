/** Present old, explicitly unstarted records accurately without rewriting them. */
export function displayStatus(record) {
  if (record?.verdict === 'failed' && record.dispatched === 0 && !record.job_id &&
      (!Array.isArray(record.steps) || record.steps.length === 0) &&
      record.judgement === '评测在此题启动前中断，未创建此题任务。') return 'not_started';
  return record?.verdict;
}
