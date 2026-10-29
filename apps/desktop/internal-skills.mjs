import { createHash } from 'node:crypto';
import { readSkillMetadata, skillPackage } from '@cpclaw/contracts';

const hash = (text) => createHash('sha256').update(text).digest('hex');

/** 随桌面/内核维护的内部技能；不经云端安装，不计入「我的技能」。 */
const specs = [
  {
    slug: 'local-clarify',
    title: '澄清任务与材料',
    description: '在动手前把目标、材料和限制问清楚，避免凭空编造。',
    category: '资料整理',
    tags: ['澄清', '提问', '材料'],
    sections: ['已确认目标', '可用材料', '待确认事项'],
    body: [
      '# 澄清任务与材料',
      '',
      '先确认本次要交付什么，再核对用户已明确提供或选定的材料；缺少事实时提问，不编造。',
      '',
      '## 工作步骤',
      '1. 复述目标、输出形式和截止条件。',
      '2. 列出已有材料与权限边界；未选定的资料不擅自读取。',
      '3. 列出阻碍完成的待确认项，优先问可回答的问题。',
      '4. 按章节输出；沿用当前对话权限，不授予新权限。',
    ].join('\n'),
  },
  {
    slug: 'local-outcome-check',
    title: '核对产物与回执',
    description: '区分模型声称完成、结构检查通过和真实文件/服务终态。',
    category: '资料整理',
    tags: ['验收', '回执', '产物'],
    sections: ['声称结果', '实际证据', '未完成项'],
    body: [
      '# 核对产物与回执',
      '',
      '把模型回复、结构检查和实际产物/服务回执分开核对；没有证据的完成声明不能记为已交付。',
      '',
      '## 工作步骤',
      '1. 摘录模型声称完成的部分。',
      '2. 对照文件、应用回执或明确材料，标注已证实项。',
      '3. 列出仍缺证据或需重试的项；Mock 结果明确标注。',
      '4. 沿用当前对话权限，不重复索取仍有效的授权。',
    ].join('\n'),
  },
];

function buildItem(spec) {
  const meta = readSkillMetadata({
    category: spec.category,
    tags: spec.tags,
    applicability: '适用于本机已登录的桌面端；随当前应用内核提供。',
    limitations: '不替代云端审核发布的组织技能；不自动访问未选定材料。',
    outputType: 'Markdown',
    inputs: [
      { name: 'goal', label: '本次目标', required: true, example: spec.description },
      { name: 'materials', label: '已有材料或说明', required: false, example: '可选：粘贴要点或说明项目材料' },
    ],
    examples: [
      {
        title: '合成示例（内部方法说明）',
        input: spec.description,
        output: `## ${spec.sections[0]}\n示例确认项。\n## ${spec.sections[1]}\n示例证据。\n## ${spec.sections[2]}\n示例待办。`,
      },
    ],
    sections: spec.sections,
    changelog: '随内核维护；版本与桌面发布同步。',
    platforms: ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'],
  });
  const id = 'kernel:' + spec.slug;
  const item = {
    ...meta,
    id,
    skillId: id,
    owner: 'kernel',
    kind: 'skill',
    title: spec.title,
    description: spec.description,
    body: spec.body,
    version: '1.0.0',
    source: 'internal',
    origin: 'cpclaw:kernel:' + spec.slug,
    members: [],
    status: 'published',
    note: '',
    updated: 0,
    revision: 1,
    personalAvailable: false,
    featured: 0,
    internal: true,
  };
  item.digest = hash(skillPackage(item));
  return item;
}

const catalog = specs.map(buildItem);

export function listInternalSkills({ q = '', category = '', sort = 'recommended' } = {}) {
  let found = [...catalog];
  const query = String(q).toLowerCase().trim();
  if (query) {
    found = found.filter((x) =>
      [x.title, x.description, x.category, x.applicability, ...x.tags].join(' ').toLowerCase().includes(query),
    );
  }
  if (category) found = found.filter((x) => x.category === category);
  found.sort((a, b) =>
    sort === 'name'
      ? a.title.localeCompare(b.title, 'zh-CN')
      : sort === 'updated'
        ? b.updated - a.updated
        : a.title.localeCompare(b.title, 'zh-CN'),
  );
  return found;
}

export function getInternalSkill(id) {
  return catalog.find((x) => x.id === id) ?? null;
}

export function isInternalSkillId(id) {
  return typeof id === 'string' && id.startsWith('kernel:');
}
