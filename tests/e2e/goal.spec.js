const { test, expect } = require('@playwright/test');
const { openFreshApp } = require('./helpers.js');

test.describe('Goal Feature - Fixed & Step-Up Goals', () => {
  test.beforeEach(async ({ page }) => {
    await openFreshApp(page);
    // Switch to Goal mode via header segmented button
    await page.click('#modeSeg button[data-mode="goal"]');
    // Ensure tabs are hidden in goal mode
    await expect(page.locator('#tabs')).not.toBeVisible();
    await expect(page.locator('text=🎯 Goals')).toBeVisible();
  });

  test('can create, view, edit and delete a Fixed Profit Goal (preserving existing behavior)', async ({ page }) => {
    // Click Add goal
    await page.click('#goalAdd');
    await expect(page.locator('h2:has-text("New goal")')).toBeVisible();

    // Verify Goal Mode segmented control is visible and defaults to Fixed Profit Goal
    const fixedBtn = page.locator('#gfTypeSeg button[data-gtype="fixed"]');
    await expect(fixedBtn).toHaveClass(/active/);

    // Fill in fixed goal details
    await page.fill('#gfName', 'Retirement 50k');
    await page.fill('#gfTarget', '50,000');
    await page.fill('#gfPct', '15');
    await page.click('#gfSave');

    // Toast and goal card should appear
    await expect(page.locator('.toast')).toHaveText('Goal saved');
    const card = page.locator('.card:has-text("Retirement 50k")');
    await expect(card).toBeVisible();
    await expect(card.locator('.pctsub')).toHaveText('of $50,000.00');

    // Inline profit % editing
    const pctInput = card.locator('input[data-goalpct]');
    await expect(pctInput).toHaveValue('15');
    await pctInput.fill('12');
    await pctInput.dispatchEvent('input');

    // Reload page to verify persistence
    await page.reload();
    await page.click('#modeSeg button[data-mode="goal"]');
    const reloadedCard = page.locator('.card:has-text("Retirement 50k")');
    await expect(reloadedCard).toBeVisible();
    await expect(reloadedCard.locator('input[data-goalpct]')).toHaveValue('12');

    // Delete goal
    page.once('dialog', dialog => dialog.accept());
    await reloadedCard.locator('[data-goaldel]').click();
    await expect(page.locator('text=No goals yet')).toBeVisible();
  });

  test('can create a Step-Up Goal with multiple steps and verify calculations & roadmap', async ({ page }) => {
    await page.click('#goalAdd');
    await expect(page.locator('h2:has-text("New goal")')).toBeVisible();

    // Switch to Step-Up Goal mode
    await page.click('#gfTypeSeg button[data-gtype="stepup"]');
    await expect(page.locator('#gfTypeSeg button[data-gtype="stepup"]')).toHaveClass(/active/);
    await expect(page.locator('#gfStartAmount')).toBeVisible();

    // Configure the exact scenario from user requirements:
    // Starting balance: $10,000
    // Step 1: Target $15,000, Profit 20%
    // Step 2: Target $100,000, Profit 10%
    await page.fill('#gfName', 'Growth Ladder');
    await page.fill('#gfStartAmount', '10,000');

    // Step 1
    const step1Target = page.locator('.step-card[data-stepidx="0"] .step-target');
    const step1Pct = page.locator('.step-card[data-stepidx="0"] .step-pct');
    await step1Target.fill('15,000');
    await step1Pct.fill('20');

    // Step 2
    const step2Target = page.locator('.step-card[data-stepidx="1"] .step-target');
    const step2Pct = page.locator('.step-card[data-stepidx="1"] .step-pct');
    await step2Target.fill('100,000');
    await step2Pct.fill('10');

    // Save goal
    await page.click('#gfSave');
    await expect(page.locator('.toast')).toHaveText('Goal saved');

    // Verify card rendering
    const card = page.locator('.card:has-text("Growth Ladder")');
    await expect(card).toBeVisible();
    await expect(card.locator('.tag.stepup')).toHaveText('Step-Up · 2 steps');
    await expect(card.locator('.pctsub')).toHaveText('of $100,000.00');

    // Verify Total trades: 3 (step 1) + 19 (step 2) = 22 trades
    await expect(card.locator('.goalstat:has-text("Total winning trades required") .v')).toHaveText('22');
    await expect(card.locator('.goalstat:has-text("Starting balance") .v')).toHaveText('$10,000.00');

    // Verify Step Progression Roadmap
    const step1Node = card.locator('.step-node:has-text("Step 1")');
    await expect(step1Node).toContainText('$10,000.00 → $17,280.00');
    await expect(step1Node).toContainText('3 trades · Target: $15,000.00');

    const step2Node = card.locator('.step-node:has-text("Step 2")');
    // Step 2 MUST start from $17,280.00!
    await expect(step2Node).toContainText('$17,280.00 →');
    await expect(step2Node).toContainText('19 trades · Target: $100,000.00');

    // Toggle Trade-by-Trade Breakdown table
    const toggleBtn = card.locator('[data-toggletable]');
    await expect(toggleBtn).toHaveText('📊 View Trade-by-Trade Breakdown (22 trades)');
    await toggleBtn.click();

    // Table should now be visible
    const tableWrap = card.locator('[id^="tt-"]');
    await expect(tableWrap).toBeVisible();

    // Trade 0 row
    await expect(tableWrap.locator('tr[data-tradenum="0"]')).toContainText('$10,000.00');
    // Trade 1 row (10000 -> 12000)
    await expect(tableWrap.locator('tr[data-tradenum="1"]')).toContainText('$12,000.00');
    // Trade 2 row (12000 -> 14400)
    await expect(tableWrap.locator('tr[data-tradenum="2"]')).toContainText('$14,400.00');
    // Trade 3 row (14400 -> 17280)
    await expect(tableWrap.locator('tr[data-tradenum="3"]')).toContainText('$17,280.00');
    // Step 2 divider row
    await expect(tableWrap.locator('.step-divider')).toContainText('Step 2 begins (Starts at $17,280.00');
    // Trade 4 row (17280 -> 19008)
    await expect(tableWrap.locator('tr[data-tradenum="4"]')).toContainText('$17,280.00');
    await expect(tableWrap.locator('tr[data-tradenum="4"]')).toContainText('$19,008.00');

    // Hide table again
    await toggleBtn.click();
    await expect(tableWrap).not.toBeVisible();
  });

  test('validates step target ordering and positive inputs', async ({ page }) => {
    await page.click('#goalAdd');
    await page.click('#gfTypeSeg button[data-gtype="stepup"]');

    await page.fill('#gfStartAmount', '10000');
    // Step 1: 50,000
    await page.locator('.step-card[data-stepidx="0"] .step-target').fill('50,000');
    // Step 2: 30,000 (invalid: lower than Step 1)
    await page.locator('.step-card[data-stepidx="1"] .step-target').fill('30,000');

    await page.click('#gfSave');
    // Should show error toast
    await expect(page.locator('.toast.err')).toBeVisible();
    await expect(page.locator('.toast.err')).toContainText('must be strictly greater than');
  });

  test('can add and remove steps dynamically in the edit form', async ({ page }) => {
    await page.click('#goalAdd');
    await page.click('#gfTypeSeg button[data-gtype="stepup"]');

    // Starts with 2 steps
    await expect(page.locator('.step-card')).toHaveCount(2);

    // Add a 3rd step
    await page.click('#gfAddStep');
    await expect(page.locator('.step-card')).toHaveCount(3);

    // Add a 4th step
    await page.click('#gfAddStep');
    await expect(page.locator('.step-card')).toHaveCount(4);

    // Remove the 4th step
    await page.click('.step-card[data-stepidx="3"] [data-delstep]');
    await expect(page.locator('.step-card')).toHaveCount(3);
  });
});
