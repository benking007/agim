// Curated compact briefs for shipped skills (framework / builtin / ECC).
// Workspace skills use compactSkillBrief() on their SKILL.md description.
// Frontmatter `brief:` on any skill overrides this table.

export const SHIPPED_SKILL_BRIEFS: Readonly<Record<string, string>> = {
  // Framework
  'agim-memory': '长期事实记忆(5W1H)',
  'agim-reminders': '提醒设置/列表/取消/延后',
  'agim-self': '内置斜杠命令&MCP工具速查',
  'agim-skill-discovery': '从skillhub发现/安装/更新技能',

  // Agim builtin
  'coding-verify': '编码循环(编辑→诊断→测试→门禁)',
  'exec-sandbox': 'Linux bwrap隔离执行',
  'git-workflow': 'Git规范提交与自检',
  github: 'gh CLI操作GitHub',
  'image-generation': '图像生成处理(有/无工具)',
  'long-goal': '多轮长期目标(聚焦+循环)',
  my: '查询Agent自身状态(模型/目录/上下文)',
  'playwright-mcp': 'Playwright浏览器自动化(MCP)',
  'python-ruff': 'Python Ruff质量门禁',
  'skill-creator': '创建/更新SKILL.md技能包',
  summarize: '摘要URL/文章/PDF/YouTube',
  'systemd-ops': '管理systemd服务(fin-data等)',
  tmux: '远程控制tmux会话(REPL/交互)',
  weather: '当前天气与短期预报',

  // ECC harness
  'agent-eval': '编码Agent对比评测(通过率/成本)',
  'agent-harness-construction': '设计优化Agent动作空间与工具',
  'agent-introspection-debugging': 'Agent失败结构化调试',
  'agentic-engineering': '评估优先、分解、成本感知工程',
  'api-design': 'REST API设计模式(资源命名/状态码)',
  'architecture-decision-records': '捕获架构决策(ADR)',
  'article-writing': '长文撰写(博客/教程/通讯)',
  'autonomous-agent-harness': '全自主Agent系统(持久记忆/调度)',
  'autonomous-loops': '自主循环模式(流水线到RFC驱动)',
  'backend-patterns': '后端架构/API/数据库最佳实践',
  benchmark: '性能基线测量与回归检测',
  blueprint: '单行目标转多会话施工计划',
  'code-tour': '创建CodeTour .tour文件(分步导览)',
  'coding-standards': '跨项目编码规范(命名/可读性)',
  'context-budget': '上下文窗口消耗审计',
  'continuous-learning-v2': '本能学习系统(观察→原子本能)',
  'cost-aware-llm-pipeline': 'LLM API成本优化(模型路由/预算)',
  'product-capability': '从PRD到可实施能力计划',
  'product-lens': '验证“为什么”并做产品诊断',
  'prompt-optimizer': '分析提示并匹配ECC组件输出优化',
  'regex-vs-llm-structured-text': '解析结构化文本时正则与LLM决策框架',
  'security-bounty-hunter': '挖掘可利用安全漏洞',
  'security-scan': '扫描Claude配置安全漏洞',
  'tdd-workflow': 'TDD工作流(新功能/修复/重构)',
  'team-agent-orchestration': '团队Agent编排(工作项/看板/合并门禁)',
  'verification-loop': '综合验证系统',
}

export function shippedSkillBrief(name: string): string | undefined {
  return SHIPPED_SKILL_BRIEFS[name]
}
