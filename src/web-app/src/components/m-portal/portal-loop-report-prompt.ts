/** User message sent when the operator agrees to a post-end detail report. */
export function buildLoopReportPrompt(opts: {
  loopId: string
  childJobCount: number
  zh: boolean
}): string {
  const n = opts.childJobCount
  if (opts.zh) {
    const countBit = n > 0 ? `（约 ${n} 个）` : ''
    return (
      `请只基于本 Loop（id: ${opts.loopId}）各轮子代理的产出${countBit}，`
      + `整理一份详细分析报告：综合结论、关键证据与可执行建议。`
      + `不要混入本线程更早的历史任务或其它 Loop。`
      + `报告完成后落盘到 PROJECTS/loops/，并在聊天中展示全文。`
    )
  }
  const countBit = n > 0 ? ` (~${n})` : ''
  return (
    `Please write a detailed analysis report based only on this Loop `
    + `(id: ${opts.loopId}) subagent outputs${countBit}: `
    + `synthesis, key evidence, and actionable recommendations. `
    + `Do not mix in earlier jobs or other Loops on this thread. `
    + `Save the report under PROJECTS/loops/ and show the full text in chat.`
  )
}
