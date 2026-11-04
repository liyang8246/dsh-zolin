// Asserts the two WorkBuddy answer parsers. Run with `node scripts/self-check.ts`.
import assert from 'node:assert/strict'
import { parseWorkBuddyBenefit, parseWorkBuddyCheckin, parseWorkBuddyModels, parseWorkBuddyQuota } from '../src/providers/workbuddy.ts'

const catalog = {
  code: 0,
  data: {
    models: [
      {
        id: 'glm-5.3',
        name: 'GLM 5.3',
        contextWindow: {
          defaultLength: 300_000,
          supportedLengths: [300_000, 1_000_000],
        },
        maxInputTokens: 1_000_000,
        maxOutputTokens: 64_000,
        supportsImages: true,
        supportsToolCall: true,
        reasoning: {
          supportedEfforts: ['low', 'high', 'off'],
        },
      },
      {
        id: 'auto',
        contextWindow: { defaultLength: 1 },
        maxInputTokens: 1,
        maxOutputTokens: 1,
        supportsToolCall: true,
      },
      {
        id: 'hidden',
        maxInputTokens: 1000,
        maxOutputTokens: 100,
        disabled: true,
        supportsToolCall: true,
      },
      {
        id: 'hunyuan-3b',
        maxInputTokens: 8000,
        maxOutputTokens: 1000,
        supportsToolCall: false,
      },
      {
        id: 'broken',
        maxInputTokens: 0,
        maxOutputTokens: 100,
        supportsToolCall: true,
      },
    ],
  },
}
const models = parseWorkBuddyModels(catalog)
assert.equal(models.length, 1, 'routers, disabled, non-chat and unusable entries are dropped')
assert.deepEqual(models[0], {
  id: 'glm-5.3',
  name: 'GLM 5.3',
  contextWindow: 300_000,
  maxTokens: 64_000,
  input: ['text', 'image'],
  reasoning: true,
  reasoningEfforts: ['low', 'high'],
  reasoningField: 'reasoning_content',
})
assert.throws(() => parseWorkBuddyModels({
  code: 0,
  data: { models: null },
}), /no usable models|Invalid WorkBuddy model list/)

const checkin = parseWorkBuddyCheckin({
  code: 0,
  data: {
    active: true,
    today_checked_in: true,
    streak_days: 7,
    daily_credit: 100,
    week_progress: [
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ],
  },
})
assert.deepEqual(checkin, {
  active: true,
  checkedIn: true,
  streakDays: 7,
  dailyCredit: 100,
  weekProgress: [
    true,
    true,
    true,
    false,
    false,
    false,
    false,
  ],
})
assert.equal(parseWorkBuddyCheckin({ code: 0, data: {} }).active, false, 'a missing body is not an active campaign')

assert.deepEqual(parseWorkBuddyBenefit({
  code: 0,
  data: {
    active: true,
    claimed: false,
    credit_num: 1500,
    end_time: '2026-11-30 23:59:59',
  },
}, 'gift'), [
  { kind: 'gift', creditNum: 1500, endTime: '2026-11-30 23:59:59' },
])
assert.deepEqual(parseWorkBuddyBenefit({
  code: 0,
  data: { active: false, claimed: false, credit_num: 500 },
}, 'compensation'), [], 'an ended campaign is not offered')
assert.deepEqual(parseWorkBuddyBenefit({
  code: 0,
  data: { active: true, claimed: true, credit_num: 1500 },
}, 'gift'), [], 'a claimed grant is not offered twice')

function credits(accounts: unknown[]) {
  return {
    code: 0,
    data: {
      Response: {
        Data: { Accounts: accounts },
      },
    },
  }
}
const quota = parseWorkBuddyQuota(credits([
  {
    CapacityType: 4,
    CycleCapacityRemain: '96',
    CycleCapacityRemainPrecise: '96.61',
    CycleCapacitySize: 120,
  },
  { CapacityType: 1, CapacityRemain: 3, CapacitySize: 30 },
]))
assert.equal(quota.status, 'ok')
assert.equal(quota.windows[0]?.limit, 150, 'limits sum the cycle and the gift capacity')
assert.equal(quota.windows[0]?.used, 50.39, 'the precise remain wins over the integer')
assert.equal(quota.windows[0]?.exhausted, undefined)
assert.equal(parseWorkBuddyQuota(credits([
  { CycleCapacityRemain: 0, CycleCapacitySize: 10 },
])).windows[0]?.exhausted, true)
assert.equal(parseWorkBuddyQuota({ code: 0, data: {} }).status, 'unavailable')

console.log('workbuddy self-check ok')
