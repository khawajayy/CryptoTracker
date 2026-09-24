const { test, expect } = require('@playwright/test');
const {
  calculateStepUpGoal,
  validateStepUpGoal,
  tradesToGoal,
  roundCurrency
} = require("../../js/goal-calc.js");

test.describe('GoalCalc - Validation', () => {
  test('rejects missing or invalid starting amount', () => {
    expect(validateStepUpGoal(null).valid).toBe(false);
    expect(validateStepUpGoal({ startAmount: 0, steps: [{ target: 100, profitPct: 10 }] }).valid).toBe(false);
    expect(validateStepUpGoal({ startAmount: -500, steps: [{ target: 100, profitPct: 10 }] }).valid).toBe(false);
    expect(validateStepUpGoal({ startAmount: NaN, steps: [{ target: 100, profitPct: 10 }] }).valid).toBe(false);
  });

  test('rejects empty or invalid steps array', () => {
    expect(validateStepUpGoal({ startAmount: 1000, steps: [] }).valid).toBe(false);
    expect(validateStepUpGoal({ startAmount: 1000, steps: null }).valid).toBe(false);
  });

  test('rejects zero or negative step target amounts', () => {
    expect(validateStepUpGoal({
      startAmount: 1000,
      steps: [{ target: 0, profitPct: 10 }]
    }).valid).toBe(false);

    expect(validateStepUpGoal({
      startAmount: 1000,
      steps: [{ target: -100, profitPct: 10 }]
    }).valid).toBe(false);
  });

  test('rejects zero or negative profit percentages', () => {
    expect(validateStepUpGoal({
      startAmount: 1000,
      steps: [{ target: 5000, profitPct: 0 }]
    }).valid).toBe(false);

    expect(validateStepUpGoal({
      startAmount: 1000,
      steps: [{ target: 5000, profitPct: -5 }]
    }).valid).toBe(false);
  });

  test('rejects non-increasing step targets', () => {
    expect(validateStepUpGoal({
      startAmount: 1000,
      steps: [
        { target: 5000, profitPct: 10 },
        { target: 4000, profitPct: 10 }
      ]
    }).valid).toBe(false);

    expect(validateStepUpGoal({
      startAmount: 1000,
      steps: [
        { target: 5000, profitPct: 10 },
        { target: 5000, profitPct: 10 }
      ]
    }).valid).toBe(false);
  });

  test('accepts valid multi-step configuration', () => {
    const res = validateStepUpGoal({
      startAmount: 10000,
      steps: [
        { target: 15000, profitPct: 20 },
        { target: 30000, profitPct: 15 },
        { target: 100000, profitPct: 10 }
      ]
    });
    expect(res.valid).toBe(true);
    expect(res.error).toBeUndefined();
  });
});

test.describe('GoalCalc - Step-Up Calculation', () => {
  test('single step calculation', () => {
    const result = calculateStepUpGoal({
      startAmount: 10000,
      steps: [{ target: 15000, profitPct: 20 }]
    });

    expect(result.valid).toBe(true);
    expect(result.totalTrades).toBe(3);
    // Trade 1: 10000 * 1.20 = 12000
    // Trade 2: 12000 * 1.20 = 14400
    // Trade 3: 14400 * 1.20 = 17280
    expect(result.finalBalance).toBe(17280);
    expect(result.totalProfit).toBe(7280);
    expect(result.goalAmount).toBe(15000);
    expect(result.overshootAmount).toBe(2280);

    expect(result.steps.length).toBe(1);
    expect(result.steps[0].startingBalance).toBe(10000);
    expect(result.steps[0].endingBalance).toBe(17280);
    expect(result.steps[0].tradesCount).toBe(3);
    expect(result.steps[0].profitGenerated).toBe(7280);

    expect(result.trades.length).toBe(4); // Trade 0 + 3 trades
    expect(result.trades[0].endingBalance).toBe(10000);
    expect(result.trades[1].endingBalance).toBe(12000);
    expect(result.trades[2].endingBalance).toBe(14400);
    expect(result.trades[3].endingBalance).toBe(17280);
  });

  test('two-step calculation: exactly matches specification and does not restart from target', () => {
    // Starting balance: $10,000
    // Step 1: Target $15,000, Profit 20%
    // Step 2: Target $100,000, Profit 10%
    const result = calculateStepUpGoal({
      startAmount: 10000,
      steps: [
        { target: 15000, profitPct: 20 },
        { target: 100000, profitPct: 10 }
      ]
    });

    expect(result.valid).toBe(true);

    // Step 1 check
    const step1 = result.steps[0];
    expect(step1.startingBalance).toBe(10000);
    expect(step1.endingBalance).toBe(17280);
    expect(step1.tradesCount).toBe(3);

    // Step 2 check: MUST start at $17,280, NOT $15,000!
    const step2 = result.steps[1];
    expect(step2.startingBalance).toBe(17280);

    // Progression verification:
    // Trade 4: 17280 * 1.10 = 19008
    // Trade 5: 19008 * 1.10 = 20908.80
    expect(result.trades[4].trade).toBe(4);
    expect(result.trades[4].step).toBe(2);
    expect(result.trades[4].profitPct).toBe(10);
    expect(result.trades[4].startingBalance).toBe(17280);
    expect(result.trades[4].profit).toBe(1728);
    expect(result.trades[4].endingBalance).toBe(19008);

    expect(result.trades[5].trade).toBe(5);
    expect(result.trades[5].startingBalance).toBe(19008);
    expect(result.trades[5].endingBalance).toBe(20908.80);

    // Step 2 target is 100,000. Compounding 17280 at 10%:
    // n = ceil( ln(100000/17280) / ln(1.1) ) = ceil(18.423...) = 19 trades
    expect(step2.tradesCount).toBe(19);
    expect(result.totalTrades).toBe(3 + 19); // 22 trades total
    expect(step2.endingBalance).toBeGreaterThanOrEqual(100000);
    expect(result.finalBalance).toBe(step2.endingBalance);
    expect(result.overshootAmount).toBe(roundCurrency(result.finalBalance - 100000));
  });

  test('three or more steps calculation', () => {
    const result = calculateStepUpGoal({
      startAmount: 10000,
      steps: [
        { target: 15000, profitPct: 20 },
        { target: 30000, profitPct: 15 },
        { target: 50000, profitPct: 12 },
        { target: 100000, profitPct: 10 }
      ]
    });

    expect(result.valid).toBe(true);
    expect(result.steps.length).toBe(4);

    // Each step starts from previous step ending balance
    expect(result.steps[1].startingBalance).toBe(result.steps[0].endingBalance);
    expect(result.steps[2].startingBalance).toBe(result.steps[1].endingBalance);
    expect(result.steps[3].startingBalance).toBe(result.steps[2].endingBalance);

    expect(result.finalBalance).toBeGreaterThanOrEqual(100000);
    expect(result.totalTrades).toBe(
      result.steps[0].tradesCount +
      result.steps[1].tradesCount +
      result.steps[2].tradesCount +
      result.steps[3].tradesCount
    );
  });

  test('starting amount already exceeds a step target', () => {
    // Starting amount = $20,000, Step 1 target = $15,000, Step 2 target = $50,000
    const result = calculateStepUpGoal({
      startAmount: 20000,
      steps: [
        { target: 15000, profitPct: 20 },
        { target: 50000, profitPct: 10 }
      ]
    });

    expect(result.valid).toBe(true);
    // Step 1 should perform 0 trades and end at 20000
    expect(result.steps[0].tradesCount).toBe(0);
    expect(result.steps[0].startingBalance).toBe(20000);
    expect(result.steps[0].endingBalance).toBe(20000);
    expect(result.steps[0].profitGenerated).toBe(0);

    // Step 2 should begin at 20000
    expect(result.steps[1].startingBalance).toBe(20000);
    expect(result.steps[1].tradesCount).toBeGreaterThan(0);
    expect(result.steps[1].endingBalance).toBeGreaterThanOrEqual(50000);

    // Total trades should equal Step 2 trades
    expect(result.totalTrades).toBe(result.steps[1].tradesCount);
  });

  test('starting amount exceeds ALL step targets', () => {
    const result = calculateStepUpGoal({
      startAmount: 120000,
      steps: [
        { target: 50000, profitPct: 10 },
        { target: 100000, profitPct: 5 }
      ]
    });

    expect(result.valid).toBe(true);
    expect(result.totalTrades).toBe(0);
    expect(result.finalBalance).toBe(120000);
    expect(result.overshootAmount).toBe(20000);
  });

  test('very small profit percentages (0.1%, 0.5%, 1%)', () => {
    const result = calculateStepUpGoal({
      startAmount: 1000,
      steps: [
        { target: 1010, profitPct: 0.1 },
        { target: 1050, profitPct: 0.5 },
        { target: 1100, profitPct: 1 }
      ]
    });

    expect(result.valid).toBe(true);
    expect(result.totalTrades).toBeGreaterThan(0);
    expect(result.finalBalance).toBeGreaterThanOrEqual(1100);
    // Check no NaN or floating point garbage
    expect(Number.isFinite(result.finalBalance)).toBe(true);
    expect(String(result.finalBalance)).not.toMatch(/\.\d{3,}/);
  });

  test('large values ($1,000,000+)', () => {
    const result = calculateStepUpGoal({
      startAmount: 50000,
      steps: [
        { target: 250000, profitPct: 15 },
        { target: 1000000, profitPct: 8 },
        { target: 5000000, profitPct: 5 }
      ]
    });

    expect(result.valid).toBe(true);
    expect(result.finalBalance).toBeGreaterThanOrEqual(5000000);
    expect(Number.isFinite(result.totalProfit)).toBe(true);
    expect(result.totalTrades).toBeLessThan(1000);
  });

  test('tradesToGoal fixed formula matches single-step behavior', () => {
    const fixedTrades = tradesToGoal(10000, 15000, 20);
    expect(fixedTrades).toBe(3);

    const stepUpResult = calculateStepUpGoal({
      startAmount: 10000,
      steps: [{ target: 15000, profitPct: 20 }]
    });
    expect(stepUpResult.totalTrades).toBe(fixedTrades);
  });
});
