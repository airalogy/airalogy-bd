import type { Project } from "./types";

export function projectOwnerLabel(owner?: string | null): string {
  const name = owner?.trim();
  return !name || name === "待确认" ? "未分配" : name;
}

export const stageLabels: Record<string, string> = {
  initial_contact: "初步接触",
  opportunity_assessment: "机会评估",
  solution_discussion: "方案讨论",
  agreement_negotiation: "协议磋商",
  signed: "已签约",
  execution: "执行中",
  paused: "暂停",
  terminated: "终止",
};

export const priorityLabels: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export const followUpStatusLabels: Record<Project["follow_up_status"], string> = {
  active_progress: "持续推进",
  proactive_contact: "可主动跟进",
  awaiting_response: "等待对方",
  on_hold: "暂缓联系",
  closed: "本轮已结束",
};

export const relationshipLabels: Record<string, string> = {
  active: "关系活跃",
  dormant: "关系沉寂",
  maintained: "长期维护",
};

export function projectRelationshipLabel(project: Pick<Project, "relationship">) {
  if (project.relationship === "active") return null;
  return relationshipLabels[project.relationship] ?? project.relationship;
}

export const recordTypeLabels: Record<Project["record_type"], string> = {
  cooperation: "合作项目",
  investment: "投资人对接",
  resource: "资源对接",
};

export const roleLabels: Record<string, string> = {
  decision_maker: "决策人",
  project_lead: "项目负责人",
  project_owner: "项目统筹",
  business_contact: "商务联系人",
  government_contact: "政府联系人",
  investor_contact: "投融资联系人",
  introducer: "引荐人",
  initial_contact: "初始联系人",
  senior_contact: "高层联系人",
  technical_lead: "技术负责人",
  management_representative: "管理代表",
  product_planning: "产品规划",
  data_process: "数据与流程",
  market_insight: "市场洞察",
  drug_development: "药物开发",
  research_support: "研发支持",
  financial_advisor: "财务顾问",
  fundraising_presenter: "融资主讲人",
  investment_evaluation: "投资评估",
  legal_representative: "法定代表人",
  general_manager: "经理",
  financial_officer: "财务负责人",
  board_chair: "董事长",
  director: "董事",
  supervisor: "监事",
  participant: "项目参与",
};
