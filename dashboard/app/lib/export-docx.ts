import {
  reportItemFollowUpLabel,
  reportItemStatusLabel,
  type LeadershipReport,
} from "./report";

const FONT = "Microsoft YaHei";
const NAVY = "17365D";
const BLUE = "2E74B5";
const MID_GRAY = "D9E1E8";
const TEXT_GRAY = "536273";

function formatCny(value: number | undefined) {
  if (!value) return "—";
  if (value >= 10_000 && value % 10_000 === 0) {
    return `${new Intl.NumberFormat("zh-CN").format(value / 10_000)} 万元`;
  }
  return `${new Intl.NumberFormat("zh-CN").format(value)} 元`;
}

export async function createLeadershipDocx(report: LeadershipReport) {
  const {
    AlignmentType,
    BorderStyle,
    Document,
    Footer,
    HeadingLevel,
    Packer,
    PageNumber,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableLayoutType,
    TableRow,
    TextRun,
    VerticalAlign,
    WidthType,
  } = await import("docx");

  const cellBorder = {
    style: BorderStyle.SINGLE,
    size: 2,
    color: MID_GRAY,
  };
  const borders = {
    top: cellBorder,
    bottom: cellBorder,
    left: cellBorder,
    right: cellBorder,
  };
  const cell = (
    value: string,
    width: number,
    options: { header?: boolean; bold?: boolean } = {},
  ) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 90, right: 100, bottom: 90, left: 100 },
      borders,
      shading: options.header
        ? { fill: NAVY, type: ShadingType.CLEAR }
        : undefined,
      children: [
        new Paragraph({
          spacing: { after: 0 },
          children: (value || "—").split("\n").map(
            (line, index) => new TextRun({
              text: line,
              break: index === 0 ? undefined : 1,
              bold: options.header || options.bold,
              color: options.header ? "FFFFFF" : undefined,
              font: FONT,
              size: options.header ? 19 : 18,
            }),
          ),
        }),
      ],
    });

  const sectionHeading = (text: string) =>
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 320, after: 150 },
      children: [new TextRun({ text, font: FONT, color: BLUE, bold: true })],
    });

  const body = (text: string, boldLead?: string) =>
    new Paragraph({
      spacing: { after: 120, line: 276 },
      children: boldLead
        ? [
            new TextRun({ text: boldLead, bold: true, font: FONT }),
            new TextRun({ text, font: FONT }),
          ]
        : [new TextRun({ text, font: FONT })],
    });

  const subheading = (text: string) =>
    new Paragraph({
      keepNext: true,
      spacing: { before: 150, after: 80 },
      children: [
        new TextRun({ text, font: FONT, color: NAVY, bold: true, size: 21 }),
      ],
    });

  const eventTable = (
    events: LeadershipReport["events"],
    includeSource: boolean,
  ) =>
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      rows: [
        new TableRow({
          tableHeader: true,
          children: includeSource
            ? [
                cell("日期", 1200, { header: true }),
                cell("所属事项", 1800, { header: true }),
                cell("事件", 2200, { header: true }),
                cell("摘要", 4160, { header: true }),
              ]
            : [
                cell("日期", 1400, { header: true }),
                cell("事件", 2600, { header: true }),
                cell("摘要", 5360, { header: true }),
              ],
        }),
        ...events.map(
          (event) =>
            new TableRow({
              cantSplit: true,
              children: includeSource
                ? [
                    cell(event.date, 1200),
                    cell(event.source, 1800, { bold: true }),
                    cell(event.title, 2200),
                    cell(event.summary, 4160),
                  ]
                : [
                    cell(event.date, 1400),
                    cell(event.title, 2600),
                    cell(event.summary, 5360),
                  ],
            }),
        ),
      ],
    });

  const summaryTable = report.isInvestmentOnly
    ? new Table({
        width: { size: 9360, type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        rows: [
          new TableRow({
            tableHeader: true,
            children: [
              cell("投资人 / 机构", 2200, { header: true }),
              cell("阶段 / 跟进", 1500, { header: true }),
              cell("意向金额", 1260, { header: true }),
              cell("最新进展", 3100, { header: true }),
              cell("负责人", 1300, { header: true }),
            ],
          }),
          ...report.items.map(
            (item) =>
              new TableRow({
                cantSplit: true,
                children: [
                  cell(item.counterparties || item.name, 2200, { bold: true }),
                  cell(`${item.stageLabel}\n${reportItemFollowUpLabel(item)}`, 1500),
                  cell(formatCny(item.targetInvestmentAmountCny), 1260),
                  cell(`${item.latestDate} ${item.latestTitle}`, 3100),
                  cell(item.owner, 1300),
                ],
              }),
          ),
        ],
      })
    : new Table({
        width: { size: 9360, type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        rows: [
          new TableRow({
            tableHeader: true,
            children: [
              cell("事项 / 对接方", 2300, { header: true }),
              cell("类型 / 阶段", 1500, { header: true }),
              cell("跟进", 1300, { header: true }),
              cell("最新进展", 2960, { header: true }),
              cell("负责人", 1300, { header: true }),
            ],
          }),
          ...report.items.map(
            (item) =>
              new TableRow({
                cantSplit: true,
                children: [
                  cell(`${item.name}\n${item.counterparties}`, 2300, { bold: true }),
                  cell(`${item.typeLabel}\n${item.stageLabel}`, 1500),
                  cell(`${item.priorityLabel}\n${reportItemFollowUpLabel(item)}`, 1300),
                  cell(`${item.latestDate} ${item.latestTitle}`, 2960),
                  cell(item.owner, 1300),
                ],
              }),
          ),
        ],
      });

  const companyEvents = report.events.filter((event) => event.source === "公司事件");
  const projectDetails = report.items.length > 0
    ? report.items.flatMap((item) => {
        const itemEvents = report.events.filter((event) => event.source === item.name);
        return [
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            keepNext: true,
            spacing: { before: 230, after: 100 },
            children: [
              new TextRun({ text: item.name, font: FONT, color: NAVY, bold: true }),
            ],
          }),
          body(`${item.counterparties || "—"}`, "对接方："),
          body(
            reportItemStatusLabel(item),
            "当前状态：",
          ),
          body(
            `${item.latestDate} ${item.latestTitle}。${item.latestSummary}`,
            "最新进展：",
          ),
          body(item.nextAction, "下一步："),
          body(item.summary),
          ...(report.eventOrganization === "grouped"
            ? [
                subheading("关键事件"),
                ...(itemEvents.length > 0
                  ? [eventTable(itemEvents, false)]
                  : [body("暂无关键事件。")]),
              ]
            : []),
        ];
      })
    : [body("当前范围内暂无事项。")];

  const children = [
    new Paragraph({
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 14, color: BLUE },
      },
      spacing: { after: 180 },
      children: [
        new TextRun({
          text: report.workspaceName,
          color: BLUE,
          bold: true,
          font: FONT,
          size: 20,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 90 },
      children: [
        new TextRun({
          text: report.title,
          bold: true,
          color: NAVY,
          font: FONT,
          size: 44,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 260 },
      children: [
        new TextRun({
          text: `数据更新至 ${report.dataDate}  ·  导出范围：${report.scopeLabel}`,
          color: TEXT_GRAY,
          font: FONT,
          size: 19,
        }),
      ],
    }),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      rows: [
        new TableRow({
          children: [
            cell(`事项总数\n${report.stats.total}`, 1560, { bold: true }),
            cell(`合作项目\n${report.stats.cooperation}`, 1560, { bold: true }),
            cell(`投资人对接\n${report.stats.investment}`, 1560, { bold: true }),
            cell(`资源对接\n${report.stats.resource}`, 1560, { bold: true }),
            cell(`高优先级\n${report.stats.highPriority}`, 1560, { bold: true }),
            cell(`可主动跟进\n${report.stats.proactiveContact}`, 1560, { bold: true }),
          ],
        }),
      ],
    }),
    sectionHeading(report.isInvestmentOnly ? "投资人对接表" : report.isResourceOnly ? "资源对接表" : "事项总览"),
    summaryTable,
    sectionHeading(report.eventOrganization === "grouped" ? "分事项进展" : "重点事项"),
    ...projectDetails,
    ...(report.eventOrganization === "grouped"
      ? companyEvents.length > 0
        ? [sectionHeading("公司事件"), eventTable(companyEvents, false)]
        : []
      : [
          sectionHeading("核心事件时间线"),
          ...(report.events.length > 0
            ? [eventTable(report.events, true)]
            : [body("当前范围内暂无关键事件。")]),
        ]),
  ];

  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 21, color: "26384A" },
          paragraph: { spacing: { after: 120, line: 276 } },
        },
      },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: 30, bold: true, color: BLUE },
          paragraph: { spacing: { before: 320, after: 150 }, keepNext: true },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: 25, bold: true, color: NAVY },
          paragraph: { spacing: { before: 230, after: 100 }, keepNext: true },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: `${report.workspaceName}  ·  `, color: TEXT_GRAY, font: FONT, size: 17 }),
                  new TextRun({ children: [PageNumber.CURRENT], color: TEXT_GRAY, font: FONT, size: 17 }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBlob(document);
}
