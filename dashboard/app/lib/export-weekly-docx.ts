import type { WeeklyReport } from "./weekly-report";

export async function createWeeklyDocx(report: WeeklyReport) {
  const { AlignmentType, Document, Footer, HeadingLevel, Packer, PageNumber, Paragraph, TextRun } = await import("docx");
  const font = "Microsoft YaHei";
  const paragraph = (text: string) => new Paragraph({
    children: text.split("\n").map((line, index) => new TextRun({ text: line, break: index ? 1 : undefined })),
    spacing: { after: 140, line: 300 },
  });
  const children = [
    new Paragraph({ text: report.workspaceName, spacing: { after: 100 } }),
    new Paragraph({ text: report.title, heading: HeadingLevel.TITLE }),
    paragraph("报告周期：" + report.period.from + " — " + report.period.to),
    paragraph("本期记录 " + report.eventCount + " 条进展，涉及 " + report.projectCount + " 个事项、" + report.companyEventCount + " 条公司动态。"),
    ...report.sections.flatMap((section) => [
      new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1 }),
      ...section.groups.flatMap((group) => [
        ...(section.kind === "company" ? [] : [new Paragraph({ text: group.name, heading: HeadingLevel.HEADING_2 })]),
        ...group.events.flatMap((event) => [
          new Paragraph({ children: [new TextRun({ text: event.date + " " + event.title, bold: true })], keepNext: true, spacing: { before: 160, after: 80 } }),
          paragraph(event.summary),
        ]),
      ]),
    ]),
    ...(report.eventCount ? [] : [paragraph("所选周期暂无进展记录。")]),
  ];
  const document = new Document({
    creator: report.workspaceName, title: report.title,
    styles: {
      default: { document: { run: { font, size: 22, color: "26384A" }, paragraph: { spacing: { after: 140, line: 300 } } } },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", run: { font, size: 38, color: "17365D", bold: true }, paragraph: { keepNext: true, spacing: { after: 200 } } },
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { font, size: 28, color: "2E74B5", bold: true }, paragraph: { keepNext: true, spacing: { before: 280, after: 140 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", run: { font, size: 24, color: "17365D", bold: true }, paragraph: { keepNext: true, spacing: { before: 180, after: 100 } } },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [
        new TextRun({ text: report.workspaceName + " · ", size: 18, color: "667085" }),
        new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "667085" }),
      ] })] }) },
      children,
    }],
  });
  return Packer.toBlob(document);
}
