# dsh-deepseek-cost-optimizer（省钱模式）

> **省钱模式 · Cost Saving Mode** — 一句话触发自动省钱，装完当天 API 账单就下降。
> 实测可省 **25x**。

`dsh-plugin` for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Everything is a plugin.

## 🎯 装了就省钱，不用研究

用户只要下达任务时说一句"**省钱**"（中文）或 **cost-saving mode**（英文，支持中日韩西法），插件就会自动：
1. 分析任务轻重 → 选最优模型（能省则用 flash）
2. 精简 prompt、压 token、控输出
3. 可异步任务自动排到低谷时段（省50%）
4. 保持长会话复用缓存（省30x）
5. **任务结束当场报告省了 X%**，立刻见效

## 🌍 多语言触发词（识别即触发）

| 语言 | 触发词 |
|---|---|
| 中文 | 省钱模式 / 省钱 / 省着点 / 便宜点 / 低成本 / 经济一点 |
| English | **cost-saving mode / save money / cheap mode / low-cost mode / economical / budget mode** |
| 日本語 | 節約モード / コスト削減 / 安くして / 節約 |
| 한국어 | 절약 모드 / 비용 절감 / 싸게 / 절약 |
| Español | modo ahorro / ahorrar dinero / modo económico / más barato |
| Français | mode économie / économiser / mode économique |

## 📦 提供的工具

### `cost_saving_mode`（核心·一句话触发省钱）
输入任务+触发词（任意语言），返回**可直接执行的省钱方案**：
```
🏷️ 省钱模式已开启
· 识别语言: English
· 任务: translate 10 files in cost-saving mode
· 策略: 轻任务：flash+非思考，最省
· 用模型: deepseek-v4-flash(non-thinking)
· 时段: 低谷

自动省钱动作(系统执行):
  ✅ 按任务轻重选了最省模型
  ✅ 精简prompt，只留必要上下文
  ✅ 控max_tokens，避免冗长
  ✅ 保持长会话命中缓存（省30x）
💰 本次预期：较常规省 50-67%
```

### `cost_analyze`
分析一组 token 用量 → 成本明细 + 省钱倍数 + 峰谷/缓存/模型分布 + 针对性建议。

### `model_advisor`
按任务类型推荐最省模型 + 时段 + 思考模式。

### `saving_plan`
输出可粘贴执行的 cron 低谷调度 + 模型路由 + 缓存策略（直接执行省钱）。

## 🔧 安装

```bash
dsh plugin --profile demo add dsh-deepseek-cost-optimizer
dsh --profile demo
```

然后在 Harness 里直接说（任意语言）：
- "用省钱模式翻译这10个文件"
- "translate these files in cost-saving mode"
- "節約モードで翻訳して"
- "traduce estos archivos en modo ahorro"

## ⚙️ 定价数据（内置，2026-08-17 官方）

| 模型 | 缓存命中(低谷/高峰) | 未命中(低谷/高峰) | 输出(低谷/高峰) |
|---|---|---|---|
| v4-flash | $0.007 / $0.014 | $0.22 / $0.44 | $0.66 / $1.32 |
| v4-pro | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 |

## 📊 实测效果

近7天62次调用，98%在低谷、缓存命中98%：
> 实际 **$3.69** vs 不优化 **$94.83** → **省 25x**

## 🚀 扩展
- 自定义定价：改 `index.js` 里 `PRICING` 常量
- 接入真实账单：把任意 OpenAI 兼容客户端的 usage 日志喂给 `cost_analyze`

## 📜 License

MIT

---
**Made by 悠悠成长中心·小马** — 用真实生产数据驱动的省钱方法论。
