import type { ProcessedResult } from '../types.js';

interface ExcelJsModule {
  Workbook: new () => {
    addWorksheet(name: string): {
      columns: { header: string; key: string; width: number }[];
      addRow(row: Record<string, string | number>): void;
    };
    xlsx: { writeFile(path: string): Promise<void> };
  };
}

/** Write an XLSX workbook to `outPath`. Requires `exceljs` to be installed. */
export async function writeXlsx(
  images: readonly ProcessedResult[],
  outPath: string,
): Promise<void> {
  let exceljs: ExcelJsModule;
  try {
    // Non-literal specifier forces TypeScript to treat the import as `any`,
    // which is correct — exceljs is an optional peer dep not present at build time.
    const specifier = 'exceljs';
    exceljs = (await import(specifier)) as unknown as ExcelJsModule;
  } catch {
    throw new Error(
      'exceljs is not installed. Run `pnpm add exceljs` (or `npm install exceljs`) and try again.',
    );
  }

  const wb = new exceljs.Workbook();
  const ws = wb.addWorksheet('Results');

  ws.columns = [
    { header: 'Number', key: 'number', width: 8 },
    { header: 'Original File', key: 'originalFile', width: 30 },
    { header: 'Output File', key: 'outputFile', width: 40 },
    { header: 'Category', key: 'category', width: 20 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Short Description', key: 'shortDescription', width: 40 },
    { header: 'Confidence', key: 'confidence', width: 12 },
    { header: 'Elements', key: 'elements', width: 40 },
    { header: 'Extracted Text', key: 'extractedText', width: 50 },
  ];

  for (const img of images) {
    ws.addRow({
      number: img.number,
      originalFile: img.originalFile,
      outputFile: img.outputFile,
      category: img.category,
      date: new Date(img.timestamp).toISOString().slice(0, 10),
      shortDescription: img.shortDescription,
      confidence: img.confidence,
      elements: img.elements.join(' | '),
      extractedText: img.extractedText ?? '',
    });
  }

  await wb.xlsx.writeFile(outPath);
}
