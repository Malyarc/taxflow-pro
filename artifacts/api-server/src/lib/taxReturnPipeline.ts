/**
 * Single source of truth for tax return calculation + persistence.
 *
 * Layered:
 *   - computeTaxReturn(): pure calculation (no DB writes). Used by both the
 *     persistent recalc path and the on-demand "/preview" endpoint.
 *   - recalculateAndUpsertTaxReturn(): wraps compute + writes the result row.
 *   - recalculateInBackground(): fire-and-forget version used by mutation routes.
 */

import { eq, and } from "drizzle-orm";
import {
  db,
  clientsTable,
  w2DataTable,
  form1099DataTable,
  adjustmentsTable,
  taxReturnsTable,
} from "@workspace/db";
import {
  runTaxCalculation,
  calculateChildTaxCredit,
  calculateSelfEmploymentTax,
  calculateNiit,
  calculateQbi,
  calculateAmt,
  calculateFederalTax,
  calculateFederalTaxWithCapitalGains,
  type CtcCalculation,
  type SeTaxCalculation,
  type NiitCalculation,
  type QbiCalculation,
  type AmtCalculation,
  type CapitalGainsCalculation,
} from "./taxCalculator";
import { logger } from "./logger";

export interface RecalcOverrides {
  taxYear?: number;
  additionalIncome?: number;
  additionalDeductions?: number;
  useItemizedDeductions?: boolean;
}

function toNum(val: string | null | undefined): number {
  if (val == null) return 0;
  return Number(val) || 0;
}

export interface Form1099Summary {
  /** Self-employment income (1099-NEC) */
  seIncome: number;
  /** Ordinary interest (1099-INT minus tax-exempt portion) */
  interestIncome: number;
  /** Ordinary (non-qualified) dividends from 1099-DIV */
  ordinaryDividends: number;
  /** Qualified dividends — LTCG rates */
  qualifiedDividends: number;
  /** Long-term capital gains (1099-B + 1099-DIV cap gain distribution) */
  longTermCapitalGains: number;
  /** Short-term capital gains (1099-B) */
  shortTermCapitalGains: number;
  /** Retirement income (1099-R taxable amount) */
  retirementIncome: number;
  /** Unemployment + state refund (1099-G) */
  unemploymentIncome: number;
  /** 1099-K gross payment (treated as additional income unless adjusted) */
  paymentCardIncome: number;
  /** 1099-MISC: rents + royalties + other income */
  miscIncome: number;
  /** Federal withholding across all 1099s */
  federalWithheld: number;
  /** State withholding across all 1099s */
  stateWithheld: number;
  /** Total ordinary income from all 1099 sources (excludes LTCG/qualifed dividends) */
  totalOrdinaryIncome: number;
  /** All investment income (drives NIIT) */
  totalInvestmentIncome: number;
  /** Number of 1099 records included */
  recordCount: number;
}

function summarize1099s(records: Array<typeof form1099DataTable.$inferSelect>): Form1099Summary {
  const sum = (key: keyof typeof records[number]) =>
    records.reduce((s, r) => s + toNum(r[key] as string | null), 0);

  const necRecords = records.filter((r) => r.formType === "nec");
  const miscRecords = records.filter((r) => r.formType === "misc");
  const intRecords = records.filter((r) => r.formType === "int");
  const divRecords = records.filter((r) => r.formType === "div");
  const bRecords = records.filter((r) => r.formType === "b");
  const rRecords = records.filter((r) => r.formType === "r");
  const gRecords = records.filter((r) => r.formType === "g");
  const kRecords = records.filter((r) => r.formType === "k");

  const seIncome = necRecords.reduce((s, r) => s + toNum(r.nonemployeeCompensation), 0);

  // Interest: total minus tax-exempt portion
  const interestIncome = intRecords.reduce(
    (s, r) => s + Math.max(0, toNum(r.interestIncome) - toNum(r.taxExemptInterest)),
    0,
  );

  const qualifiedDividends = divRecords.reduce((s, r) => s + toNum(r.qualifiedDividends), 0);
  // Ordinary dividends per IRS Form 1040 = box 1a - box 1b (qualified portion subtracted)
  const ordinaryDividends = divRecords.reduce(
    (s, r) => s + Math.max(0, toNum(r.ordinaryDividends) - toNum(r.qualifiedDividends)),
    0,
  );
  const cgDistributions = divRecords.reduce((s, r) => s + toNum(r.totalCapitalGainDistribution), 0);

  // 1099-B: short-term and long-term gain/loss
  const stcgFromB = bRecords.reduce((s, r) => s + toNum(r.shortTermGainLoss), 0);
  const ltcgFromB = bRecords.reduce((s, r) => s + toNum(r.longTermGainLoss), 0);

  const longTermCapitalGains = ltcgFromB + cgDistributions;
  const shortTermCapitalGains = stcgFromB;

  const retirementIncome = rRecords.reduce(
    (s, r) => s + toNum(r.taxableAmount ?? r.grossDistribution),
    0,
  );
  const unemploymentIncome = gRecords.reduce(
    (s, r) => s + toNum(r.unemploymentCompensation) + toNum(r.stateLocalRefund),
    0,
  );
  const paymentCardIncome = kRecords.reduce((s, r) => s + toNum(r.grossPaymentAmount), 0);
  const miscIncome = miscRecords.reduce(
    (s, r) =>
      s +
      toNum(r.rents) +
      toNum(r.royalties) +
      toNum(r.otherIncome) +
      toNum(r.fishingBoatProceeds) +
      toNum(r.medicalAndHealthcare),
    0,
  );

  const federalWithheld = records.reduce((s, r) => s + toNum(r.federalTaxWithheld), 0);
  const stateWithheld = records.reduce((s, r) => s + toNum(r.stateTaxWithheld), 0);

  // Ordinary income from 1099s: includes everything taxed at ordinary rates
  // (NEC handled separately — flows through SE tax pipeline; NEC also shows up as ordinary income).
  // STCG is taxed at ordinary rates but gets stacked separately in the calc.
  const totalOrdinaryIncome =
    seIncome + miscIncome + interestIncome + ordinaryDividends + retirementIncome +
    unemploymentIncome + paymentCardIncome;

  // Investment income for NIIT: interest + dividends (all) + capital gains (all)
  const totalInvestmentIncome =
    interestIncome + ordinaryDividends + qualifiedDividends + longTermCapitalGains + shortTermCapitalGains;

  return {
    seIncome,
    interestIncome,
    ordinaryDividends,
    qualifiedDividends,
    longTermCapitalGains,
    shortTermCapitalGains,
    retirementIncome,
    unemploymentIncome,
    paymentCardIncome,
    miscIncome,
    federalWithheld,
    stateWithheld,
    totalOrdinaryIncome,
    totalInvestmentIncome,
    recordCount: records.length,
  };
}

export interface ComputedTaxReturn {
  /** Tax year actually computed for */
  taxYear: number;
  filingStatus: string;
  stateCode: string;
  totalIncome: number;
  adjustedGrossIncome: number;
  standardDeduction: number;
  itemizedDeductions: number | null;
  /** QBI deduction (Section 199A), reduces taxable income further */
  qbiDeduction: number;
  taxableIncome: number;
  federalTaxLiability: number;
  federalTaxWithheld: number;
  federalRefundOrOwed: number;
  stateTaxLiability: number;
  stateTaxWithheld: number;
  stateRefundOrOwed: number;
  effectiveTaxRate: number;
  /** Sum of CPA-authored "credit" adjustments applied (manual entries) */
  manualCreditsApplied: number;
  /** Auto-computed Child Tax Credit + Credit for Other Dependents */
  childTaxCredit: CtcCalculation;
  /** Self-employment tax (15.3% on net SE earnings) */
  selfEmploymentTax: number;
  /** Net Investment Income Tax (3.8% IRC §1411) */
  niitTax: number;
  /** AMT delta — additional tax beyond regular tax. Often $0. */
  amtTax: number;
  /** Refundable portion of CTC (Additional Child Tax Credit) */
  additionalChildTaxCredit: number;
  /** Federal tax owed on long-term capital gains + qualified dividends (preferential rate) */
  capitalGainsTax: number;
  /** Long-term capital gains + qualified dividends (preferential-rate income) */
  preferentialIncome: number;
  /** Summary of all 1099 records included in this return */
  form1099Summary: Form1099Summary;
  /** Detailed breakdowns for transparency */
  detail: {
    se: SeTaxCalculation;
    niit: NiitCalculation;
    qbi: QbiCalculation;
    amt: AmtCalculation;
    capitalGains: CapitalGainsCalculation;
  };
  /** Number of W-2s included in the total wages */
  w2Count: number;
  /** Number of 1099 records included */
  form1099Count: number;
}

/**
 * Pure compute — no DB writes. Loads client/W-2/adjustments, computes the
 * full tax return, and returns numeric results. Same logic used by the
 * persistent recalc path and the preview endpoint.
 */
export async function computeTaxReturn(
  clientId: number,
  overrides: RecalcOverrides = {},
): Promise<{ result: ComputedTaxReturn; client: typeof clientsTable.$inferSelect } | null> {
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId));
  if (!client) return null;

  const [existing] = await db
    .select()
    .from(taxReturnsTable)
    .where(eq(taxReturnsTable.clientId, clientId));

  // Tax year resolution: explicit override > client.taxYear > existing.taxYear
  const taxYear =
    overrides.taxYear ?? client.taxYear ?? existing?.taxYear ?? new Date().getFullYear() - 1;
  const additionalIncome = overrides.additionalIncome ?? 0;
  const useItemizedDeductions =
    overrides.useItemizedDeductions ?? Boolean(existing?.itemizedDeductions);
  const additionalDeductions =
    overrides.additionalDeductions ?? toNum(existing?.itemizedDeductions);

  // W-2s for the requested year only
  const w2Records = await db
    .select()
    .from(w2DataTable)
    .where(
      and(eq(w2DataTable.clientId, clientId), eq(w2DataTable.taxYear, taxYear)),
    );
  const totalWages = w2Records.reduce((s, r) => s + toNum(r.wagesBox1), 0);
  const w2FederalWithheld = w2Records.reduce(
    (s, r) => s + toNum(r.federalTaxWithheldBox2),
    0,
  );
  const w2StateWithheld = w2Records.reduce(
    (s, r) => s + toNum(r.stateTaxWithheldBox17),
    0,
  );

  // 1099s for the requested year only
  const form1099Records = await db
    .select()
    .from(form1099DataTable)
    .where(
      and(eq(form1099DataTable.clientId, clientId), eq(form1099DataTable.taxYear, taxYear)),
    );
  const form1099Summary = summarize1099s(form1099Records);

  const totalFederalWithheld = w2FederalWithheld + form1099Summary.federalWithheld;
  const totalStateWithheld = w2StateWithheld + form1099Summary.stateWithheld;

  const stateCode =
    (client.state && client.state.trim()) ||
    w2Records.find((r) => r.stateCode)?.stateCode ||
    "";

  // CPA-authored adjustments (only "applied" ones)
  const adjustments = await db
    .select()
    .from(adjustmentsTable)
    .where(eq(adjustmentsTable.clientId, clientId));
  const applied = adjustments.filter((a) => a.isApplied);

  const sumByType = (type: string) =>
    applied
      .filter((a) => a.adjustmentType === type)
      .reduce((s, a) => s + toNum(a.amount), 0);

  const deductionAdjustments = sumByType("deduction");
  const creditAdjustments = sumByType("credit");
  const additionalIncomeAdjustments = sumByType("additional_income");
  const withholdingAdjustments = sumByType("withholding_adjustment");
  const otherDeductions = sumByType("other");

  // ── Income from CPA adjustments + 1099s ──
  const seIncomeFromAdj = sumByType("self_employment_income");
  const investmentIncomeFromAdj = sumByType("investment_income");
  const qbiIncome = sumByType("qbi_income");
  const amtPreferences = sumByType("amt_preferences");

  // Combine CPA-entered SE income + 1099-NEC income
  const totalSeIncome = seIncomeFromAdj + form1099Summary.seIncome;
  // Combine CPA-entered investment income + 1099 investment income (interest, dividends, cap gains)
  // Note: 1099 ordinary investment income (interest + ordinary dividends) goes to ordinary tax;
  //       qualified dividends + LTCG go to preferential rates separately.
  const totalInvestmentIncomeForNiit = investmentIncomeFromAdj + form1099Summary.totalInvestmentIncome;

  // SE tax — applies before AGI is finalized (1/2 deductible above the line)
  const se = calculateSelfEmploymentTax(totalSeIncome, taxYear);

  // Ordinary additional income that flows to ordinary tax brackets:
  //   - User-supplied additionalIncome
  //   - Adjustment "additional_income"
  //   - SE income (also subject to SE tax)
  //   - Adjustment "investment_income" (treated as ordinary unless flagged otherwise)
  //   - 1099 ordinary income: interest, ordinary dividends, retirement, unemployment, 1099-K, 1099-MISC
  // NOT included here: qualified dividends and LTCG (preferential rates),
  //                    STCG (added separately so it can be taxed at ordinary rates correctly)
  const ordinaryAdditionalIncome =
    additionalIncome +
    additionalIncomeAdjustments +
    seIncomeFromAdj + // 1099-NEC seIncome counted via form1099Summary.seIncome below
    investmentIncomeFromAdj +
    form1099Summary.seIncome +
    form1099Summary.interestIncome +
    form1099Summary.ordinaryDividends +
    form1099Summary.retirementIncome +
    form1099Summary.unemploymentIncome +
    form1099Summary.paymentCardIncome +
    form1099Summary.miscIncome;

  const aboveTheLineAdjustments = deductionAdjustments + otherDeductions + se.deductibleHalf;
  const itemizedDeductions = additionalDeductions;

  const calc = runTaxCalculation({
    totalWages,
    additionalIncome: ordinaryAdditionalIncome,
    filingStatus: client.filingStatus,
    stateCode: stateCode ?? "CA",
    useItemizedDeductions,
    itemizedDeductions,
    adjustments: aboveTheLineAdjustments,
    taxYear,
  });

  // QBI deduction reduces taxable income further (capped at 20% of taxable income before QBI)
  const qbi = calculateQbi({
    qbiIncome,
    taxableIncomeBeforeQbi: calc.taxableIncome,
  });
  const taxableAfterQbi = Math.max(0, calc.taxableIncome - qbi.finalDeduction);

  // Capital gains: LTCG + qualified dividends use preferential rates; STCG uses ordinary.
  // Add LTCG + qualified dividends to taxable income for the preferential calculation.
  const longTermGains = form1099Summary.longTermCapitalGains;
  const shortTermGains = form1099Summary.shortTermCapitalGains;
  const qualifiedDividends = form1099Summary.qualifiedDividends;
  const preferentialIncome = longTermGains + qualifiedDividends;

  // Compute federal tax: ordinary tax on (taxableAfterQbi + STCG) + preferential tax on (LTCG + QD)
  const capGains = calculateFederalTaxWithCapitalGains({
    ordinaryTaxableIncome: taxableAfterQbi,
    longTermGains,
    qualifiedDividends,
    shortTermGains,
    filingStatus: client.filingStatus,
    taxYear,
  });
  const regularFederalTax = capGains.totalFederalTax;

  // AMT — alternative computation; final regular tax = max(regular, regular + AMT delta).
  // For AMT we use taxable income including capital gains (approximation — real AMT
  // has separate cap-gains treatment that mirrors regular but on AMTI).
  const amt = calculateAmt({
    taxableIncome: taxableAfterQbi + preferentialIncome + Math.max(0, shortTermGains),
    amtPreferences,
    filingStatus: client.filingStatus,
    regularTax: regularFederalTax,
    taxYear,
  });

  // NIIT — 3.8% on lesser of (investment income, AGI over threshold)
  // Use 1099-derived investment income + manual adjustment investment income.
  const niit = calculateNiit({
    investmentIncome: totalInvestmentIncomeForNiit,
    modifiedAgi: calc.adjustedGrossIncome,
    filingStatus: client.filingStatus,
  });

  // Total federal liability before credits = regular + AMT + NIIT + SE
  const totalFederalLiability =
    regularFederalTax + amt.amtTax + niit.niitTax + se.seTaxTotal;

  // CTC: refundable split based on tax owed before CTC.
  // Earned income for ACTC: wages + net SE earnings
  const earnedIncome = totalWages + Math.max(0, totalSeIncome - se.deductibleHalf);
  const ctc = calculateChildTaxCredit({
    qualifyingChildren: client.dependentsUnder17 ?? 0,
    otherDependents: client.otherDependents ?? 0,
    agi: calc.adjustedGrossIncome,
    filingStatus: client.filingStatus,
    taxYear,
    taxBeforeCredit: regularFederalTax + amt.amtTax,
    earnedIncome,
  });

  const federalRefundOrOwed =
    totalFederalWithheld +
    withholdingAdjustments -
    totalFederalLiability +
    creditAdjustments +
    ctc.appliedCredit; // appliedCredit already includes refundable portion
  const stateRefundOrOwed = totalStateWithheld - calc.stateTaxLiability;

  // Effective tax rate uses the full federal + state liability (before credits)
  const totalTaxBurden = totalFederalLiability + calc.stateTaxLiability;
  const effectiveRate = calc.totalIncome > 0 ? totalTaxBurden / calc.totalIncome : 0;

  const result: ComputedTaxReturn = {
    taxYear: calc.taxYear,
    filingStatus: client.filingStatus,
    stateCode,
    totalIncome: calc.totalIncome,
    adjustedGrossIncome: calc.adjustedGrossIncome,
    standardDeduction: calc.standardDeduction,
    itemizedDeductions: useItemizedDeductions ? itemizedDeductions : null,
    qbiDeduction: qbi.finalDeduction,
    taxableIncome: taxableAfterQbi,
    federalTaxLiability: totalFederalLiability,
    federalTaxWithheld: totalFederalWithheld + withholdingAdjustments,
    federalRefundOrOwed,
    stateTaxLiability: calc.stateTaxLiability,
    stateTaxWithheld: totalStateWithheld,
    stateRefundOrOwed,
    effectiveTaxRate: effectiveRate,
    manualCreditsApplied: creditAdjustments,
    childTaxCredit: ctc,
    selfEmploymentTax: se.seTaxTotal,
    niitTax: niit.niitTax,
    amtTax: amt.amtTax,
    additionalChildTaxCredit: ctc.refundableActc,
    capitalGainsTax: capGains.preferentialRateTax,
    preferentialIncome,
    form1099Summary,
    detail: { se, niit, qbi, amt, capitalGains: capGains },
    w2Count: w2Records.length,
    form1099Count: form1099Records.length,
  };

  return { result, client };
}

export async function recalculateAndUpsertTaxReturn(
  clientId: number,
  overrides: RecalcOverrides = {},
): Promise<typeof taxReturnsTable.$inferSelect | null> {
  const computed = await computeTaxReturn(clientId, overrides);
  if (!computed) {
    logger.warn({ clientId }, "recalculateAndUpsertTaxReturn: client not found");
    return null;
  }
  const { result } = computed;

  // Multi-year: look up by (clientId, taxYear) composite, not just clientId.
  // This means each client can have one row per tax year, not one row total.
  const [existing] = await db
    .select()
    .from(taxReturnsTable)
    .where(
      and(
        eq(taxReturnsTable.clientId, clientId),
        eq(taxReturnsTable.taxYear, result.taxYear),
      ),
    );

  const payload = {
    clientId,
    taxYear: result.taxYear,
    filingStatus: result.filingStatus,
    totalIncome: String(result.totalIncome),
    adjustedGrossIncome: String(result.adjustedGrossIncome),
    standardDeduction: String(result.standardDeduction),
    itemizedDeductions: result.itemizedDeductions != null ? String(result.itemizedDeductions) : null,
    taxableIncome: String(result.taxableIncome),
    federalTaxLiability: String(result.federalTaxLiability),
    federalTaxWithheld: String(result.federalTaxWithheld),
    federalRefundOrOwed: String(result.federalRefundOrOwed),
    stateTaxLiability: String(result.stateTaxLiability),
    stateTaxWithheld: String(result.stateTaxWithheld),
    stateRefundOrOwed: String(result.stateRefundOrOwed),
    effectiveTaxRate: String(result.effectiveTaxRate),
    selfEmploymentTax: result.selfEmploymentTax != null ? String(result.selfEmploymentTax) : null,
    qbiDeduction: result.qbiDeduction != null ? String(result.qbiDeduction) : null,
    amtTax: result.amtTax != null ? String(result.amtTax) : null,
    niitTax: result.niitTax != null ? String(result.niitTax) : null,
    additionalChildTaxCredit: result.additionalChildTaxCredit != null ? String(result.additionalChildTaxCredit) : null,
    capitalGainsTax: result.capitalGainsTax != null ? String(result.capitalGainsTax) : null,
    preferentialIncome: result.preferentialIncome != null ? String(result.preferentialIncome) : null,
  };

  if (existing) {
    const [updated] = await db
      .update(taxReturnsTable)
      .set({ ...payload, updatedAt: new Date() })
      .where(
        and(
          eq(taxReturnsTable.clientId, clientId),
          eq(taxReturnsTable.taxYear, result.taxYear),
        ),
      )
      .returning();
    return updated;
  }
  const [created] = await db.insert(taxReturnsTable).values(payload).returning();
  return created;
}

/**
 * Fire-and-forget recalc — for use after non-blocking mutations where we
 * don't want to slow down the request response. Errors are logged.
 */
export function recalculateInBackground(clientId: number, taxYear?: number): void {
  recalculateAndUpsertTaxReturn(clientId, taxYear ? { taxYear } : {}).catch((err) => {
    logger.error({ err, clientId, taxYear }, "Background tax-return recalc failed");
  });
}
