import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, taxDocumentsTable, w2DataTable, form1099DataTable, clientsTable } from "@workspace/db";
import {
  ListDocumentsParams,
  UploadDocumentParams,
  UploadDocumentBody,
  DeleteDocumentParams,
} from "@workspace/api-zod";
import {
  extractTextFromBase64,
  extractW2DataFromText,
  extractW2DataFromFile,
  extract1099DataFromFile,
  detectMimeType,
  isVisualMimeType,
} from "../lib/documentExtractor";
import { logger } from "../lib/logger";
import { recalculateAndUpsertTaxReturn } from "../lib/taxReturnPipeline";

const router: IRouter = Router();

router.get("/clients/:clientId/documents", async (req, res): Promise<void> => {
  const params = ListDocumentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const documents = await db
    .select()
    .from(taxDocumentsTable)
    .where(eq(taxDocumentsTable.clientId, params.data.clientId));
  res.json(documents);
});

router.post("/clients/:clientId/documents", async (req, res): Promise<void> => {
  const params = UploadDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UploadDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Insert document in pending state
  const [doc] = await db
    .insert(taxDocumentsTable)
    .values({
      clientId: params.data.clientId,
      documentType: parsed.data.documentType,
      fileName: parsed.data.fileName,
      fileContent: parsed.data.fileContent,
      status: "processing",
    })
    .returning();

  // Run AI extraction asynchronously, then update
  (async () => {
    try {
      const mimeType = detectMimeType(parsed.data.fileName);
      const isVisual = isVisualMimeType(mimeType);
      const extractedText = isVisual
        ? `[${mimeType}: ${parsed.data.fileName}]`
        : await extractTextFromBase64(parsed.data.fileContent, parsed.data.fileName);
      let extractedData: Record<string, unknown> = {};

      // Pull the client's tax year so any auto-created records match their return year.
      const [client] = await db
        .select()
        .from(clientsTable)
        .where(eq(clientsTable.id, params.data.clientId));
      const clientTaxYear = client?.taxYear ?? new Date().getFullYear() - 1;

      if (parsed.data.documentType === "w2") {
        let fieldBoxes: Record<string, unknown> = {};
        if (isVisual) {
          const { data, boxes } = await extractW2DataFromFile(parsed.data.fileContent, mimeType);
          extractedData = data as Record<string, unknown>;
          fieldBoxes = boxes as Record<string, unknown>;
        } else {
          extractedData = (await extractW2DataFromText(extractedText)) as Record<string, unknown>;
        }

        // Auto-create a W-2 record with extracted data
        await db.insert(w2DataTable).values({
          clientId: params.data.clientId,
          documentId: doc.id,
          taxYear: clientTaxYear,
          employerName: extractedData.employerName as string | undefined,
          employerEin: extractedData.employerEin as string | undefined,
          employeeSSN: extractedData.employeeSSN as string | undefined,
          wagesBox1: extractedData.wagesBox1 != null ? String(extractedData.wagesBox1) : undefined,
          federalTaxWithheldBox2: extractedData.federalTaxWithheldBox2 != null ? String(extractedData.federalTaxWithheldBox2) : undefined,
          socialSecurityWagesBox3: extractedData.socialSecurityWagesBox3 != null ? String(extractedData.socialSecurityWagesBox3) : undefined,
          socialSecurityTaxBox4: extractedData.socialSecurityTaxBox4 != null ? String(extractedData.socialSecurityTaxBox4) : undefined,
          medicareWagesBox5: extractedData.medicareWagesBox5 != null ? String(extractedData.medicareWagesBox5) : undefined,
          medicareTaxBox6: extractedData.medicareTaxBox6 != null ? String(extractedData.medicareTaxBox6) : undefined,
          stateTaxWithheldBox17: extractedData.stateTaxWithheldBox17 != null ? String(extractedData.stateTaxWithheldBox17) : undefined,
          stateWagesBox16: extractedData.stateWagesBox16 != null ? String(extractedData.stateWagesBox16) : undefined,
          stateCode: extractedData.stateCode as string | undefined,
          fieldBoxes: Object.keys(fieldBoxes).length > 0 ? fieldBoxes : null,
        });

        // Auto-recalc the tax return so the calculator tab reflects the new W-2 immediately
        await recalculateAndUpsertTaxReturn(params.data.clientId);
      } else if (parsed.data.documentType === "form_1099" && isVisual) {
        // 1099 — auto-detect subtype + extract fields
        const { data, boxes } = await extract1099DataFromFile(parsed.data.fileContent, mimeType);
        extractedData = data as Record<string, unknown>;
        const fieldBoxes = boxes as Record<string, unknown>;

        if (data.formType) {
          await db.insert(form1099DataTable).values({
            clientId: params.data.clientId,
            documentId: doc.id,
            taxYear: clientTaxYear,
            formType: data.formType,
            payerName: data.payerName,
            payerTin: data.payerTin,
            recipientTin: data.recipientTin,
            federalTaxWithheld: data.federalTaxWithheld != null ? String(data.federalTaxWithheld) : undefined,
            stateTaxWithheld: data.stateTaxWithheld != null ? String(data.stateTaxWithheld) : undefined,
            stateCode: data.stateCode,
            nonemployeeCompensation: data.nonemployeeCompensation != null ? String(data.nonemployeeCompensation) : undefined,
            rents: data.rents != null ? String(data.rents) : undefined,
            royalties: data.royalties != null ? String(data.royalties) : undefined,
            otherIncome: data.otherIncome != null ? String(data.otherIncome) : undefined,
            fishingBoatProceeds: data.fishingBoatProceeds != null ? String(data.fishingBoatProceeds) : undefined,
            medicalAndHealthcare: data.medicalAndHealthcare != null ? String(data.medicalAndHealthcare) : undefined,
            interestIncome: data.interestIncome != null ? String(data.interestIncome) : undefined,
            earlyWithdrawalPenalty: data.earlyWithdrawalPenalty != null ? String(data.earlyWithdrawalPenalty) : undefined,
            usTreasuryInterest: data.usTreasuryInterest != null ? String(data.usTreasuryInterest) : undefined,
            taxExemptInterest: data.taxExemptInterest != null ? String(data.taxExemptInterest) : undefined,
            ordinaryDividends: data.ordinaryDividends != null ? String(data.ordinaryDividends) : undefined,
            qualifiedDividends: data.qualifiedDividends != null ? String(data.qualifiedDividends) : undefined,
            totalCapitalGainDistribution: data.totalCapitalGainDistribution != null ? String(data.totalCapitalGainDistribution) : undefined,
            nondividendDistributions: data.nondividendDistributions != null ? String(data.nondividendDistributions) : undefined,
            proceeds: data.proceeds != null ? String(data.proceeds) : undefined,
            costBasis: data.costBasis != null ? String(data.costBasis) : undefined,
            shortTermGainLoss: data.shortTermGainLoss != null ? String(data.shortTermGainLoss) : undefined,
            longTermGainLoss: data.longTermGainLoss != null ? String(data.longTermGainLoss) : undefined,
            grossDistribution: data.grossDistribution != null ? String(data.grossDistribution) : undefined,
            taxableAmount: data.taxableAmount != null ? String(data.taxableAmount) : undefined,
            distributionCode: data.distributionCode,
            iraSepSimple: data.iraSepSimple,
            unemploymentCompensation: data.unemploymentCompensation != null ? String(data.unemploymentCompensation) : undefined,
            stateLocalRefund: data.stateLocalRefund != null ? String(data.stateLocalRefund) : undefined,
            grossPaymentAmount: data.grossPaymentAmount != null ? String(data.grossPaymentAmount) : undefined,
            fieldBoxes: Object.keys(fieldBoxes).length > 0 ? fieldBoxes : null,
          });

          await recalculateAndUpsertTaxReturn(params.data.clientId);
        } else {
          logger.warn({ docId: doc.id }, "1099 extraction did not produce a formType");
        }
      }

      await db
        .update(taxDocumentsTable)
        .set({
          status: "extracted",
          extractedText: JSON.stringify({ text: extractedText.slice(0, 2000), data: extractedData }),
        })
        .where(eq(taxDocumentsTable.id, doc.id));
    } catch (err) {
      logger.error({ err, docId: doc.id, fileName: parsed.data.fileName }, "AI extraction failed");
      await db
        .update(taxDocumentsTable)
        .set({ status: "failed" })
        .where(eq(taxDocumentsTable.id, doc.id));
    }
  })();

  res.status(201).json(doc);
});

// Stream the raw file content (image/PDF/text) for preview in the UI.
router.get("/clients/:clientId/documents/:documentId/content", async (req, res): Promise<void> => {
  const params = DeleteDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [doc] = await db
    .select()
    .from(taxDocumentsTable)
    .where(
      and(
        eq(taxDocumentsTable.id, params.data.documentId),
        eq(taxDocumentsTable.clientId, params.data.clientId),
      ),
    );
  if (!doc || !doc.fileContent) {
    res.status(404).json({ error: "Document content not found" });
    return;
  }
  const mimeType = detectMimeType(doc.fileName);
  const buffer = Buffer.from(doc.fileContent, "base64");
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Disposition", `inline; filename="${doc.fileName}"`);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(buffer);
});

router.delete("/clients/:clientId/documents/:documentId", async (req, res): Promise<void> => {
  const params = DeleteDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [doc] = await db
    .delete(taxDocumentsTable)
    .where(
      and(
        eq(taxDocumentsTable.id, params.data.documentId),
        eq(taxDocumentsTable.clientId, params.data.clientId)
      )
    )
    .returning();
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  // Note: w2_data rows that were auto-created from this doc are NOT deleted (no FK cascade).
  // Recalc anyway in case any flow does delete W-2s here later.
  recalculateAndUpsertTaxReturn(params.data.clientId).catch(() => {});
  res.sendStatus(204);
});

export default router;
