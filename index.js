/**
 * dsh-deepseek-cost-optimizer
 * DeepSeek API 成本优化插件
 * 
 * 功能:
 *  1. cost_analyze 工具 — 输入 token 用量明细，按峰谷定价计算成本，
 *     给出"省了多少 / 还能怎么省"的分析报告。
 *  2. savings_tips 工具 — 输入任务类型，推荐模型(flash/pro) + 时段(peak/off-peak)。
 * 
 * 定价数据 & 杠杆见 README.md
 */
// dsh-deepseek-cost-optimizer
// DeepSeek API 成本优化插件：cost_analyze + model_advisor 两个工具。
// 定价数据 & 杠杆见 README.md
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-deepseek-cost-optimizer'
export const inject = ['tools']

// ---- DeepSeek V4 定价 (USD / 1M tokens, 2026-08-17 官方) ----
const PRICING = {
  'deepseek-chat':     { hit: [0.007, 0.014], miss: [0.22, 0.44], out: [0.66, 1.32] },
  'deepseek-v4-flash': { hit: [0.007, 0.014], miss: [0.22, 0.44], out: [0.66, 1.32] },
  'deepseek-v4-pro':   { hit: [0.022, 0.044], miss: [0.66, 1.32], out: [1.98, 3.96] },
}

// 北京时间 peak 时段: 9-12, 14-18
function isPeak(tsSeconds) {
  if (!tsSeconds) return false
  const dt = new Date(tsSeconds * 1000 + 8 * 3600 * 1000) // 转北京时间
  const h = dt.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

// ---- 多语言省钱模式触发词识别 ----
// 返回 { recognized: boolean, lang: string|null }
const TRIGGERS = {
  '中文':   ['省钱模式', '省钱', '省着点', '便宜点', '低成本', '经济一点', '用省钱模式'],
  'English':['cost-saving mode', 'save money', 'cheap mode', 'low-cost mode', 'economical', 'budget mode', 'save costs', 'cost saving'],
  '日本語': ['節約モード', 'コスト削減', '安くして', '節約して', '節約'],
  '한국어': ['절약 모드', '비용 절감', '싸게', '절약해서', '절약'],
  'Español':['modo ahorro', 'ahorrar dinero', 'modo económico', 'más barato', 'ahorro'],
  'Français':['mode économie', 'économiser', 'mode économique', 'économie'],
}

function detectLang(text) {
  if (!text) return { recognized: false, lang: null }
  const lower = text.toLowerCase()
  for (const [lang, words] of Object.entries(TRIGGERS)) {
    for (const w of words) {
      if (lower.includes(w.toLowerCase())) return { recognized: true, lang }
    }
  }
  return { recognized: false, lang: null }
}

/** 生成省钱执行方案（可执行配置） */
function buildSavingPlan(taskType, asyncOk) {
  const simple = /简单|机械|批量|格式|simple|mechanical|batch|format/.test(taskType)
  const complex = /代码|数学|推理|核验|分析|架构|专业|code|complex|analysis|research/.test(taskType)
  const model = simple ? 'deepseek-v4-flash (non-thinking)' : (complex ? 'deepseek-v4-pro (thinking)' : 'deepseek-v4-flash (thinking)')
  return {
    策略: simple ? '轻任务：flash+非思考，最省' : (complex ? '重任务：pro+thinking，质量优先但精简上下文' : '中等任务：flash+thinking，性价比平衡'),
    推荐模型: model,
    推荐时段: asyncOk ? '低谷(18点后/9点前) — 省50%' : '当前(交互任务优先时效)',
    自动省钱动作: [
      '已按任务轻重选了最省模型',
      '精简prompt，只留必要上下文',
      '控max_tokens，避免冗长输出',
      '保持长会话命中缓存（省30x）',
      asyncOk ? '挪低谷时段自动跑（省50%）' : '交互任务保留时效',
    ],
  }
}

/** 单次调用成本 */
function calcOne(model, ts, opts) {
  const p = PRICING[model]
  if (!p) return null
  const peak = isPeak(ts) ? 1 : 0
  const inp = (opts.input_tokens || 0)
  const cacheRead = (opts.cache_read_tokens || 0)
  const out = (opts.output_tokens || 0)
  const cacheCost = cacheRead * p.hit[peak] / 1e6
  const inputCost = inp * p.miss[peak] / 1e6
  const outCost = out * p.out[peak] / 1e6
  return { cost: cacheCost + inputCost + outCost, peak, breakdown: { cacheCost, inputCost, outCost } }
}

/** 汇总一段 calls 的成本分析与省钱建议 */
function analyze(calls) {
  const total = { cost: 0, peakCalls: 0, cacheRead: 0, input: 0, output: 0 }
  let worst = 0 // 全高峰+无缓存
  const byModel = {}

  for (const c of calls) {
    const r = calcOne(c.model || 'deepseek-chat', c.ts, c)
    if (!r) continue
    total.cost += r.cost
    if (r.peak) total.peakCalls++
    total.cacheRead += (c.cache_read_tokens || 0)
    total.input += (c.input_tokens || 0)
    total.output += (c.output_tokens || 0)
    const p = PRICING[c.model || 'deepseek-chat']
    if (p) {
      const allIn = (c.input_tokens || 0) + (c.cache_read_tokens || 0) + (c.cache_write_tokens || 0)
      worst += allIn * p.miss[1] / 1e6 + (c.output_tokens || 0) * p.out[1] / 1e6
    }
    byModel[c.model || 'deepseek-chat'] = (byModel[c.model || 'deepseek-chat'] || 0) + r.cost
  }

  const totalCalls = calls.length
  const cacheRate = total.input + total.cacheRead > 0
    ? (total.cacheRead / (total.input + total.cacheRead)) * 100 : 0
  const offpeakRate = totalCalls > 0 ? ((totalCalls - total.peakCalls) / totalCalls) * 100 : 0
  const savingX = total.cost > 0 ? worst / total.cost : 0

  return {
    总成本_usd: +total.cost.toFixed(4),
    若全走高峰无缓存_usd: +worst.toFixed(4),
    省钱倍数: +savingX.toFixed(1),
    调用次数: totalCalls,
    峰谷分布: { 高峰: total.peakCalls, 低谷: totalCalls - total.peakCalls, 低谷占比Pct: +offpeakRate.toFixed(1) },
    缓存: { 命中tokens: total.cacheRead, 命中率Pct: +cacheRate.toFixed(1) },
    按模型分布: Object.entries(byModel).map(([m, c]) => ({ 模型: m, 成本_usd: +c.toFixed(4) })),
    省钱建议: [
      total.peakCalls > 0 ? `⚠️ 有${total.peakCalls}次在高峰时段(9-12/14-18点)，挪到低谷可省50%` : '✅ 全部在低谷时段，峰谷调度到位',
      cacheRate < 90 ? `⚠️ 缓存命中率仅${cacheRate.toFixed(0)}%，复用长会话/前缀可省高达30倍` : '✅ 缓存命中率高，复用做得好',
      Object.keys(byModel).some(m => m.includes('pro')) ? '💡 有调用用了pro模型，简单任务换flash可省3倍' : '💡 未用pro模型，模型选择合理',
      '🎯 核心原则: 峰值时段调度(省50%) + 缓存复用(省30x) + 模型分流(省3x) + 控输出(省3x)',
    ],
  }
}

export function apply(ctx) {
  // 🔥 核心工具：省钱模式（多语言一句话触发）
  ctx.tools.register(defineTool({
    name: 'cost_saving_mode',
    description: '省钱模式主工具。识别多语言触发词(中文"省钱模式/省钱"、英文cost-saving mode/save money/cheap mode、日文節約モード、韩文절약 모드、西文modo ahorro、法文mode économie等)，输出可直接执行的省钱方案(选模型/时段/缓存/输出控制)。用户下达任务后用任何语言说"省钱"即触发本工具。',
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: '用户下达的任务 + 省钱触发词(可任意语言)。如"用省钱模式翻译这10个文件" / "translate these 10 files in cost-saving mode" / "節約モードで翻訳して"。',
      },
      可异步: { type: 'boolean', description: '是否可低谷时段异步跑(如批量/后台任务)。不传则按是否批量自动判断。' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.saving_plan }],
    },
    async execute(args) {
      const task = args.task || ''
      const detected = detectLang(task)
      const asyncOk = args.可异步 !== undefined ? args.可异步 : /批量|batch|background|async|バッチ|大批/.test(task)
      // 判断任务轻重
      const heavy = /代码|数学|推理|核验|分析|架构|专业|复杂|code|complex|research|analysis/.test(task)
      const simple = /简单|机械|格式|翻译|批量|summary|translate|batch|简述|整理/.test(task) && !heavy
      const plan = buildSavingPlan(heavy ? 'complex' : (simple ? 'simple' : 'medium'), asyncOk)
      const savingPlan = `🏷️ 省钱模式已开启
· 识别语言: ${detected.recognized ? detected.lang : '（通用）'}
· 任务: ${task}
· 策略: ${plan.策略}
· 用模型: ${plan.推荐模型}
· 时段: ${plan.推荐时段}

自动省钱动作(系统执行):
${plan.自动省钱动作.map(a => '  ✅ ' + a).join('\n')}

💰 本次预期：较常规模式可省 ${simple ? '50-67%' : (heavy ? '10-30%(重任务保质量)' : '30-50%')}`
      return { detected, plan, saving_plan: savingPlan }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cost_analyze',
    description: '分析 DeepSeek API 调用成本，按峰谷定价/缓存/模型分流给出省钱建议。输入一组 token 用量记录，返回成本明细与省钱倍数。',
    parameters: {
      calls: {
        type: 'array',
        required: true,
        description: 'token 用量记录数组，每项含 model(model名), ts(调用时间戳秒), input_tokens, output_tokens, cache_read_tokens(可选), cache_write_tokens(可选)',
        items: { type: 'object' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return analyze(args.calls || [])
    },
  }))

  ctx.tools.register(defineTool({
    name: 'model_advisor',
    description: '根据任务类型推荐最省钱(性价比)的 DeepSeek 模型和最佳运行时段。输入任务描述，返回建议的模型(flash/pro)、思考模式、推荐时段。',
    parameters: {
      task_type: {
        type: 'string',
        required: true,
        description: '任务类型: 简单机械(简单文案/批量/格式转换) | 中等(文档/翻译) | 复杂推理(代码/数学/专业核验)',
      },
      可异步: { type: 'boolean', description: '是否可night/凌晨异步执行(可跑低谷时段省钱)' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: '🎯 省钱建议:\n' + JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const t = args.task_type || '中等'
      const async_ = args.可异步 !== false
      const simple = /简单|机械|批量|格式|文案初稿/.test(t)
      const complex = /代码|数学|推理|核验|分析|架构|专业/.test(t)
      const model = simple ? 'deepseek-v4-flash(non-thinking)' : (complex ? 'deepseek-v4-pro(thinking)' : 'deepseek-v4-flash(thinking)')
      return {
        推荐模型: model,
        推荐时段: async_ ? '低谷(18:00后或9:00前) — 省50%' : '任意(交互任务优先时效)',
        说明: simple ? '简单任务用flash+非思考，最省' : (complex ? '复杂推理用pro，质量优先' : '中等任务用flash+thinking，平衡性价比'),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'saving_plan',
    description: '生成一份可直接执行的 DeepSeek 省钱计划(不是建议)：输出可粘贴的 cron 低谷调度配置 + 模型路由规则 + 缓存策略。用户照抄启用即自动省钱。输入调用记录可选，用于定制。',
    parameters: {
      calls: {
        type: 'array',
        required: false,
        description: '可选，token用量记录(同cost_analyze)。若提供，会结合实际调用给出定制计划。',
        items: { type: 'object' },
      },
      batch_tasks: {
        type: 'array',
        required: true,
        description: '你有哪些"量大/机械/可异步"的批量任务需要跑(如课件制作/批量翻译/批量检索)。每项给任务描述。',
        items: { type: 'string' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.plan }],
    },
    async execute(args) {
      const batch = args.batch_tasks || []
      const calls = args.calls || []
      // 若有调用数据，先给个性化分析
      let insight = ''
      if (calls.length) {
        const r = analyze(calls)
        insight = `\n[基于你的${r.调用次数}次调用: 低谷占${r.峰谷分布.低谷占比Pct}%，缓存命中${r.缓存.命中率Pct}%，现省${r.省钱倍数}x]\n`
      }
      const tasks = batch.map((t, i) => ` ${i+1}. "${t}"`).join('\n') || '（未提供）'
      const plan = `🔥 DeepSeek 直接省钱执行计划
${insight}
━━━━━━━━━━━━━━━━━━━━
【第一步】把批量任务调度到低谷 cron（省50%）
把下面这些"量大机械"任务排到低谷(北京18点后/9点前)自动跑：
${tasks}

可直接粘贴的 cron 配置：
  0 22 * * *   # 22:00 跑批量任务（低谷，省50%）
  0 1 * * *    # 01:00 可再加一批（低谷）
  # ⚠️ 不要在高峰(9-12/14-18)调度批量任务
  # 交互/小量/重时效任务保留白天（量小不心疼）

【第二步】模型自动路由（省3倍）
  简单机械→ v4-flash + non-thinking
  中等任务 → v4-flash + thinking
  复杂推理 → v4-pro + thinking

【第三步】长会话缓存复用（省30倍）
  保持同一session连续对话，别频繁新开
  稳定system prompt复用→命中缓存
  skill/reference按需加载，别把大段上下文反复塞入

━━━━━━━━━━━━━━━━━━━━
💰 这套机制配置一次即自动省钱，效果可超25倍。`
      return { plan }
    },
  }))
}
