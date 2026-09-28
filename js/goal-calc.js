/**
 * goal-calc.js
 * Business logic and validation for Fixed and Step-Up Goal calculations in CryptoLedger.
 * Compatible with browsers (attaches to global / window.GoalCalc) and Node.js (CommonJS export).
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.GoalCalc = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_TRADES = 10000;
  const EPSILON = 1e-9;

  /**
   * Helper to round a monetary number to 2 decimal places cleanly,
   * avoiding floating-point representation artifacts.
   * @param {number} num
   * @returns {number}
   */
  function roundCurrency(num) {
    if (typeof num !== 'number' || !Number.isFinite(num)) return 0;
    return Math.round((num + Number.EPSILON) * 100) / 100;
  }

  /**
   * Number of compounding X%-profit trades to grow `from` up to `to` (Fixed Goal mode).
   * @param {number} from - starting amount
   * @param {number} to - target amount
   * @param {number} pct - profit percentage per trade
   * @returns {number|null}
   */
  function tradesToGoal(from, to, pct) {
    if (!(from > 0) || !(to > from) || !(pct > 0)) return null;
    return Math.ceil(Math.log(to / from) / Math.log(1 + pct / 100));
  }

  /**
   * Validates Step-Up Goal inputs.
   * @param {Object} params
   * @param {number} params.startAmount
   * @param {Array<{target: number, profitPct: number}>} params.steps
   * @returns {{ valid: boolean, error?: string }}
   */
  function validateStepUpGoal(params) {
    if (!params || typeof params !== 'object') {
      return { valid: false, error: 'Goal parameters are required.' };
    }

    const { startAmount, steps } = params;

    if (startAmount === undefined || startAmount === null || typeof startAmount !== 'number' || !Number.isFinite(startAmount)) {
      return { valid: false, error: 'Starting amount must be a valid number.' };
    }
    if (startAmount <= 0) {
      return { valid: false, error: 'Starting amount must be greater than 0.' };
    }

    if (!Array.isArray(steps) || steps.length === 0) {
      return { valid: false, error: 'At least one step is required.' };
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNum = i + 1;

      if (!step || typeof step !== 'object') {
        return { valid: false, error: `Step ${stepNum} is invalid.` };
      }

      const target = Number(step.target);
      const profitPct = Number(step.profitPct);

      if (!Number.isFinite(target) || target <= 0) {
        return { valid: false, error: `Step ${stepNum} target must be greater than 0.` };
      }

      if (!Number.isFinite(profitPct) || profitPct <= 0) {
        return { valid: false, error: `Step ${stepNum} profit percentage must be greater than 0.` };
      }

      if (i > 0) {
        const prevTarget = Number(steps[i - 1].target);
        if (target <= prevTarget) {
          return {
            valid: false,
            error: `Step ${stepNum} target ($${target.toLocaleString()}) must be strictly greater than Step ${i} target ($${prevTarget.toLocaleString()}).`
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Calculates sequential Step-Up Goal progression.
   *
   * Rules:
   * 1. Start with user's starting amount.
   * 2. Apply Step 1 profit % per trade until target 1 is reached or exceeded.
   * 3. Take the ACTUAL ending balance from final Step 1 trade as the starting balance for Step 2.
   * 4. Apply Step 2 profit % per trade until target 2 is reached or exceeded.
   * 5. Continue for all steps.
   *
   * @param {Object} params
   * @param {number} params.startAmount
   * @param {Array<{target: number, profitPct: number}>} params.steps
   * @returns {Object} Calculated Step-Up Goal summary and trade progression
   */
  function calculateStepUpGoal(params) {
    const validation = validateStepUpGoal(params);
    if (!validation.valid) {
      return {
        valid: false,
        error: validation.error,
        totalTrades: 0,
        initialStartingBalance: params ? params.startAmount : 0,
        finalBalance: params ? params.startAmount : 0,
        totalProfit: 0,
        goalAmount: 0,
        overshootAmount: 0,
        steps: [],
        trades: []
      };
    }

    const { startAmount, steps } = params;
    let currentBalance = roundCurrency(startAmount);

    const stepSummaries = [];
    const trades = [
      {
        trade: 0,
        step: null,
        profitPct: null,
        startingBalance: null,
        profit: null,
        endingBalance: currentBalance,
        isStepStart: false
      }
    ];

    let totalTradeCount = 0;
    let hitLimit = false;

    for (let i = 0; i < steps.length; i++) {
      const stepConfig = steps[i];
      const stepNumber = i + 1;
      const targetAmount = roundCurrency(Number(stepConfig.target));
      const profitPct = Number(stepConfig.profitPct);
      const stepStartBalance = currentBalance;
      let stepTradesCount = 0;

      // Check if starting balance for this step already reaches or exceeds target
      if (currentBalance < targetAmount - EPSILON) {
        while (currentBalance < targetAmount - EPSILON) {
          if (totalTradeCount >= MAX_TRADES) {
            hitLimit = true;
            break;
          }

          totalTradeCount++;
          stepTradesCount++;

          const tradeStartBalance = currentBalance;
          const rawEnding = tradeStartBalance * (1 + profitPct / 100);
          const tradeEndingBalance = roundCurrency(rawEnding);
          const tradeProfit = roundCurrency(tradeEndingBalance - tradeStartBalance);

          currentBalance = tradeEndingBalance;

          trades.push({
            trade: totalTradeCount,
            step: stepNumber,
            profitPct: profitPct,
            startingBalance: tradeStartBalance,
            profit: tradeProfit,
            endingBalance: tradeEndingBalance,
            isStepStart: stepTradesCount === 1
          });
        }
      }

      stepSummaries.push({
        stepNumber: stepNumber,
        startingBalance: stepStartBalance,
        targetAmount: targetAmount,
        profitPct: profitPct,
        tradesCount: stepTradesCount,
        endingBalance: currentBalance,
        profitGenerated: roundCurrency(currentBalance - stepStartBalance)
      });

      if (hitLimit) break;
    }

    const overallGoalAmount = roundCurrency(Number(steps[steps.length - 1].target));
    const finalBalance = currentBalance;
    const totalProfit = roundCurrency(finalBalance - startAmount);
    const overshootAmount = roundCurrency(finalBalance - overallGoalAmount);

    return {
      valid: true,
      hitLimit: hitLimit,
      totalTrades: totalTradeCount,
      initialStartingBalance: roundCurrency(startAmount),
      finalBalance: finalBalance,
      totalProfit: totalProfit,
      goalAmount: overallGoalAmount,
      overshootAmount: overshootAmount,
      steps: stepSummaries,
      trades: trades
    };
  }

  return {
    roundCurrency,
    tradesToGoal,
    validateStepUpGoal,
    calculateStepUpGoal,
    MAX_TRADES
  };
});
